// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * OwnerDecisionAdapter implements OwnerDecisionPort by in-process delegation
 * to operator-coordination's CheckOwnerDecisionPort. It reads no repository and
 * applies no authorization rule of its own: the supplier context decides
 * whether a recorded request authorizes its own owner decision, and this
 * adapter only carries that verdict across the boundary.
 */

import type {
  OwnerDecisionPort,
  OwnerDecisionResult,
  ResolveOwnerDecisionRequest,
} from '../../application/ports/out/OwnerDecisionPort.out-port.js';

export interface OwnerDecisionDelegate {
  readonly checkOwnerDecision?: (request: {
    readonly requestId: string;
    readonly candidateHeadSha: string;
  }) => Promise<OwnerDecisionResult>;
}

export class OwnerDecisionAdapter implements OwnerDecisionPort {
  constructor(private readonly delegate?: OwnerDecisionDelegate) {}

  async resolveOwnerDecision(
    request: ResolveOwnerDecisionRequest,
  ): Promise<OwnerDecisionResult> {
    const checkOwnerDecision = this.delegate?.checkOwnerDecision;
    if (!checkOwnerDecision) {
      throw new Error('Not implemented: OwnerDecisionAdapter.resolveOwnerDecision');
    }
    const result = await checkOwnerDecision({
      requestId: request.decisionReference,
      candidateHeadSha: request.candidateHeadSha,
    });
    return result.outcome === 'approved'
      ? { outcome: 'approved', decisionId: result.decisionId }
      : result;
  }
}