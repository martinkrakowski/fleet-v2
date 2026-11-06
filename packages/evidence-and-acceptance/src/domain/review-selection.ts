/**
 * Independent review selection (plan §3.2): among the receipts that are
 * independent and read-only for a head, the latest receipt per reviewer model
 * and review kind decides — the last one recorded in the assessment's
 * append-only `reviewReceipts`, never by `completedAtIso`. Recording order
 * wins, and agreement between reviewers never strengthens a result.
 */

import type { ReviewKind, ReviewFindingRecord, ReviewReceiptRecord, ReviewUnknownReason } from './evidence-records.js';

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
 * Whether a finding severity blocks (RV3): only `minor` and `nit` are
 * non-blocking; `blocker`, `major` and any unrecognized runtime value fail
 * closed to blocking.
 */
export function isBlockingFindingSeverity(severity: unknown): boolean {
  return severity !== 'minor' && severity !== 'nit';
}

/** Type guard for the two non-blocking severities (RV3). */
export function isMinorOrNitSeverity(severity: unknown): severity is 'minor' | 'nit' {
  return severity === 'minor' || severity === 'nit';
}

/** A value is a plain object (prototype `Object.prototype` or `null`). */
function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The value of the receiver's own data property `key`, read without running
 * any accessor: a throwing or accessor-shaped getter reads as absent. Never
 * throws.
 */
function ownProp(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(source, key)?.value;
  } catch {
    return undefined;
  }
}

const SEVERITY_VALUES: readonly string[] = ['blocker', 'major', 'minor', 'nit'];
const UNKNOWN_REASON_VALUES: readonly string[] = ['empty', 'unparseable-verdict', 'no-findings-on-fail'];

/** A declared `ReviewUnknownReason` token, or null when the value is not one. */
function unknownReasonOf(value: unknown): ReviewUnknownReason | null {
  return typeof value === 'string' && UNKNOWN_REASON_VALUES.includes(value)
    ? (value as ReviewUnknownReason)
    : null;
}

/** The severity the finding's own data property carries, or null when invalid. */
function severityOfFinding(finding: unknown): string | null {
  const severity = ownProp(finding, 'severity');
  return typeof severity === 'string' && SEVERITY_VALUES.includes(severity) ? severity : null;
}

/** The findingId the finding's own data property carries, or null when invalid. */
function findingIdOf(finding: unknown): string | null {
  const id = ownProp(finding, 'findingId');
  return typeof id === 'string' ? id : null;
}

/**
 * A receipt's severity-derived outcome (RV3). Pure and total: it never throws
 * on any runtime input (null, non-object, sparse `findings`, unknown enums,
 * throwing getters) and fails closed to `unknown`.
 *
 * - `unknown` when the receipt is not a plain object, `findings` is not a
 *   dense array of plain objects with severities of the four declared values,
 *   `readOnlyVerified !== true`, `result` is neither `pass` nor `fail`, or a
 *   `fail` receipt carries zero findings (`no-findings-on-fail` shape: the
 *   receipt's own declared `unknownReason` is preserved, else
 *   `unparseable-verdict`).
 * - `fail` when any `blocker` or `major` finding is unresolved: with
 *   `unresolvedFindingIds` supplied, a finding is unresolved when that set
 *   holds its id, or (on a `fail` receipt) the id is not resolved by an
 *   `out-of-scope` disposition (KF-33b3 S1: a `fixed`/`refuted` resolution
 *   never converts the receipt it failed on). Without the sets, any
 *   `blocker`/`major` finding fails.
 * - `pass` otherwise, carrying every `minor`/`nit` finding not resolved
 *   out-of-scope (`carriedMinors`) — whatever the raw verdict word was.
 */
