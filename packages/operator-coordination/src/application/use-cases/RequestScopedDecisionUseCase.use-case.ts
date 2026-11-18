/**
 * RequestScopedDecisionUseCase implements RequestScopedDecisionPort. It records
 * the exact proposal, expected commit, action scope and approved policy
 * revision before its authorized decider is ever asked.
 *
 * Recording precedes the ask: the request is persisted in `awaiting-decision`
 * first, so an unrecorded proposal can never reach a decider. Only when a
 * decision transport is supplied is the recorded state refreshed from a
 * verified answer, and a transport that reports no verified answer leaves the
 * request awaiting rather than upgrading it to approval. A write the store
 * refuses as a lost revision race — a duplicate recorded by another writer
 * between the lookup and the save — is reported as `rejected`; no other store
 * failure is swallowed.
 */

import { GRANT_RECORD_VERSION } from '../../domain/coordination-records.js';
import type { CoordinationRequestRecord, ShadowImportGrantRecord } from '../../domain/coordination-records.js';
import {
  RELEASE_GRANT_DIGEST_PREFIX,
  SHADOW_IMPORT_ACTION_SCOPE,
  SHADOW_IMPORT_DIGEST_PREFIX,
  SHADOW_IMPORT_GRANT_MAX_TTL_DAYS,
  isReleaseActionScope,
  isShadowImportActionScope,
  parseShadowImportGrant,
  releaseGrantDigestPayload,
  shadowImportDigestPayload,
} from '../../domain/coordination-records.js';
import { CoordinationRequest, CONTROL_CHARACTER } from '../../domain/entities/CoordinationRequest.js';
import { readPlainObjectLoose, readPlainObjectWithOptional } from '../../domain/record-input.js';
import { CoordinationKind } from '../../domain/value-objects/CoordinationKind.vo.js';
import { readReleaseNonce, readReleaseRoot } from '../../domain/coordination-records.js';
import type {
  RevokeOwnerGrantRequest,
  RevokeOwnerGrantResult,
  RequestScopedDecisionPort,
  RequestScopedDecisionRequest,
  RequestScopedDecisionResult,
} from '../ports/in/RequestScopedDecisionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { CoordinationRequestRevisionConflictError } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { DecisionAnswer, DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';

export interface RequestScopedDecisionDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly decisionTransport?: DecisionTransportPort;
  /**
   * The SHA-256 digest the shadow import request id is bound by. Injected, so
   * the application layer stays free of `node:crypto`; a shadow import
   * request without it is a typed rejection, never a silent skip.
   */
  readonly computeDigest?: (payload: string) => string;
  /**
   * The trusted clock the shadow import grant's expiry and TTL are measured
   * against and its `createdAtIso` is recorded from. Injected by the
   * composition root, never taken from the request: a shadow import request
   * without it is a typed rejection, so a requester-supplied `nowIso` of
   * 2099 can never mint a 73-year grant. Ordinary (non-shadow) decisions
   * keep exactly their main behaviour and never consult this clock.
   */
  readonly shadowImportClock?: { readonly nowIso: () => string };
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// CO24f: the same control and bidi screen the CoordinationRequest entity
// applies to a recorded attempt (C0, DEL/C1, U+061C, U+200E/F, U+2028/9,
// U+202A–E, U+2066–9 and U+FEFF). A value carrying any of them is refused
// here, typed, so it can never reach the record builder and make it throw.
// The screen is imported from the entity so the two cannot drift.
const ATTEMPT_CONTROL_CHARACTER = CONTROL_CHARACTER;

// The record builder refuses an attempt longer than this; screen it here so an
// over-long value is a typed rejection, never a throw from the record builder.
const MAX_GRANT_ATTEMPT_ID_LENGTH = 256;

const FORGE_SCOPE_PREFIX = 'forge:';

