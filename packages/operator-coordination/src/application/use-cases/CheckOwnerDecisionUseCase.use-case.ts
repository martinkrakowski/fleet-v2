/**
 * CheckOwnerDecisionUseCase implements CheckOwnerDecisionPort. It answers one
 * question about one recorded coordination request: does that request, under
 * its own authorization rule, authorize the owner decision it was recorded
 * for at this exact candidate head?
 *
 * The rule is CoordinationRequest.canAuthorizeAction with the scope the
 * request must carry for itself: `owner-decision:<requestId>`. A declined,
 * still-undecided, grantless, revisionless, differently scoped or
 * differently-headed request is `not-approved`; a request this context cannot
 * read is `unknown`. Neither is ever reported as `approved`.
 */

import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import type {
  CheckOwnerDecisionPort,
  CheckOwnerDecisionRequest,
  CheckOwnerDecisionResult,
} from '../ports/in/CheckOwnerDecisionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';

export interface CheckOwnerDecisionDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
}

/** The only action scope a request may carry to authorize its own decision. */
export function ownerDecisionActionScope(requestId: string): string {
  return `owner-decision:${requestId}`;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class CheckOwnerDecisionUseCase implements CheckOwnerDecisionPort {
  constructor(private readonly deps?: CheckOwnerDecisionDependencies) {}

  async checkOwnerDecision(
    request: CheckOwnerDecisionRequest,
  ): Promise<CheckOwnerDecisionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<CheckOwnerDecisionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: CheckOwnerDecisionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: CheckOwnerDecisionUseCase');
    }
    const request = input as CheckOwnerDecisionRequest;
    const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
    if (requestId === '' || !isFilled(request.candidateHeadSha)) {
      throw new Error('Not implemented: CheckOwnerDecisionUseCase');
    }
    const candidateHeadSha = request.candidateHeadSha.trim();

    let recorded: Awaited<
      ReturnType<CoordinationRequestRepositoryPort['findRequestById']>
    > | null;
    try {
      recorded = await this.deps.requestRepo.findRequestById(requestId);
    } catch (error) {
      return {
        outcome: 'unknown',
        requestId,
        reason: `Coordination request ${requestId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (recorded === null) {
      return {
        outcome: 'unknown',
        requestId,
        reason: `No coordination request is recorded for owner decision ${requestId}`,
      };
    }

    let candidate: CoordinationRequest;
    try {
      candidate = CoordinationRequest.fromRecord(recorded);
    } catch (error) {
      return {
        outcome: 'unknown',
        requestId,
        reason: `Coordination request ${requestId} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const actionScope = ownerDecisionActionScope(requestId);
    if (!candidate.canAuthorizeAction(actionScope, candidateHeadSha)) {
      return {
        outcome: 'not-approved',
        requestId,
        reason: `coordination request ${requestId} is '${candidate.getState()}' for scope '${candidate.getActionScope()}' at ${candidate.getExpectedHeadSha() ?? 'no commit'}; it does not authorize ${actionScope} at ${candidateHeadSha}`,
      };
    }
    // canAuthorizeAction already requires a grant; this narrows the type only.
    const grantId = candidate.getGrantId();
    if (grantId === null) {
      return {
        outcome: 'not-approved',
        requestId,
        reason: `coordination request ${requestId} carries no grant`,
      };
    }
    return { outcome: 'approved', requestId, grantId };
  }
}