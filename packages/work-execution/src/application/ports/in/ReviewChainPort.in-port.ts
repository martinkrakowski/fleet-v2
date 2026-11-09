/**
 * ReviewChainPort (lane CO9): start or complete the combined pre-merge review
 * of one chain. Start pins the chain tip on the chain record and requests one
 * review of kind `pre-merge` on the receipt subject `chain`; complete returns
 * the receipt, reviewer model and verdict with each link's own attempt
 * `pre-merge` receipt, for landing. Every refusal is a fixed code: no path, no
 * diff and no reviewer text crosses this port.
 */

import type { TelemetryHashInput } from '../../../domain/run-telemetry-ids.js';

export interface ReviewChainRepository {
  readonly owner: string;
  readonly repo: string;
}

export interface ReviewChainStartCommand {
  readonly projectId: string;
  readonly repository: ReviewChainRepository;
  /** The bare chain name, without `chain/`. */
  readonly chainName: string;
  /** 40 lowercase hex: the chain tip to review; refused when the branch is no longer there. */
  readonly chainHeadSha: string;
  readonly policyRevision: string;
  /** The model that reviews; none of the chain's implementer models may share its family. */
  readonly reviewerModel: string;
  readonly nowIso?: string;
  readonly deadlineIso?: string;
}

export interface ReviewChainCompleteCommand {
  readonly projectId: string;
  readonly repository: ReviewChainRepository;
  readonly chainName: string;
  /** The request id the start returned; it must be the pinned one. */
  readonly requestId: string;
  readonly nowIso?: string;
  readonly deadlineIso?: string;
}

/** The closed vocabulary of this port's reasons. */
export const REVIEW_CHAIN_REASONS = [
  'invalid-request', 'chain-not-found', 'chain-unreadable', 'chain-record-stale', 'link-unsettled',
  'integration-pr-open', 'implementer-models-unknown', 'reviewer-not-independent', 'review-not-configured',
  'review-refused', 'review-no-receipt', 'review-unknown', 'chain-tip-moved', 'receipt-missing',
  'link-receipt-missing', 'verdict-unknown', 'subject-not-implemented', 'budget-exhausted', 'store-unavailable',
  'forge-unavailable', 'too-many-links',
] as const;
export type ReviewChainReason = (typeof REVIEW_CHAIN_REASONS)[number];

/** One link's own attempt-subject `pre-merge` receipt; nothing else of the receipt crosses. */
export interface ChainLinkReceiptProjection {
  readonly pullRequestNumber: number;
  readonly attemptId: string;
  /** Hash input only, exactly as the receipt port returns it; never a raw id. */
  readonly receiptId: TelemetryHashInput;
  readonly result: 'pass' | 'fail';
  readonly kind: 'pre-merge';
  readonly findings: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
    readonly nit: number;
  };
  readonly completedAtIso: string;
}

export type ReviewChainStartResult =
  | {
      readonly outcome: 'started';
      readonly requestId: string;
      readonly key: string;
      readonly headSha: string;
      readonly reviewerModel: string;
    }
  | { readonly outcome: 'refused'; readonly reason: ReviewChainReason }
  | { readonly outcome: 'unknown'; readonly reason: ReviewChainReason };

export type ReviewChainCompleteResult =
  | {
      readonly outcome: 'completed';
      readonly requestId: string;
      readonly receiptId: string;
      readonly reviewerModel: string;
      readonly verdict: 'passed' | 'failed';
      readonly links: readonly ChainLinkReceiptProjection[];
    }
  | { readonly outcome: 'refused'; readonly reason: ReviewChainReason }
  | { readonly outcome: 'unknown'; readonly reason: ReviewChainReason };

export interface ReviewChainPort {
  startChainReview(command: ReviewChainStartCommand): Promise<ReviewChainStartResult>;
  completeChainReview(command: ReviewChainCompleteCommand): Promise<ReviewChainCompleteResult>;
}
