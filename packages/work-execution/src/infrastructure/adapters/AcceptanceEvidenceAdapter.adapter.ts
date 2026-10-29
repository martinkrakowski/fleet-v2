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

import { assessmentIdForAttempt, type InspectAcceptanceEvidencePort } from '@fleet/evidence-and-acceptance';

/**
 * The one attempt-bound acceptance read both composition roots (CLI and API) bind: the attempt's own assessment id
 * first, the legacy id second, and never another attempt's evidence for the same head (no head-only fallback).
 */
export async function readAcceptanceForAttempt(
  inspector: Pick<InspectAcceptanceEvidencePort, 'inspectAcceptanceEvidence'>,
  request: ReadAcceptanceRequest,
): Promise<ReadAcceptanceResult> {
  let inspected = await inspector.inspectAcceptanceEvidence({
    assessmentId: assessmentIdForAttempt(request.attemptId),
    candidateHeadSha: request.candidateHeadSha,
  });
  if (inspected.outcome === 'not-found') {
    inspected = await inspector.inspectAcceptanceEvidence({
      assessmentId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
    });
  }
  if (inspected.outcome === 'found' && inspected.assessment.attemptId === request.attemptId) {
    return {
      outcome: 'found',
      assessment: {
        candidateHeadSha: inspected.assessment.candidateHeadSha,
        policyRevision: inspected.assessment.policyRevision,
        state: inspected.assessment.state,
        acceptanceReceiptId: inspected.assessment.acceptanceReceiptId,
      },
    };
  }
  return {
    outcome: 'not-found',
    reason: `No acceptance assessment found for head ${request.candidateHeadSha}`,
  };
}

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
