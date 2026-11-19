/**
 * RecordAuthorizationConsumptionUseCase implements RecordAuthorizationConsumptionPort.
 * It durably binds one grant to one action id and attempt and retains the
 * reconciliation receipt on the request it belongs to.
 *
 * A grant authorizes exactly one action, exactly once. A grant that was not
 * recorded, is not approved, no longer matches its expected commit, or was
 * already consumed by another action is refused rather than recorded again,
 * and this port never turns a consumed grant into authority for a second,
 * unrelated action. The same action replayed with its own consumption id is
 * observed idempotently: its recorded receipt is returned unchanged and
 * nothing is recorded twice, so a caller that crashed between its consumption
 * and its own write can replay and complete (CO14 follow-up).
 */

import type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
} from '../../domain/coordination-records.js';
import { AuthorizationConsumption } from '../../domain/entities/AuthorizationConsumption.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import {
  RELEASE_GRANT_DIGEST_PREFIX,
  SHADOW_IMPORT_ACTION_SCOPE,
  isReleaseActionScope,
  readReleaseRoot,
  readReleaseNonce,
  releaseGrantDigestPayload,
  releaseRootsAgree,
} from '../../domain/coordination-records.js';
import type {
  RecordAuthorizationConsumptionPort,
  RecordAuthorizationConsumptionRequest,
  RecordAuthorizationConsumptionResult,
} from '../ports/in/RecordAuthorizationConsumptionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';
import { isSignedDecisionRequired, verifySignedDecisionBinding } from '../../domain/coordination-records.js';

export interface RecordAuthorizationConsumptionDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  /**
   * The SHA-256 digest a release grant's request id is bound by (RR1).
   * Injected, so the application layer stays free of `node:crypto`; a
   * release consumption without it is a typed refusal, never a silent skip.
   */
  readonly computeDigest?: (payload: string) => string;
  /**
   * KEY0c2: when injected, every owner-gated consumption re-reads the signed
   * answer and binds the stored record to it before anything is recorded.
   * Omitted, the origin/main behaviour is kept until KEY0c3 flips the
   * mandatory switch.
   */
  readonly decisionTransport?: DecisionTransportPort;
}

const REQUIRED_TEXT_FIELDS = [
  'consumptionId',
  'grantId',
  'actionId',
  'actionScope',
  'attemptId',
  'expectedHeadSha',
] as const;

function refused(reason: string): RecordAuthorizationConsumptionResult {
  return { outcome: 'refused', reason };
}

/** The refusal for a grant that already authorized an action: the same action, or a second one. */
function alreadyAuthorizedMessage(grantId: string, existingActionId: string, requestedActionId: string): string {
  return existingActionId === requestedActionId
    ? `grant ${grantId} already authorized action ${existingActionId}`
    : `grant ${grantId} already authorized action ${existingActionId} and never a second action`;
}

/** The supplied clock instant when it is non-blank text, else the current instant. */
function consumedAtOf(request: RecordAuthorizationConsumptionRequest): string {
  return typeof request.nowIso === 'string' && request.nowIso.trim().length > 0
    ? request.nowIso
    : new Date().toISOString();
}

export class RecordAuthorizationConsumptionUseCase implements RecordAuthorizationConsumptionPort {
  constructor(private readonly deps?: RecordAuthorizationConsumptionDependencies) {}

