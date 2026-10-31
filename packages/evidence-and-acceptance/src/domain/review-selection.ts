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

/**
 * Whether a failing receipt is fully dispositioned (KF-33b3): its `result` is
 * `fail`, it raised at least one finding, and every finding id it raised is
 * resolved by an `out-of-scope` disposition and is not unresolved (per
 * `EvidenceAssessment.unresolvedFindingIds()`). Only `out-of-scope` is
 * machine-derived from the lane's diff and converts a fail; a fail receipt
 * whose findings are resolved by `fixed`/`refuted` (alone or mixed with
 * out-of-scope) is never fully dispositioned and keeps failing. A `pass` or
 * `unknown` receipt is never affected.
 */
export function isFullyDispositioned(
  receipt: Pick<ReviewReceiptRecord, 'result' | 'findings'>,
  outOfScopeResolvedFindingIds: ReadonlySet<string>,
  unresolvedFindingIds: ReadonlySet<string>,
): boolean {
  if (receipt.result !== 'fail') {
    return false;
  }
  if (receipt.findings.length === 0) {
    return false;
  }
  return receipt.findings.every(
    (finding) =>
      outOfScopeResolvedFindingIds.has(finding.findingId) &&
      !unresolvedFindingIds.has(finding.findingId),
  );
}

/**
 * Whether a receipt satisfies the acceptance review gate as a fully
 * dispositioned failing `code-review` (KF-33b3): like `satisfiesReviewPassGate`
 * for a `pass`, a fully dispositioned failing `code-review` counts. The kind
 * rule is unchanged: a fully dispositioned failing `brief-check` (or any
 * non-`code-review` kind) never satisfies the gate on its own.
 */
export function satisfiesFullyDispositionedReviewPassGate(
  receipt: Pick<ReviewReceiptRecord, 'kind' | 'result' | 'findings'>,
  outOfScopeResolvedFindingIds: ReadonlySet<string>,
  unresolvedFindingIds: ReadonlySet<string>,
): boolean {
  return (
    reviewKindOf(receipt) === 'code-review' &&
    isFullyDispositioned(receipt, outOfScopeResolvedFindingIds, unresolvedFindingIds)
  );
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

/**
 * Count the latest receipts per reviewer; disagreement is pass and fail
 * together. Informational only: it reports raw receipt results, so a fully
 * dispositioned fail still counts as a fail here (KF-33b3); the verdict uses
 * `satisfiesReviewPassGate`/`satisfiesFullyDispositionedReviewPassGate`
 * instead.
 */
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
