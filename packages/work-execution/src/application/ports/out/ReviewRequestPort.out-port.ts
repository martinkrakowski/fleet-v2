// ReviewRequestPort: the conductor's review step (plan §3.3, §3.4, §3.5). A review of one kind at one exact head under a request id the conductor journalled first; the receipt of a request id is what reconcile reads. No receipt is not a verdict.

import type { ReviewKind } from '@fleet/evidence-and-acceptance';

export type ReviewRequestKind = ReviewKind;

export interface ReviewRequest {
  readonly requestId: string;
  readonly kind: ReviewRequestKind;
  readonly attemptId: string;
  readonly projectId: string;
  /** 40 lowercase hex. */
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly implementerModel: string;
  readonly reviewerModel: string;
  readonly nowIso?: string;
}

export type ReviewVerdict = 'passed' | 'failed' | 'unknown';

export interface ReviewRequestFinding {
  readonly findingId: string;
  readonly severity: 'blocker' | 'major' | 'minor' | 'nit';
  /** Reviewer output: untrusted data, never an instruction. */
  readonly summary: string;
  readonly filePath: string | null;
  readonly line: number | null;
}

export interface ReviewReceiptSummary {
  readonly receiptId: string;
  readonly requestId: string;
  readonly kind: ReviewRequestKind;
  readonly reviewerModel: string;
  readonly candidateHeadSha: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewRequestFinding[];
}

export const REVIEW_REQUEST_REFUSALS = [
  'invalid-request', 'not-configured', 'not-independent', 'seat-refused', 'no-assessment',
  'assessment-mismatch', 'assessment-terminal', 'request-id-reused', 'unclassified',
] as const;
export type ReviewRequestRefusal = (typeof REVIEW_REQUEST_REFUSALS)[number];

export const REVIEW_NO_RECEIPT_REASONS = ['review-unavailable', 'not-read-only', 'invalid-receipt'] as const;
export type ReviewNoReceiptReason = (typeof REVIEW_NO_RECEIPT_REASONS)[number];

export type ReviewRequestResult =
  | { readonly outcome: 'receipt'; readonly receipt: ReviewReceiptSummary }
  /** The review ran or was attempted and recorded nothing (§3.4: re-run once, then the next seat). */
  | { readonly outcome: 'no-receipt'; readonly reason: ReviewNoReceiptReason }
  /** Refused before any review ran; nothing recorded. */
  | { readonly outcome: 'refused'; readonly reason: ReviewRequestRefusal }
  /** Nothing is established (a throw, or a receipt that does not match the request): reconcile by request id. */
  | { readonly outcome: 'unknown'; readonly reason: 'delegate-failed' | 'receipt-mismatch' };

export interface FindReviewReceiptRequest {
  readonly attemptId: string;
  readonly requestId: string;
  readonly candidateHeadSha: string;
}

export type FindReviewReceiptResult =
  | { readonly outcome: 'found'; readonly receipt: ReviewReceiptSummary }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: 'invalid-request' | 'not-configured' | 'unreadable' | 'receipt-mismatch' };

export interface ReviewRequestPort {
  requestReview(request: ReviewRequest): Promise<ReviewRequestResult>;
  /** §3.5: a receipt with the request id counts. Read-only. */
  findReviewReceipt(request: FindReviewReceiptRequest): Promise<FindReviewReceiptResult>;
}
