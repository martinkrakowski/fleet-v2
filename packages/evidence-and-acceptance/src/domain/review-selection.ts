/**
 * Independent review selection (plan §3.2): among the receipts that are
 * independent and read-only for a head, the latest receipt per reviewer model
 * and review kind decides — the last one recorded in the assessment's
 * append-only `reviewReceipts`, never by `completedAtIso`. Recording order
 * wins, and agreement between reviewers never strengthens a result.
 */

import type { ReceiptSubject, ReviewKind, ReviewFindingRecord, ReviewReceiptRecord, ReviewUnknownReason } from './evidence-records.js';
import { attemptIdForBrief, attemptIdForChain, receiptSubjectOf, REVIEW_UNKNOWN_REASONS } from './evidence-records.js';

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

/**
 * Diff facts about the candidate a receipt reviewed (owner decision D3): the
 * total changed lines (insertions plus deletions) and the repo-relative POSIX
 * file paths the diff touches.
 */
export interface ReviewDiffFacts {
  readonly changedLines: number;
  readonly files: readonly string[];
}

/**
 * A diff at or above this many changed lines is large (D3). A zero-finding
 * `pass` on a large diff touching pure domain code or a protected path reads
 * as `unknown`; under the threshold a zero-finding `pass` stays `pass`.
 */
export const ZERO_FINDING_PASS_DIFF_LINE_THRESHOLD = 200;

/** ASCII-only lowercasing, identical to `LC_ALL=C` shell comparisons. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Whether a path carries a `node_modules/` segment. */
function isUnderNodeModules(path: string): boolean {
  return /(^|\/)node_modules\//.test(asciiLower(path));
}

/** Root directories protected by `lane-diff-check`'s fixed rules. */
const PROTECTED_ROOT_DIRECTORIES = [
  '\\.git/',
  '\\.github/',
  '\\.gemini/',
  '\\.agents/',
  '\\.agy/',
  '\\.lane/',
  '\\.architecture/',
  'bin/',
  'scripts/',
  'deploy/',
  'installation/',
  '\\.yarn/plugins/',
  '\\.yarn/releases/',
  '\\.yarn/patches/',
  '\\.yarn/sdks/',
  '\\.husky/',
];

/** Any-depth directories protected by `lane-diff-check`'s fixed rules. */
const PROTECTED_ANY_DEPTH_DIRECTORIES = [
  '\\.claude/',
  '\\.opencode/',
  '\\.cursor/',
  '\\.vscode/',
  '\\.devcontainer/',
  '\\.mise/',
  '\\.windsurf/',
  '\\.roo/',
  '\\.idea/',
  '\\.zed/',
  '\\.claude-plugin/',
];

/** Root files protected by `lane-diff-check`'s fixed rules. */
const PROTECTED_ROOT_FILES = [
  'Dockerfile',
  'Makefile',
  'makefile',
  'GNUmakefile',
  '\\.envrc',
  'pnpm-workspace\\.yaml',
];

/** Any-depth files protected by `lane-diff-check`'s fixed rules. */
const PROTECTED_ANY_DEPTH_FILES = [
  'package\\.json',
  '\\.yarnrc',
  '\\.yarnrc\\.yml',
  '\\.npmrc',
  'yarn\\.lock',
  'package-lock\\.json',
  'pnpm-lock\\.yaml',
  'CLAUDE\\.md',
  'CLAUDE\\.local\\.md',
  'AGENTS\\.md',
  'GEMINI\\.md',
  '\\.mcp\\.json',
  '\\.cursorrules',
  '\\.windsurfrules',
  '\\.github/copilot-instructions\\.md',
  '\\.gitattributes',
  '\\.gitmodules',
  'mise\\.toml',
  '\\.mise\\.toml',
  '\\.tool-versions',
  '\\.aider\\.conf\\.yml',
  '\\.dir-locals\\.el',
  '\\.pnpmfile\\.cjs',
  'turbo\\.json',
];

const ROOT_DIRECTORY_PATTERN = new RegExp(`^(?:${PROTECTED_ROOT_DIRECTORIES.join('|')})`);
const ANY_DEPTH_DIRECTORY_PATTERN = new RegExp(`(?:^|/)(?:${PROTECTED_ANY_DEPTH_DIRECTORIES.join('|')})`);
const ROOT_FILE_PATTERN = new RegExp(`^(?:${asciiLower(PROTECTED_ROOT_FILES.join('|'))})$`);
const ROOT_PREFIX_PATTERN = /^\.pnp\./;
const ANY_DEPTH_FILE_PATTERN = new RegExp(`(?:^|/)(?:${asciiLower(PROTECTED_ANY_DEPTH_FILES.join('|'))})$`);
const ANY_DEPTH_PREFIX_PATTERN = /(?:^|\/)(?:opencode\.json|\.clinerules)/;

