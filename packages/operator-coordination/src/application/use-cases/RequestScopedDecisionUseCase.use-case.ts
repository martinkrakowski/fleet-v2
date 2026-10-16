/**
 * RequestScopedDecisionUseCase implements RequestScopedDecisionPort. It records
 * the exact proposal, expected commit, action scope and approved policy
 * revision before its authorized decider is ever asked.
 *
 * Recording precedes the ask: the request is persisted in `awaiting-decision`
 * first, so an unrecorded proposal can never reach a decider. Only when a
 * decision transport is supplied is the recorded state refreshed from a
 * verified answer, and a transport that reports no verified answer leaves the
 * request awaiting rather than upgrading it to approval.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import { CoordinationKind } from '../../domain/value-objects/CoordinationKind.vo.js';
import type {
  RequestScopedDecisionPort,
  RequestScopedDecisionRequest,
  RequestScopedDecisionResult,
} from '../ports/in/RequestScopedDecisionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { DecisionAnswer, DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';

export interface RequestScopedDecisionDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly decisionTransport?: DecisionTransportPort;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
    const kind = CoordinationKind.create(request.kind);
    if (!kind.success || kind.value === undefined) {
      return {
        outcome: 'rejected',
        reason: `a decision request requires a recorded kind: ${String(request.kind)}`,
      };
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    const recorded: CoordinationRequestRecord = CoordinationRequest.fromRecord({
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
    }).toRecord();
    // The proposal is durable before any decider is asked.
    await this.deps.requestRepo.saveRequest(recorded);
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
    await this.deps.requestRepo.saveRequest(decided);
    return { outcome: 'requested', request: decided };
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