type ShadowImportGrantEvaluation =
  | { readonly ok: true; readonly grant: ShadowImportGrantRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Every standing shadow import grant check (owner decision 2026-11-18),
 * extracted from `execute` to keep it readable. The grant must be head-free,
 * its expiry strictly in the future and within the TTL cap from now, and its
 * request id must carry the digest of its exact coordinates
 * ({ scope, owner, repo, expiresAtIso }). Pure: nothing is recorded here.
 */
function evaluateShadowImportGrant(
  request: RequestScopedDecisionRequest,
  nowIso: string,
  computeDigest: ((payload: string) => string) | undefined,
): ShadowImportGrantEvaluation {
  if (request.expectedHeadSha !== null) {
    return { ok: false, reason: 'shadow-import-expected-head-not-null' };
  }
  const parsedGrant = parseShadowImportGrant(request.shadowImportGrant);
  if (!parsedGrant.ok) {
    return { ok: false, reason: parsedGrant.code };
  }
  const expiresMs = Date.parse(parsedGrant.value.expiresAtIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    return { ok: false, reason: 'shadow-import-grant-expired' };
  }
  if (expiresMs - nowMs > SHADOW_IMPORT_GRANT_MAX_TTL_DAYS * 86_400_000) {
    return { ok: false, reason: 'shadow-import-grant-ttl-exceeded' };
  }
  if (computeDigest === undefined) {
    return { ok: false, reason: 'shadow-import-digest-unavailable' };
  }
  const payloadResult = shadowImportDigestPayload(parsedGrant.value);
  if (!payloadResult.ok) {
    return { ok: false, reason: payloadResult.code };
  }
  const expectedRequestId = `${SHADOW_IMPORT_DIGEST_PREFIX}${computeDigest(payloadResult.value)}`;
  if (request.requestId.trim() !== expectedRequestId) {
    return { ok: false, reason: 'shadow-import-request-digest-mismatch' };
  }
  return { ok: true, grant: parsedGrant.value };
}

export class RequestScopedDecisionUseCase implements RequestScopedDecisionPort {
  constructor(private readonly deps?: RequestScopedDecisionDependencies) {}

  async requestScopedDecision(
    request: RequestScopedDecisionRequest,
  ): Promise<RequestScopedDecisionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RequestScopedDecisionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RequestScopedDecisionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is rejected by the field validation below.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: RequestScopedDecisionUseCase');
    }
    // The request is snapshotted once by the domain's shared own-data-descriptor
    // reader before any field is read, so a throwing getter (an accessor whose
    // value collapses to `undefined`) or a Proxy trap can only produce a typed
    // refusal — and no field is ever read off the original afterwards. The
    // loose reader ignores unknown keys: an ordinary decision carrying an
    // unknown body key behaves exactly as on main, where it was never a
    // rejection and never produced a misleading field message.
    // A Proxy's `getPrototypeOf`, `ownKeys` and `getOwnPropertyDescriptor`
    // traps can throw while the snapshot is taken. Any such throw is a hostile
    // body, mapped to the typed `invalid-request` refusal — never an exception
    // out of `execute`. Ordinary inputs snapshot exactly as before.
    let snapshot: Record<string, unknown> | null;
    try {
      snapshot = readPlainObjectLoose(input);
    } catch {
      return { outcome: 'rejected', reason: 'invalid-request' };
    }
    if (snapshot === null) {
      return { outcome: 'rejected', reason: 'a decision request requires a non-empty requestId' };
    }
    // The reader copies `descriptor.value`, which is `undefined` for an
    // accessor — the same value an explicitly-omitted optional field carries
    // (`{ nowIso: undefined }`, as the CLI and HTTP boundaries send it). The
    // two are told apart here, at snapshot time, by inspecting the own
    // descriptors: descriptor inspection never runs a getter or a Proxy `get`
    // trap, and no property of the input is read after the snapshot.
    const releaseRootDescriptor = Object.getOwnPropertyDescriptor(input, 'releaseRoot');
    const releaseRootIsAccessor =
      releaseRootDescriptor !== undefined && releaseRootDescriptor.get !== undefined;
    const request = snapshot as unknown as RequestScopedDecisionRequest;
    for (const field of ['requestId', 'projectId', 'actionScope', 'proposalDigest', 'policyRevision'] as const) {
      if (!isFilled(request[field])) {
        return { outcome: 'rejected', reason: `a decision request requires a non-empty ${field}` };
      }
    }
    if (request.expectedHeadSha !== null && !isFilled(request.expectedHeadSha)) {
      return {
        outcome: 'rejected',
        reason: 'a decision request requires an expectedHeadSha string or null',
      };
    }
    if (request.attemptId !== undefined && !isFilled(request.attemptId)) {
      return { outcome: 'rejected', reason: 'a decision request attemptId must be a non-empty string when given' };
    }
    if (request.attemptId !== undefined && ATTEMPT_CONTROL_CHARACTER.test(request.attemptId)) {
      return {
        outcome: 'rejected',
        reason: 'a decision request attemptId must not contain control or bidi characters',
      };
    }
    if (
      request.attemptId !== undefined &&
      request.attemptId.trim().length > MAX_GRANT_ATTEMPT_ID_LENGTH
    ) {
      return {
        outcome: 'rejected',
        reason: 'a decision request attemptId must be at most 256 characters',
      };
    }
    // CO14 follow-up: a release decision may bind its grant to the release
    // root it names. A non-path-shaped, oversized or hostile root is a typed
    // rejection, never a record that matches every root.
    // A present-but-unreadable `releaseRoot` (an accessor) fails closed as
    // invalid, like every other malformed root; an explicit `undefined` data
    // value is an omitted optional field, so it stays absent (as on main).
    // RR1: the two directions are now scope-symmetric and fail closed both
    // ways. A release scope REQUIRES a valid root, and any non-release scope
    // (ordinary or accessor) carrying one — or an accessor on any scope — is
    // refused, so a root can never be smuggled past its digest binding.
    const releaseRoot = releaseRootIsAccessor
      ? ({ state: 'invalid' } as const)
      : readReleaseRoot(request);
    const isReleaseScope = isReleaseActionScope(request.actionScope.trim());
    if (isReleaseScope) {
      if (releaseRoot.state !== 'valid') {
        return {
          outcome: 'rejected',
          reason:
            releaseRoot.state === 'invalid'
              ? 'a decision request releaseRoot must be a bounded absolute path without ".." when given'
              : 'release-root-required',
        };
      }
    } else if (releaseRootIsAccessor || releaseRoot.state !== 'absent') {
      return { outcome: 'rejected', reason: 'release-root-forbidden-for-scope' };
    }
    // The plain root value when one is present (only a release scope reaches
    // the digest below with one): TypeScript cannot carry the scope-correlated
    // narrowing across the two blocks, so the value is read once, here.
    const releaseRootValue = releaseRoot.state === 'valid' ? releaseRoot.value : undefined;
    const kind = CoordinationKind.create(request.kind);
    if (!kind.success || kind.value === undefined) {
      return {
        outcome: 'rejected',
        reason: `a decision request requires a recorded kind: ${String(request.kind)}`,
      };
    }
    // CO24f: a forge action decision must name the attempt it authorizes; the
    // coordinate-less path is no longer requester-selectable. A merge grant is
    // attempt-less by design (DT6b) and never passes through this use case, so
    // every `forge:` action decision recorded here carries an attempt.
    if (
      kind.value.getValue() === 'action-decision' &&
      request.actionScope.trim().startsWith(FORGE_SCOPE_PREFIX) &&
      request.attemptId === undefined
    ) {
      return {
        outcome: 'rejected',
        reason: 'a forge action decision requires an attemptId',
      };
    }
    // Standing shadow import grant (owner decision 2026-11-18): the unattended
    // timer's grant is head-free, bounded by a future expiry within the TTL
    // cap, and bound to its request id by a digest of its exact coordinates
    // ({ scope, owner, repo, expiresAtIso }). Every failure here is a typed
    // rejection before anything is recorded.
    // The grant's moment is the composition root's trusted clock alone: for
    // this scope the request-supplied `nowIso` is ignored, and `createdAtIso`
    // is recorded from the same clock. The composition root supplies the
    // clock — the authority that caps the grant's lifetime depends on it
    // here — so a shadow request without the injected clock is a typed
    // rejection, never a grant measured against the requester's own clock.
    // GR1a2: the digest and expiry are re-checked on resolve against the real
    // clock; recording-time checks alone do not establish the guarantee.
    const isShadowScope = isShadowImportActionScope(request.actionScope.trim());
    let nowIso: string;
    if (isShadowScope) {
      if (this.deps.shadowImportClock === undefined) {
        return { outcome: 'rejected', reason: 'shadow-import-clock-unavailable' };
      }
      nowIso = this.deps.shadowImportClock.nowIso();
    } else {
      nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    }
    let shadowImportGrant: ShadowImportGrantRecord | undefined;
    if (isShadowScope) {
      const grantEvaluation = evaluateShadowImportGrant(request, nowIso, this.deps.computeDigest);
      if (!grantEvaluation.ok) {
        return { outcome: 'rejected', reason: grantEvaluation.reason };
      }
      shadowImportGrant = grantEvaluation.grant;
    }
    // RR1: a release grant is bound to its root by the request id itself. The
    // owner's Ed25519 decision signature covers `{ requestId, ... }` but not
    // `releaseRoot`, so the root is covered only when the request id carries
    // the digest of the exact coordinates it names. Every failure here is a
    // typed rejection before anything is recorded, mirroring the shadow
    // import grant's binding (GR1a1).
    if (isReleaseScope) {
      if (request.expectedHeadSha === null || !isFilled(request.expectedHeadSha)) {
        return { outcome: 'rejected', reason: 'release-expected-head-required' };
      }
      if (this.deps.computeDigest === undefined) {
        return { outcome: 'rejected', reason: 'release-grant-digest-unavailable' };
      }
      const payloadResult = releaseGrantDigestPayload({
        actionScope: request.actionScope.trim(),
        projectId: request.projectId.trim(),
        expectedHeadSha: request.expectedHeadSha.trim(),
        releaseRoot: releaseRootValue,
        nonce: readReleaseNonce(request),
      });
      if (!payloadResult.ok) {
        return { outcome: 'rejected', reason: payloadResult.code };
      }
      const expectedRequestId = `${RELEASE_GRANT_DIGEST_PREFIX}${this.deps.computeDigest(payloadResult.value)}`;
      if (request.requestId.trim() !== expectedRequestId) {
        return { outcome: 'rejected', reason: 'release-grant-request-digest-mismatch' };
      }
    }
    const existing = await this.deps.requestRepo.findRequestById(request.requestId.trim());
    if (existing !== null) {
      return {
        outcome: 'rejected',
        reason: `a coordination request with id ${request.requestId.trim()} is already recorded`,
      };
    }
    // The proposal is durable before any decider is asked. A duplicate that
    // raced past the lookup above is refused by the store's revision check and
    // surfaces as a typed rejection, not as an adapter error.
    const proposal: CoordinationRequestRecord = CoordinationRequest.fromRecord({
      id: request.requestId.trim(),
      projectId: request.projectId.trim(),
      kind: kind.value.getValue(),
      state: 'awaiting-decision',
      actionScope: request.actionScope.trim(),
      expectedHeadSha: request.expectedHeadSha === null ? null : request.expectedHeadSha.trim(),
      proposalDigest: request.proposalDigest.trim(),
      policyRevision: request.policyRevision.trim(),
      decisionRevision: null,
      grantId: null,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 0,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      ...(request.attemptId !== undefined
        ? { grantRecordVersion: GRANT_RECORD_VERSION, grantAttemptId: request.attemptId.trim() }
        : {}),
      ...(releaseRoot.state === 'valid' ? { releaseRoot: releaseRoot.value } : {}),
      ...(isReleaseScope && readReleaseNonce(request) !== undefined
        ? { releaseNonce: readReleaseNonce(request) }
        : {}),
      ...(shadowImportGrant !== undefined ? { shadowImportGrant } : {}),
    }).toRecord();
    // The proposal is durable before any decider is asked. A duplicate that
    // raced past the lookup above is refused by the store's revision check and
    // surfaces as a typed rejection, not as an adapter error.
    const recorded = await this.recordOrReject(this.deps.requestRepo, proposal);
    if (recorded === undefined) {
      return {
        outcome: 'rejected',
        reason: `a coordination request with id ${request.requestId.trim()} lost a revision race; another writer recorded it first`,
      };
    }
    const answer = await this.readVerifiedAnswer(recorded);
    if (answer === undefined || answer.state === 'awaiting-decision') {
      return { outcome: 'requested', request: recorded };
    }
    if (answer.state === 'approved' && answer.grantId === null) {
      // An approval without a recorded grant cannot authorize anything.
      return { outcome: 'requested', request: recorded };
    }
    const decided: CoordinationRequestRecord = {
      ...recorded,
      state: answer.state,
      decisionRevision: answer.decisionRevision,
      grantId: answer.grantId,
      revision: recorded.revision + 1,
      // A shadow request's moment is the trusted clock's, never the
      // request-supplied one; ordinary decisions keep main's behaviour.
      updatedAtIso: isShadowScope
        ? nowIso
        : isFilled(request.nowIso)
          ? request.nowIso
          : new Date().toISOString(),
    };
    const persisted = await this.recordOrReject(this.deps.requestRepo, decided);
    if (persisted === undefined) {
      return {
        outcome: 'rejected',
        reason: `coordination request ${recorded.id} lost a revision race while recording its decision; another writer moved it first`,
      };
    }
    return { outcome: 'requested', request: persisted };
  }

  /**
   * Record one revision. A store that refuses the write as a lost race returns
   * undefined so the caller reports a typed `rejected`; every other failure is
   * the store's own error and is left to propagate.
   */
  private async recordOrReject(
    requestRepo: CoordinationRequestRepositoryPort,
    record: CoordinationRequestRecord,
  ): Promise<CoordinationRequestRecord | undefined> {
    try {
      await requestRepo.saveRequest(record);
      return record;
    } catch (error: unknown) {
      if (error instanceof CoordinationRequestRevisionConflictError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Absence and ambiguity stay awaiting; nothing is invented here. */
  private async readVerifiedAnswer(record: CoordinationRequestRecord): Promise<DecisionAnswer | undefined> {
    if (this.deps?.decisionTransport === undefined) {
      return undefined;
    }
    const answer = await this.deps.decisionTransport.readDecisionAnswer({
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
    });
    if (
      answer.state !== 'approved' &&
      answer.state !== 'declined' &&
      answer.state !== 'awaiting-decision'
    ) {
      return undefined;
    }
    return answer;
  }

  /**
   * Revoke one standing `merge:import-shadow` owner grant by its id. The
   * grant id is a non-secret handle and is the only value echoed back;
   * refusals never print secret-shaped values. Only the standing shadow
   * import grant is revocable here: a missing grant, a grant of another
   * scope, one already revoked, or one in another terminal state is a typed
   * refusal, and a revision race is reported as `revision-conflict`.
   *
   * Re-request rule: a revoked or declined grant blocks identical
   * coordinates — the request id is the digest of the grant's exact
   * coordinates ({ scope, owner, repo, expiresAtIso }), so re-recording them
   * is refused as an already-recorded request. To issue a fresh grant the
   * owner records a request with a different coordinate, for example a
   * different `expiresAtIso`, which yields a different digest and a new
   * request id.
   */
  async revokeOwnerGrant(request: RevokeOwnerGrantRequest): Promise<RevokeOwnerGrantResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RequestScopedDecisionUseCase');
    }
    // Hostile input: the request is snapshotted by the domain's shared
    // plain-record reader (own data descriptors only, no getter is ever run)
    // before any field is read, so a throwing getter on `grantId` or `nowIso`
    // yields a typed refusal instead of an exception.
    const snapshot = readPlainObjectWithOptional(request, ['grantId'], ['grantId', 'nowIso']);
    if (snapshot === null) {
      return { outcome: 'refused', reason: 'grant-missing' };
    }
    const grantId = typeof snapshot.grantId === 'string' ? snapshot.grantId.trim() : '';
    if (grantId.length === 0) {
      return { outcome: 'refused', reason: 'grant-missing' };
    }
    const recorded = await this.deps.requestRepo.findRequestByGrantId(grantId);
    if (recorded === null) {
      return { outcome: 'refused', reason: 'grant-missing' };
    }
    if (recorded.actionScope !== SHADOW_IMPORT_ACTION_SCOPE) {
      return { outcome: 'refused', reason: 'grant-wrong-scope' };
    }
    if (recorded.state === 'cancelled') {
      return { outcome: 'refused', reason: 'grant-already-revoked' };
    }
    if (recorded.state === 'declined' || recorded.state === 'expired' || recorded.state === 'completed') {
      return { outcome: 'refused', reason: 'grant-not-revocable' };
    }
    // The revoke moment is the composition root's trusted clock alone, the
    // same injected clock round 5 added for the shadow scope: any
    // request-supplied `nowIso` is ignored, so a requester can never stamp a
    // chosen (for example far-future) `updatedAtIso` onto the record. A
    // runtime without the injected clock refuses, typed, rather than falling
    // back to the requester's value or an ad-hoc clock here.
    if (this.deps.shadowImportClock === undefined) {
      return { outcome: 'refused', reason: 'shadow-import-clock-unavailable' };
    }
    const nowIso = this.deps.shadowImportClock.nowIso();
    try {
      await this.deps.requestRepo.saveRequest({
        ...recorded,
        state: 'cancelled',
        revision: recorded.revision + 1,
        updatedAtIso: nowIso,
      });
      return { outcome: 'revoked', grantId };
    } catch (error: unknown) {
      if (error instanceof CoordinationRequestRevisionConflictError) {
        return { outcome: 'refused', reason: 'revision-conflict' };
      }
      throw error;
    }
  }
}
