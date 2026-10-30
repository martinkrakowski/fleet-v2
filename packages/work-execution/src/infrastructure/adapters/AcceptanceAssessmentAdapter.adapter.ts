// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * AcceptanceAssessmentAdapter implements AcceptanceAssessmentPort by
 * in-process delegation to the evidence-and-acceptance application
 * contracts. Wiring to the supplier ports lands at the composition root;
 * until a delegate is configured every call refuses.
 *
 * Reviewer/implementer model independence is enforced upstream in
 * RequestAttemptAcceptanceUseCase, which owns those identities: this
 * request carries only exact-head and policy coordinates.
 */

import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
  AcceptanceReceiptsResult,
} from '../../application/ports/out/AcceptanceAssessmentPort.out-port.js';

/** Supplier-side delegate; the composition root binds the real use case. */
export interface AcceptanceAssessmentDelegate {
  readonly assess?: (
    request: AcceptanceAssessmentRequest,
  ) => Promise<AcceptanceAssessmentResult>;
  readonly assessReceipts?: (
    request: AcceptanceAssessmentRequest,
  ) => Promise<AcceptanceReceiptsResult>;
}

export class AcceptanceAssessmentAdapter implements AcceptanceAssessmentPort {
  private readonly delegate?: AcceptanceAssessmentDelegate;

  constructor(delegate?: AcceptanceAssessmentDelegate) {
    this.delegate = delegate;
  }

  async assessHeadAcceptance(
    request: AcceptanceAssessmentRequest,
  ): Promise<AcceptanceAssessmentResult> {
    if (!this.delegate?.assess) {
      throw new Error('Not implemented: AcceptanceAssessmentAdapter.assessHeadAcceptance');
    }
    return this.delegate.assess(request);
  }

  async assessHeadReceipts(
    request: AcceptanceAssessmentRequest,
  ): Promise<AcceptanceReceiptsResult> {
    if (!this.delegate?.assessReceipts) {
      throw new Error('Not implemented: AcceptanceAssessmentAdapter.assessHeadReceipts');
    }
    return this.delegate.assessReceipts(request);
  }
}
