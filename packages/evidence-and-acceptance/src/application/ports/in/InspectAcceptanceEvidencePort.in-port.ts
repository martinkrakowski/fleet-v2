// @generated inbound contract scaffold — refined for step 4.
/**
 * Return assessment revisions and receipt provenance, including stale,
 * missing and unknown evidence.
 */

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';

export interface InspectAcceptanceEvidenceRequest {
  readonly assessmentId?: string;
  readonly candidateHeadSha?: string;
}

export type InspectAcceptanceEvidenceResult =
  | { readonly outcome: 'found'; readonly assessment: EvidenceAssessmentRecord }
  | { readonly outcome: 'not-found'; readonly query: string };

export interface InspectAcceptanceEvidencePort {
  inspectAcceptanceEvidence(request: InspectAcceptanceEvidenceRequest): Promise<InspectAcceptanceEvidenceResult>;
}
