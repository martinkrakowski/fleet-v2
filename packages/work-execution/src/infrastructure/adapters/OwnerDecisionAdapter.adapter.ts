// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * OwnerDecisionAdapter implements OwnerDecisionPort by in-process delegation
 * to operator coordination's CheckOwnerDecisionPort; the recorded request's
 * own authorization rule decides, never this adapter.
 */

import type {
  OwnerDecisionPort,
  ResolveOwnerDecisionRequest,
  OwnerDecisionResult,
} from '../../application/ports/out/OwnerDecisionPort.out-port.js';

export interface OwnerDecisionDelegate {
  readonly resolveOwnerDecision?: (
    request: ResolveOwnerDecisionRequest,
  ) => Promise<OwnerDecisionResult>;
}

export class OwnerDecisionAdapter implements OwnerDecisionPort {
  constructor(private readonly delegate?: OwnerDecisionDelegate) {}

  async resolveOwnerDecision(
    request: ResolveOwnerDecisionRequest,
  ): Promise<OwnerDecisionResult> {
    if (!this.delegate?.resolveOwnerDecision) {
      throw new Error('Not implemented: OwnerDecisionAdapter.resolveOwnerDecision');
    }
    return this.delegate.resolveOwnerDecision(request);
  }
}