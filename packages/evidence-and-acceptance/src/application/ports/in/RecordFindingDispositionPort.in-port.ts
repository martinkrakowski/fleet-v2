// @generated inbound contract scaffold — refined for step 4.
/**
 * Record a fix or evidence-backed refutation of a specific finding while
 * preserving unresolved findings.
 */

import type { EvidenceAssessmentRecord, FindingDispositionRecord } from '../../../domain/evidence-records.js';

export interface RecordFindingDispositionRequest {
  readonly assessmentId: string;
  readonly disposition: FindingDispositionRecord;
  readonly nowIso?: string;
}

export type RecordFindingDispositionResult =
  | { readonly outcome: 'recorded'; readonly assessment: EvidenceAssessmentRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RecordFindingDispositionPort {
  recordFindingDisposition(request: RecordFindingDispositionRequest): Promise<RecordFindingDispositionResult>;
}
