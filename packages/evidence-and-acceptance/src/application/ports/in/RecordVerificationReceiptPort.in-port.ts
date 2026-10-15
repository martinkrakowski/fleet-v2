// @generated inbound contract scaffold — refined for step 4.
/**
 * Validate and retain a completed check's head, host, procedure, exit result
 * and evidence reference without treating launch as completion.
 */

import type { EvidenceAssessmentRecord, VerificationReceiptRecord } from '../../../domain/evidence-records.js';

export interface RecordVerificationReceiptRequest {
  readonly assessmentId: string;
  readonly receipt: VerificationReceiptRecord;
  readonly nowIso?: string;
}

export type RecordVerificationReceiptResult =
  | { readonly outcome: 'recorded'; readonly assessment: EvidenceAssessmentRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RecordVerificationReceiptPort {
  recordVerificationReceipt(request: RecordVerificationReceiptRequest): Promise<RecordVerificationReceiptResult>;
}