export function decideReviewReceiptOutcome(
  receipt: unknown,
  outOfScopeResolvedFindingIds?: ReadonlySet<string>,
  unresolvedFindingIds?: ReadonlySet<string>,
):
  | { readonly outcome: 'unknown'; readonly unknownReason: ReviewUnknownReason | null }
  | { readonly outcome: 'fail' }
  | { readonly outcome: 'pass'; readonly carriedMinors: readonly ReviewFindingRecord[] } {
  try {
    if (!isPlainRecordObject(receipt)) {
      return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
    }
    const findings = ownProp(receipt, 'findings');
    if (!Array.isArray(findings)) {
      return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
    }
    for (let index = 0; index < findings.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(findings, index)) {
        return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
      }
      const finding = findings[index];
      if (!isPlainRecordObject(finding) || severityOfFinding(finding) === null) {
        return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
      }
    }
    if (ownProp(receipt, 'readOnlyVerified') !== true) {
      return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
    }
    const result = ownProp(receipt, 'result');
    if (result !== 'pass' && result !== 'fail') {
      return { outcome: 'unknown', unknownReason: unknownReasonOf(ownProp(receipt, 'unknownReason')) ?? 'unparseable-verdict' };
    }
    if (result === 'fail' && findings.length === 0) {
      return {
        outcome: 'unknown',
        unknownReason: unknownReasonOf(ownProp(receipt, 'unknownReason')) ?? 'unparseable-verdict',
      };
    }
    const failed = findings.some((finding) => {
      if (!isBlockingFindingSeverity(severityOfFinding(finding))) {
        return false;
      }
      const findingId = findingIdOf(finding);
      if (unresolvedFindingIds !== undefined) {
        return (
          unresolvedFindingIds.has(findingId ?? '') ||
          (result === 'fail' && !(outOfScopeResolvedFindingIds?.has(findingId ?? '') ?? false))
        );
      }
      return true;
    });
    if (failed) {
      return { outcome: 'fail' };
    }
    const carriedMinors: ReviewFindingRecord[] = [];
    for (const finding of findings) {
      if (!isMinorOrNitSeverity(severityOfFinding(finding))) {
        continue;
      }
      const findingId = findingIdOf(finding);
      if (findingId !== null && outOfScopeResolvedFindingIds?.has(findingId)) {
        continue;
      }
      carriedMinors.push(finding as unknown as ReviewFindingRecord);
    }
    return { outcome: 'pass', carriedMinors: Object.freeze(carriedMinors) };
  } catch {
    return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
  }
}

/**
 * Whether a receipt satisfies the acceptance review gate as the passing review
 * (§3.4, RV3): only receipts whose kind is absent or `code-review` count, and
 * the receipt's severity-derived outcome must be `pass` — a `pass` receipt
 * with no unresolved blocking finding, a `fail` receipt whose findings are all
 * `minor`/`nit` or resolved out-of-scope, and a fully dispositioned fail
 * alike. A receipt of another kind (e.g. `brief-check`) never satisfies the
 * gate on its own; an `unknown` receipt (including a 0-finding fail) never
 * does.
 */
export function satisfiesReviewPassGate(
  receipt: Pick<ReviewReceiptRecord, 'kind' | 'result'>,
): boolean {
  return reviewKindOf(receipt) === 'code-review' && decideReviewReceiptOutcome(receipt).outcome === 'pass';
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
 * dispositioned failing `code-review` (KF-33b3, RV3): like `satisfiesReviewPassGate`
 * for a `pass` — which under RV3 already covers a fail whose every finding is
 * resolved out-of-scope — a fully dispositioned failing `code-review` counts.
 * The kind rule is unchanged: a fully dispositioned failing `brief-check` (or
 * any non-`code-review` kind) never satisfies the gate on its own.
 */
export function satisfiesFullyDispositionedReviewPassGate(
  receipt: Pick<ReviewReceiptRecord, 'kind' | 'result' | 'findings'>,
  outOfScopeResolvedFindingIds: ReadonlySet<string>,
  unresolvedFindingIds: ReadonlySet<string>,
): boolean {
  return (
    reviewKindOf(receipt) === 'code-review' &&
    (satisfiesReviewPassGate(receipt) ||
      isFullyDispositioned(receipt, outOfScopeResolvedFindingIds, unresolvedFindingIds))
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
    // RV3: the tally reads the severity-derived outcome, so a minor-only fail
    // tallies in `passed` and a 0-finding fail tallies in `unknown`.
    const decision = decideReviewReceiptOutcome(receipt);
    if (decision.outcome === 'pass') {
      pass += 1;
    } else if (decision.outcome === 'fail') {
      fail += 1;
    } else {
      unknown += 1;
    }
  }
  return { pass, fail, unknown, disagreement: pass > 0 && fail > 0 };
}
