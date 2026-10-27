/**
 * Independent review selection (plan §3.2): among the receipts that are
 * independent and read-only for a head, the latest receipt per reviewer model
 * decides — the last one recorded in the assessment's append-only
 * `reviewReceipts`, never by `completedAtIso`. Recording order wins, and
 * agreement between reviewers never strengthens a result.
 */

import type { ReviewReceiptRecord } from './evidence-records.js';

export interface ReviewTally {
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly disagreement: boolean;
}

/** The last receipt per reviewer (keyed by trimmed reviewer model), in array order. */
export function latestReceiptPerReviewer(
  receipts: readonly ReviewReceiptRecord[],
): readonly ReviewReceiptRecord[] {
  const latest = new Map<string, { index: number; receipt: ReviewReceiptRecord }>();
  for (const [index, receipt] of receipts.entries()) {
    latest.set(receipt.reviewerModel.trim(), { index, receipt });
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
