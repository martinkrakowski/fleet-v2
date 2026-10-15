// @generated inbound contract scaffold — refined for step 4.
/**
 * Request a read-only review using an underlying model distinct from the
 * implementer's and bind its result to the reviewed head.
 */

import type { ReviewReceiptRecord } from '../../../domain/evidence-records.js';

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
}

export type RequestIndependentReviewResult =
  | { readonly outcome: 'reviewed'; readonly receipt: ReviewReceiptRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RequestIndependentReviewPort {
  requestIndependentReview(request: RequestIndependentReviewRequest): Promise<RequestIndependentReviewResult>;
}