/**
 * Whether a normalized (leading `./` stripped) repo-relative POSIX path
 * matches a `lane-diff-check` protected rule. Mirrors the fixed rule table
 * locally rather than importing `@fleet/work-execution`, whose dependency
 * direction (`work-execution -> evidence-and-acceptance`) an import would
 * reverse. The `package.json` rule alone does not apply under `node_modules/`;
 * every other protected rule still matches a path under `node_modules/`.
 */
function isProtectedDiffPath(normalizedPath: string): boolean {
  const lowered = asciiLower(normalizedPath);
  if (
    ROOT_DIRECTORY_PATTERN.test(lowered) ||
    ANY_DEPTH_DIRECTORY_PATTERN.test(lowered) ||
    ROOT_FILE_PATTERN.test(lowered) ||
    ROOT_PREFIX_PATTERN.test(lowered) ||
    ANY_DEPTH_PREFIX_PATTERN.test(lowered)
  ) {
    return true;
  }
  if (!ANY_DEPTH_FILE_PATTERN.test(lowered)) {
    return false;
  }
  return !(lowered.endsWith('package.json') && isUnderNodeModules(normalizedPath));
}

/**
 * Whether a normalized repo-relative path is pure domain source: a file under
 * a package's `src/domain/` that is not under `node_modules/`, not inside a
 * `__tests__/` directory, and not a test or spec file.
 */
function isPureDomainPath(normalizedPath: string): boolean {
  if (isUnderNodeModules(normalizedPath) || normalizedPath.includes('/__tests__/')) {
    return false;
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalizedPath)) {
    return false;
  }
  return /^packages\/[^/]+\/src\/domain\/.+\.[cm]?[jt]sx?$/i.test(normalizedPath);
}

/**
 * Whether the diff facts (hostile-input safe: never throws) describe a large
 * diff (at least `ZERO_FINDING_PASS_DIFF_LINE_THRESHOLD` changed lines)
 * touching pure domain code or a protected path. Malformed values read as
 * `false`.
 */
function requiresNonZeroFindingReview(diffFacts: unknown): boolean {
  try {
    if (!isPlainRecordObject(diffFacts)) {
      return false;
    }
    const changedLines = ownProp(diffFacts, 'changedLines');
    if (
      typeof changedLines !== 'number' ||
      !Number.isSafeInteger(changedLines) ||
      changedLines < ZERO_FINDING_PASS_DIFF_LINE_THRESHOLD
    ) {
      return false;
    }
    const files = ownProp(diffFacts, 'files');
    if (!Array.isArray(files)) {
      return false;
    }
    let relevant = false;
    for (let index = 0; index < files.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(files, index);
      if (descriptor === undefined || typeof descriptor.value !== 'string') {
        return false;
      }
      const normalized = descriptor.value.replace(/^(?:\.\/)+/, '');
      if (isPureDomainPath(normalized) || isProtectedDiffPath(normalized)) {
        relevant = true;
      }
    }
    return relevant;
  } catch {
    return false;
  }
}

