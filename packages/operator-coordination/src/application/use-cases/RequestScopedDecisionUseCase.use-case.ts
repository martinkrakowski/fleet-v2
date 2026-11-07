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
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import { CoordinationKind } from '../../domain/value-objects/CoordinationKind.vo.js';
import type {
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
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// CO24f: the same control and bidi screen the CoordinationRequest entity
// applies to a recorded attempt (C0, DEL/C1, U+061C, U+200E/F, U+2028/9,
// U+202A–E, U+2066–9 and U+FEFF). A value carrying any of them is refused
// here, typed, so it can never reach the record builder and make it throw.
const ATTEMPT_CONTROL_CHARACTER =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

// The record builder refuses an attempt longer than this; screen it here so an
// over-long value is a typed rejection, never a throw from the record builder.
const MAX_GRANT_ATTEMPT_ID_LENGTH = 256;

const FORGE_SCOPE_PREFIX = 'forge:';

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
    const request = input as RequestScopedDecisionRequest;
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
    const existing = await this.deps.requestRepo.findRequestById(request.requestId.trim());
    if (existing !== null) {
      return {
        outcome: 'rejected',
        reason: `a coordination request with id ${request.requestId.trim()} is already recorded`,
      };
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
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
      updatedAtIso: isFilled(request.nowIso) ? request.nowIso : new Date().toISOString(),
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
}
