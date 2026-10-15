// @generated inbound contract scaffold — refined for step 4.
/**
 * Request the required completed checks on configured verification hosts for
 * a precise head and acceptance-policy revision.
 */

import type { EvidenceAssessmentRecord, VerificationReceiptRecord } from '../../../domain/evidence-records.js';

export interface RequestVerificationRequest {
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly hostId: string;
  readonly requiredChecks: readonly string[];
  readonly nowIso?: string;
}

export type RequestVerificationResult =
  | { readonly outcome: 'completed'; readonly assessment: EvidenceAssessmentRecord; readonly receipts: readonly VerificationReceiptRecord[] }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RequestVerificationPort {
  requestVerification(request: RequestVerificationRequest): Promise<RequestVerificationResult>;
}
