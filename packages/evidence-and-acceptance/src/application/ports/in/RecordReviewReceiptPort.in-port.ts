// @generated inbound contract scaffold — refined for step 4.
/**
 * Retain exact-head reviewer identity, read-only capability, findings and
 * source evidence; reject a purported independent review by the same model.
 */

import type { EvidenceAssessmentRecord, ReviewReceiptRecord } from '../../../domain/evidence-records.js';

export interface RecordReviewReceiptRequest {
  readonly assessmentId: string;
  readonly receipt: ReviewReceiptRecord;
  readonly nowIso?: string;
}

export type RecordReviewReceiptResult =
  | { readonly outcome: 'recorded'; readonly assessment: EvidenceAssessmentRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RecordReviewReceiptPort {
  recordReviewReceipt(request: RecordReviewReceiptRequest): Promise<RecordReviewReceiptResult>;
}
