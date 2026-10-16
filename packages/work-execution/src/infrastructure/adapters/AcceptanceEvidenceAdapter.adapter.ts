// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * AcceptanceEvidenceAdapter implements AcceptanceEvidencePort by in-process
 * delegation to evidence-and-acceptance inspection use cases.
 */

import type {
  AcceptanceEvidencePort,
  ReadAcceptanceRequest,
  ReadAcceptanceResult,
} from '../../application/ports/out/AcceptanceEvidencePort.out-port.js';

export interface AcceptanceEvidenceDelegate {
  readonly readAcceptance?: (
    request: ReadAcceptanceRequest,
  ) => Promise<ReadAcceptanceResult>;
}

export class AcceptanceEvidenceAdapter implements AcceptanceEvidencePort {
  constructor(private readonly delegate?: AcceptanceEvidenceDelegate) {}

  async readAcceptance(request: ReadAcceptanceRequest): Promise<ReadAcceptanceResult> {
    if (!this.delegate?.readAcceptance) {
      throw new Error('Not implemented: AcceptanceEvidenceAdapter.readAcceptance');
    }
    return this.delegate.readAcceptance(request);
  }
}
