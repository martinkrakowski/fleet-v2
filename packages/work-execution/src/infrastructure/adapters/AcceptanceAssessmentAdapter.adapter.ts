// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * AcceptanceAssessmentAdapter implements AcceptanceAssessmentPort
 * (in-process delegation to evidence-and-acceptance). Wiring lands in wave
 * 2; every method refuses until then.
 */

import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
} from '../../application/ports/out/AcceptanceAssessmentPort.out-port.js';

export class AcceptanceAssessmentAdapter implements AcceptanceAssessmentPort {
  async assessHeadAcceptance(_request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult> {
    throw new Error('Not implemented: AcceptanceAssessmentAdapter.assessHeadAcceptance');
  }
}
