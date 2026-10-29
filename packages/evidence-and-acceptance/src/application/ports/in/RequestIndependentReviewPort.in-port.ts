// @generated inbound contract scaffold — refined for step 4.
/**
 * Request a read-only review using an underlying model distinct from the
 * implementer's and bind its result to the reviewed head.
 */

import type { ReviewKind, ReviewReceiptRecord } from '../../../domain/evidence-records.js';

export interface RequestIndependentReviewRequest {
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly implementerModel: string;
  readonly reviewerModel: string;
  readonly diffSummary?: string;
  readonly nowIso?: string;
  /** The review kind (§3.3); required when `requestId` is present. */
  readonly kind?: ReviewKind;
  /** The conductor's request id (§3.2, §3.5); a replay returns the receipt already recorded for it. */
  readonly requestId?: string;
  /** The frozen brief; only meaningful with `kind` (a brief-check review answers against it). */
  readonly briefText?: string;
}

export const REVIEW_REJECTIONS = [
  'invalid-request', 'not-independent', 'seat-refused', 'no-assessment', 'assessment-mismatch',
  'assessment-terminal', 'request-id-reused', 'review-unavailable', 'not-read-only', 'invalid-receipt',
] as const;
export type ReviewRejection = (typeof REVIEW_REJECTIONS)[number];

export type RequestIndependentReviewResult =
  | { readonly outcome: 'reviewed'; readonly receipt: ReviewReceiptRecord }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
      /** Set exactly when the request carried a requestId. */
      readonly rejection?: ReviewRejection;
    };

export interface RequestIndependentReviewPort {
  requestIndependentReview(request: RequestIndependentReviewRequest): Promise<RequestIndependentReviewResult>;
}
