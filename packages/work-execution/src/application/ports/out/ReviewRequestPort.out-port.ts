// ReviewRequestPort: the conductor's review step (plan §3.3, §3.4, §3.5). A review of one kind at one exact head under a request id the conductor journalled first; the receipt of a request id is what reconcile reads. No receipt is not a verdict.

import type { ReviewKind } from '@fleet/evidence-and-acceptance';

/** The kinds a request may name: the stored review kinds plus `brief-verify` (the manifest contract), which is refused at runtime until the brief subject is implemented. */
export type ReviewRequestKind = ReviewKind | 'brief-verify';

/** The stored review kinds, which a receipt can carry (`brief-verify` is never stored yet). */
export type StoredReviewRequestKind = ReviewKind;

export const REVIEW_SUBJECT_KINDS = ['attempt', 'chain', 'brief'] as const;

/** What a review is about: an attempt at one exact head, a chain at its integration head, or a brief package at its base commit. */
export type ReviewSubject =
  | { readonly kind: 'attempt'; readonly projectId: string; readonly attemptId: string; readonly headSha: string }
  | { readonly kind: 'chain'; readonly projectId: string; readonly chainName: string; readonly integrationHeadSha: string }
  | { readonly kind: 'brief'; readonly projectId: string; readonly briefPackageDigest: string; readonly baseCommit: string };

export interface ReviewRequest {
  readonly requestId: string;
  /** `brief-verify` is typed in and refused at runtime (`subject-not-implemented`) until CO18. */
  readonly kind: ReviewRequestKind;
  readonly attemptId: string;
  readonly projectId: string;
  /** 40 lowercase hex. */
  readonly candidateHeadSha: string;
  /**
   * Absent: the attempt `attemptId` at `candidateHeadSha`. A `chain` subject
   * names the combined review of a chain at its integration head, which must
   * equal `candidateHeadSha`; the attempt fields then only mirror the subject.
   */
  readonly subject?: ReviewSubject;
  readonly policyRevision: string;
  readonly implementerModel: string;
  readonly reviewerModel: string;
  /** The frozen brief; only forwarded with `kind: 'brief-check'`, capped at 64 KiB. */
  readonly briefText?: string;
  /** Only forwarded with a chain subject: the scope in a few words (no path, no diff text), capped at 2 KiB. */
  readonly diffSummary?: string;
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
  readonly state?: string;
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
  'assessment-mismatch', 'assessment-terminal', 'request-id-reused', 'unclassified', 'subject-not-implemented',
] as const;
export type ReviewRequestRefusal = (typeof REVIEW_REQUEST_REFUSALS)[number];

export const REVIEW_NO_RECEIPT_REASONS = ['review-unavailable', 'not-read-only', 'invalid-receipt'] as const;
export type ReviewNoReceiptReason = (typeof REVIEW_NO_RECEIPT_REASONS)[number];

export type ReviewRequestResult =
  | { readonly outcome: 'receipt'; readonly receipt: ReviewReceiptSummary }
  /**
   * The review ran or was attempted and recorded nothing (§3.4: re-run once,
   * then the next seat). `detail` is the fixed reason code when it matches the
   * run-journal pattern (KF-14a), else null.
   */
  | { readonly outcome: 'no-receipt'; readonly reason: ReviewNoReceiptReason; readonly detail: string | null }
  /** Refused before any review ran; nothing recorded. */
  | { readonly outcome: 'refused'; readonly reason: ReviewRequestRefusal; readonly detail: string | null }
  /** Nothing is established (a throw, or a receipt that does not match the request): reconcile by request id. */
  | { readonly outcome: 'unknown'; readonly reason: 'delegate-failed' | 'receipt-mismatch' };

export interface FindReviewReceiptRequest {
  readonly attemptId: string;
  readonly requestId: string;
  readonly candidateHeadSha: string;
  /** Absent: the attempt semantics above. A chain subject reads the chain's own assessment. */
  readonly subject?: ReviewSubject;
}

export type FindReviewReceiptResult =
  | { readonly outcome: 'found'; readonly receipt: ReviewReceiptSummary }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: 'invalid-request' | 'not-configured' | 'unreadable' | 'receipt-mismatch' };

export interface FindLatestReceiptOfKindRequest {
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly kind: ReviewRequestKind;
  /** Absent: the attempt semantics above. A chain subject reads the chain's own assessment. */
  readonly subject?: ReviewSubject;
}

/** A receipt of one kind at one head; manual receipts carry no request id. */
export type ReviewReceiptOfKind = Omit<ReviewReceiptSummary, 'requestId'> & {
  readonly requestId: string | null;
};

export type FindLatestReceiptOfKindResult =
  | { readonly outcome: 'found'; readonly receipt: ReviewReceiptOfKind }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: 'invalid-request' | 'not-configured' | 'unreadable' | 'receipt-mismatch' };

/**
 * KF-33b2: the conductor's out-of-scope dispositions for one failed review
 * receipt. The ids are the receipt-scoped finding ids; the head is the
 * receipt's collected head.
 */
export interface RecordOutOfScopeRequest {
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly findingIds: readonly string[];
  readonly nowIso?: string;
}

/** Any rejection, throw or missing delegate answers refused: fail closed. */
export type RecordOutOfScopeResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'refused' };

export interface ReviewRequestPort {
  requestReview(request: ReviewRequest): Promise<ReviewRequestResult>;
  /** §3.5: a receipt with the request id counts. Read-only. */
  findReviewReceipt(request: FindReviewReceiptRequest): Promise<FindReviewReceiptResult>;
  /**
   * D3: the latest receipt of exactly `kind` at `candidateHeadSha` (by
   * `completedAtIso`; a receipt without a kind never matches). Read-only.
   */
  findLatestReceiptOfKind(request: FindLatestReceiptOfKindRequest): Promise<FindLatestReceiptOfKindResult>;
  /**
   * KF-33b2: record `out-of-scope` dispositions for the receipt-scoped finding
   * ids a failed review raised on files the lane never changed. Optional: a
   * port without it never records, and every finding keeps blocking.
   */
  recordOutOfScope?(request: RecordOutOfScopeRequest): Promise<RecordOutOfScopeResult>;
}