  async recordAuthorizationConsumption(
    request: RecordAuthorizationConsumptionRequest,
  ): Promise<RecordAuthorizationConsumptionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RecordAuthorizationConsumptionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordAuthorizationConsumptionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is refused by the field validation below.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: RecordAuthorizationConsumptionUseCase');
    }
    const request = input as RecordAuthorizationConsumptionRequest;
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof request[field] !== 'string' || request[field].trim().length === 0) {
        return refused(`an authorization consumption requires a non-empty ${field}`);
      }
    }
    const grantId = request.grantId.trim();
    const recorded = await this.deps.requestRepo.findRequestByGrantId(grantId);
    if (recorded === null) {
      return refused(`no recorded request holds grant ${grantId}`);
    }
    // A standing shadow import grant (owner decision 2026-11-18) is never
    // consumable: it authorizes the timer's recurring import until it is
    // revoked or expires. Consuming it would set `state: 'completed'` and
    // close the standing grant, so the guard fires before any state write,
    // whichever side names the shadow scope.
    const suppliedScope = request.actionScope.trim();
    if (suppliedScope === SHADOW_IMPORT_ACTION_SCOPE || recorded.actionScope === SHADOW_IMPORT_ACTION_SCOPE) {
      return refused('shadow-import-grant-not-consumable');
    }
    // A malformed stored release root is refused with its own named reason
    // before the aggregate is re-read, so an accessor-carrying or malformed
    // `releaseRoot` keeps origin/main's typed refusal (the full root and
    // digest checks still run below, in their original order).
    if (readReleaseRoot(recorded).state === 'invalid') {
      return refused('release-grant-root-mismatch');
    }
    // KEY0c2: the aggregate is re-read before any replay or exemption check,
    // so a forged `policyGrant` on a `release:*` record (or any other
    // unreadable record) is refused here and can never bypass verification
    // through the replay return or a grant-kind exemption.
    let aggregate: CoordinationRequest;
    try {
      aggregate = CoordinationRequest.fromRecord(recorded);
    } catch {
      return refused('invalid-coordination-request');
    }
    const existing = recorded.consumptions[0];
    if (existing !== undefined) {
      // One grant, one action: a second, unrelated action is never recorded,
      // and the same action is never recorded twice. The same action replayed
      // with its own consumption id is observed idempotently — the durable
      // receipt is returned unchanged — so a caller that crashes between its
      // consumption and its own write can replay and proceed (CO14 follow-up).
      // The replay return sits after every coordinate check, so a moved scope,
      // head or root is refused even when the receipt already exists.
      if (
        existing.actionId !== request.actionId.trim() ||
        existing.consumptionId !== request.consumptionId.trim()
      ) {
        return refused(alreadyAuthorizedMessage(grantId, existing.actionId, request.actionId.trim()));
      }
    } else if (recorded.state !== 'approved') {
      return refused(`grant ${grantId} is ${recorded.state}, which authorizes no action`);
    }
    if (recorded.actionScope !== suppliedScope) {
      return refused(
        `grant ${grantId} was recorded for scope ${recorded.actionScope}, not ${suppliedScope}`,
      );
    }
    if (recorded.expectedHeadSha !== request.expectedHeadSha.trim()) {
      return refused(
        `grant ${grantId} was recorded for commit ${recorded.expectedHeadSha ?? 'none'}, not ${request.expectedHeadSha.trim()}`,
      );
    }
    // CO14 follow-up: a grant bound to one release root is never consumed for
    // another. An invalid coordinate on either side fails closed as a
    // mismatch, never as a match.
    const recordedRoot = readReleaseRoot(recorded);
    const requestedRoot = readReleaseRoot(request);
    if (!releaseRootsAgree(recordedRoot, requestedRoot)) {
      return refused('release-grant-root-mismatch');
    }
    // RR1: a release grant's root is bound into its request id. A record
    // whose id does not carry the prefix carries an unsigned (pre-RR1) root
    // and fails closed; a prefixed record is re-verified against the digest
    // of its recorded coordinates. The check runs before the idempotent
    // replay return below, so a moved root is refused even when the receipt
    // already exists.
    if (isReleaseActionScope(recorded.actionScope)) {
      if (
        recordedRoot.state !== 'valid' ||
        !recorded.id.startsWith(RELEASE_GRANT_DIGEST_PREFIX)
      ) {
        return refused('release-grant-digest-mismatch');
      }
      if (this.deps.computeDigest === undefined) {
        return refused('digest-unavailable');
      }
      const payloadResult = releaseGrantDigestPayload({
        actionScope: recorded.actionScope,
        projectId: recorded.projectId,
        expectedHeadSha: recorded.expectedHeadSha ?? '',
        releaseRoot: recordedRoot.value,
        nonce: readReleaseNonce(recorded),
      });
      const expectedRequestId = payloadResult.ok
        ? `${RELEASE_GRANT_DIGEST_PREFIX}${this.deps.computeDigest(payloadResult.value)}`
        : null;
      if (!payloadResult.ok || recorded.id !== expectedRequestId) {
        return refused('release-grant-digest-mismatch');
      }
    }
    // KEY0c2: when a decision transport is injected, every owner-gated
    // consumption re-reads the signed answer and binds the stored record to
    // it — before the idempotent replay return and before anything is
    // recorded. A forged `policyGrant` on a `release:*` record can never
    // reach this point (the aggregate read above refuses it first), and the
    // closed-kind exemptions skip this check entirely.
    const decisionTransport = this.deps.decisionTransport;
    if (decisionTransport !== undefined && isSignedDecisionRequired(aggregate.toRecord())) {
      const answer = await decisionTransport.readDecisionAnswer({
        requestId: aggregate.getId(),
        projectId: recorded.projectId,
        actionScope: aggregate.getActionScope(),
        expectedHeadSha: aggregate.getExpectedHeadSha(),
      });
      // Fix round: a refusal is honoured in EVERY answer state — an approved
      // answer that carries a refusalReason must still refuse, not consume.
      if (answer.refusalReason !== undefined) {
        return refused(answer.refusalReason);
      }
      if (!verifySignedDecisionBinding(recorded, answer).ok) {
        return refused('decision-signature-invalid');
      }
    }
    // Idempotent replay of the same action: the durable receipt is returned
    // unchanged and nothing is recorded twice, so a release that crashed
    // between its consumption and its own write can complete on the next pass.
    if (existing !== undefined) {
      return { outcome: 'consumed', consumption: existing };
    }
    // A grant that records an attempt, owner or policy, authorizes no other
    // (CO24e). A version-2 record without one authorizes nothing. A legacy grant
    // records no attempt and keeps the composition's own binding (CO24d) until
    // it expires. Both checks run before anything is recorded. A release grant
    // (CO14, CO24g) is attempt-less by design: only the three exact release
    // scopes (`release:install`, `release:swap`, `release:rollback`) are
    // exempt, each anchored by its scope and exact head and consumed once, so
    // the consumption records the deterministic action id as its attempt
    // coordinate; an unknown `release:*` scope is an owner grant and stays
    // under the recorded-attempt check.
    if (!isReleaseActionScope(recorded.actionScope) && aggregate.isMissingRecordedAttempt()) {
      return refused('grant-attempt-unrecorded');
    }
    const boundAttemptId = aggregate.getBoundAttemptId();
    if (boundAttemptId !== null && boundAttemptId !== request.attemptId.trim()) {
      return refused('grant-attempt-mismatch');
    }
    // The composition root supplies the clock; no authority depends on it here.
    const consumedAtIso = consumedAtOf(request);
    const consumption: AuthorizationConsumptionRecord = AuthorizationConsumption.fromRecord({
      consumptionId: request.consumptionId.trim(),
      grantId,
      requestId: aggregate.getId(),
      actionId: request.actionId.trim(),
      attemptId: request.attemptId.trim(),
      expectedHeadSha: request.expectedHeadSha.trim(),
      consumedAtIso,
    }).toRecord();
    const consumed: CoordinationRequestRecord = CoordinationRequest.fromRecord({
      ...recorded,
      consumptions: [consumption],
      state: 'completed',
      revision: aggregate.nextRevision(),
      updatedAtIso: consumedAtIso,
    }).toRecord();
    await this.deps.requestRepo.saveRequest(consumed);
    return { outcome: 'consumed', consumption };
  }
}