const SEVERITY_VALUES: readonly string[] = ['blocker', 'major', 'minor', 'nit'];
/** Every declared cause token, including the CB7 per-label ones. */
const UNKNOWN_REASON_VALUES: readonly string[] = REVIEW_UNKNOWN_REASONS;

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
 * - `unknown` (`unparseable-verdict`) also when a `pass` receipt carries zero
 *   findings and `diffFacts` shows a large diff (at least
 *   `ZERO_FINDING_PASS_DIFF_LINE_THRESHOLD` changed lines) touching pure
 *   domain code or a `lane-diff-check` protected path (owner decision D3): a
 *   clean review of such a diff must be confirmed by another round on a
 *   different reviewer seat. When `diffFacts` is omitted or malformed the
 *   check is bypassed and the receipt evaluates exactly as before.
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
  diffFacts?: ReviewDiffFacts,
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
    if (result === 'pass' && findings.length === 0 && requiresNonZeroFindingReview(diffFacts)) {
      return { outcome: 'unknown', unknownReason: 'unparseable-verdict' };
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
 * Whether a receipt is about an attempt, read through own data properties only
 * (no getter runs, never throws — a `Proxy` trap that throws on
 * `getOwnPropertyDescriptor` reads as `false`). A receipt whose `attemptId`
 * starts with `chain:`/`brief:`, or whose subject is present and not of the
 * `attempt` kind, is a chain or brief receipt, never an attempt one. A receipt
 * without a subject is the legacy attempt shape and counts when its
 * `attemptId` is not a pseudo chain/brief id.
 *
 * Cost bound: the function reads exactly two own property descriptors
 * (`attemptId`, `subject`) and never walks the record, so it is O(1) whatever
 * the input's size; `receiptSubjectOf` reads a fixed field set the same way.
 */
export function isAttemptReceiptSubject(receipt: unknown): boolean {
  try {
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
      return false;
    }
    const record = receipt as Record<string, unknown>;
    if (Object.getOwnPropertyDescriptor(record, '__proto__') !== undefined) {
      return false;
    }
    const attemptDescriptor = Object.getOwnPropertyDescriptor(record, 'attemptId');
    if (attemptDescriptor !== undefined && !('value' in attemptDescriptor)) {
      return false;
    }
    if (typeof attemptDescriptor?.value === 'string') {
      const attemptId = attemptDescriptor.value;
      if (attemptId.startsWith('chain:') || attemptId.startsWith('brief:')) {
        return false;
      }
    }
    const subjectDescriptor = Object.getOwnPropertyDescriptor(record, 'subject');
    if (subjectDescriptor !== undefined && !('value' in subjectDescriptor)) {
      return false;
    }
    if (subjectDescriptor?.value !== undefined) {
      return receiptSubjectOf(record)?.kind === 'attempt';
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a receipt satisfies the acceptance review gate as the passing review
 * (§3.4, RV3): only receipts whose kind is absent or `code-review` count, and
 * only receipts that are about an attempt — a `brief-verify` or `chain`
 * receipt (or any receipt whose subject is not the attempt) never satisfies
 * the gate, whatever its kind. The receipt's severity-derived outcome must be
 * `pass` — a `pass` receipt with no unresolved blocking finding, a `fail`
 * receipt whose findings are all `minor`/`nit` or resolved out-of-scope, and a
 * fully dispositioned fail alike. A receipt of another kind (e.g.
 * `brief-check`) never satisfies the gate on its own; an `unknown` receipt
 * (including a 0-finding fail) never does.
 */
export function satisfiesReviewPassGate(
  receipt: Pick<ReviewReceiptRecord, 'kind' | 'result'>,
): boolean {
  return (
    reviewKindOf(receipt) === 'code-review' &&
    isAttemptReceiptSubject(receipt) &&
    decideReviewReceiptOutcome(receipt).outcome === 'pass'
  );
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
 * The kind and subject rules are unchanged: a fully dispositioned failing
 * `brief-check` (or any non-`code-review` kind), and a `brief-verify` or
 * `chain` receipt (or any receipt whose subject is not the attempt) never
 * satisfy the gate on their own.
 */
export function satisfiesFullyDispositionedReviewPassGate(
  receipt: Pick<ReviewReceiptRecord, 'kind' | 'result' | 'findings'>,
  outOfScopeResolvedFindingIds: ReadonlySet<string>,
  unresolvedFindingIds: ReadonlySet<string>,
): boolean {
  return (
    reviewKindOf(receipt) === 'code-review' &&
    isAttemptReceiptSubject(receipt) &&
    (satisfiesReviewPassGate(receipt) ||
      isFullyDispositioned(receipt, outOfScopeResolvedFindingIds, unresolvedFindingIds))
  );
}

/**
 * The attempt id a receipt subject stands for: the attempt's own id, or the
 * pseudo attempt id of the chain or the brief it names. Null when the subject
 * lacks the field of its kind.
 */
function attemptIdOfSubject(subject: ReceiptSubject): string | null {
  if (subject.kind === 'attempt') {
    return subject.attemptId;
  }
  if (subject.kind === 'chain') {
    return subject.chainName === null ? null : attemptIdForChain(subject.projectId, subject.chainName);
  }
  return subject.briefPackageDigest === null
    ? null
    : attemptIdForBrief(subject.projectId, subject.briefPackageDigest);
}

/**
 * Whether a stored receipt is about the assessment that holds it (CO18a7a):
 * the receipt's own `assessmentId`, `projectId` and `attemptId` equal the
 * assessment's, and
 * its subject (`receiptSubjectOf`; an absent subject reads as the receipt's
 * own attempt) names the same project and stands for the same attempt id. A
 * receipt about another attempt, chain or brief is not evidence for this
 * assessment: it never counts and never replaces a receipt that does.
 *
 * Reads own data properties only (no getter runs) and never throws: anything
 * unreadable, malformed or of an unknown subject kind is `false`.
 */
export function isReceiptAboutAssessment(receipt: unknown, assessment: unknown): boolean {
  try {
    const projectId = ownProp(assessment, 'projectId');
    const attemptId = ownProp(assessment, 'attemptId');
    if (typeof projectId !== 'string' || typeof attemptId !== 'string' || attemptId.length === 0) {
      return false;
    }
    const assessmentId = ownProp(assessment, 'id');
    if (
      ownProp(receipt, 'assessmentId') !== assessmentId ||
      ownProp(receipt, 'projectId') !== projectId ||
      ownProp(receipt, 'attemptId') !== attemptId
    ) {
      return false;
    }
    const subject = receiptSubjectOf(receipt as { readonly subject?: unknown });
    if (subject === null || subject.projectId !== projectId) {
      return false;
    }
    return attemptIdOfSubject(subject) === attemptId;
  } catch {
    return false;
  }
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
