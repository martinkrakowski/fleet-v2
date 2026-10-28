/**
 * Independent review selection (plan §3.2): among the receipts that are
 * independent and read-only for a head, the latest receipt per reviewer model
 * and review kind decides — the last one recorded in the assessment's
 * append-only `reviewReceipts`, never by `completedAtIso`. Recording order
 * wins, and agreement between reviewers never strengthens a result.
 */

import type { ReviewKind, ReviewReceiptRecord } from './evidence-records.js';

export interface ReviewTally {
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly disagreement: boolean;
}

/** A receipt's review kind; one recorded without a kind reads as `code-review` (plan §3.4, D10). */
export function reviewKindOf(receipt: Pick<ReviewReceiptRecord, 'kind'>): ReviewKind {
  return receipt.kind ?? 'code-review';
}

/**
 * Whether a receipt satisfies the acceptance review gate as the passing review
 * (§3.4): only receipts whose kind is absent or `code-review` count. A receipt
 * of another kind (e.g. `brief-check`) never satisfies the gate on its own; a
 * failing latest receipt of any kind still blocks acceptance.
 */
export function satisfiesReviewPassGate(
  receipt: Pick<ReviewReceiptRecord, 'kind' | 'result'>,
): boolean {
  return receipt.result === 'pass' && reviewKindOf(receipt) === 'code-review';
}

/** The last receipt per reviewer model and review kind, in array order. */
export function latestReceiptPerReviewer(
  receipts: readonly ReviewReceiptRecord[],
): readonly ReviewReceiptRecord[] {
  const latest = new Map<string, { index: number; receipt: ReviewReceiptRecord }>();
  for (const [index, receipt] of receipts.entries()) {
    latest.set(receipt.reviewerModel.trim() + '\n' + reviewKindOf(receipt), { index, receipt });
  }
  return [...latest.values()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.receipt);
}

/** Count the latest receipts per reviewer; disagreement is pass and fail together. */
export function tallyReviews(latest: readonly ReviewReceiptRecord[]): ReviewTally {
  let pass = 0;
  let fail = 0;
  let unknown = 0;
  for (const receipt of latest) {
    if (receipt.result === 'pass') {
      pass += 1;
    } else if (receipt.result === 'fail') {
      fail += 1;
    } else {
      unknown += 1;
    }
  }
  return { pass, fail, unknown, disagreement: pass > 0 && fail > 0 };
}
