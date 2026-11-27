/**
 * Receipt carry across a base merge (plan #1385, U6): when the merge train
 * merges the base branch into a conducted Tier 2 pull request (strict
 * up-to-date ruleset), the PR head moves off the reviewed lane head. The
 * owner's pre-merge receipt stays bound to the reviewed head; this pure
 * qualifier decides whether the release may be carried to the new head.
 *
 * It carries only when the new head is the reviewed head plus a clean merge
 * of the base: a merge commit whose first parent is the reviewed head, whose
 * second parent is reachable from the base branch, whose tree is exactly the
 * clean automatic merge of those parents, whose PR-own changed paths equal
 * the lane's collected changed paths, and whose required CI is green. Every
 * unknown, malformed or hostile fact is a typed refusal, never a carry.
 * Pure: no I/O, no clock, no console.
 */

import { readBoundedDenseArray, readExactPlainRecord, snapshotPlainDataRecord } from './plain-record-reads.js';

const SHA_40 = /^[0-9a-f]{40}$/;
/** Changed-path lists above this refuse (never carry); a PR this wide gets a human look. */
export const RECEIPT_CARRY_MAX_PATHS = 5000;
const MAX_PARENTS = 16;
const MAX_TEXT = 256;
const MAX_PATH_CHARS = 4096;

/** Why the release was carried; one reason exists today. */
export type PremergeCarryReason = 'base-merge-clean';

export type ReceiptCarryRefusalReason =
  | 'invalid-input'
  | 'not-a-merge-commit'
  | 'first-parent-not-reviewed-head'
  | 'unknown-evidence'
  | 'second-parent-not-on-base'
  | 'conflict-resolved'
  | 'lane-authored-change'
  | 'ci-red'
  | 'ci-not-ready';

/** The auditable carry fact: recorded in the run journal on the carried head's premerge intent. */
export interface PremergeCarry {
  readonly attemptId: string;
  readonly fromHeadSha: string;
  readonly toHeadSha: string;
  /** The new head's second parent: the base commit that was merged in. */
  readonly mainParentSha: string;
  /** `git merge-base(fromHeadSha, mainParentSha)`: where the merged main range starts. */
  readonly mainRangeBaseSha: string;
  /** The PR's own changed paths at the new head (equal to the lane's collected paths). */
  readonly changedPaths: readonly string[];
  readonly decidedAtIso: string;
  readonly reason: PremergeCarryReason;
}

export type ReceiptCarryResult =
  | { readonly carry: true; readonly premergeCarry: PremergeCarry }
  | { readonly carry: false; readonly reason: ReceiptCarryRefusalReason };

const INPUT_KEYS = [
  'attemptId',
  'reviewedHeadSha',
  'newHeadSha',
  'newHeadParents',
  'secondParentOnBase',
  'mainRangeBaseSha',
  'automaticMergeTreeSha',
  'newHeadTreeSha',
  'prChangedPaths',
  'laneChangedPaths',
  'ci',
  'decidedAtIso',
] as const;

const INVALID: ReceiptCarryResult = Object.freeze({ carry: false, reason: 'invalid-input' });

function refuse(reason: ReceiptCarryRefusalReason): ReceiptCarryResult {
  return Object.freeze({ carry: false, reason });
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_40.test(value);
}

function isPlainText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}

/** A dense array of non-empty path strings, or null. Cost: bounded by `readBoundedDenseArray` plus one pass. */
function pathsOf(value: unknown): readonly string[] | null {
  const read = readBoundedDenseArray(value, RECEIPT_CARRY_MAX_PATHS);
  if (read === null) {
    return null;
  }
  for (const entry of read.array) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_PATH_CHARS) {
      return null;
    }
  }
  return read.array as readonly string[];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) {
    return false;
  }
  for (const entry of a) {
    if (!b.has(entry)) {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether the premerge release carries from `reviewedHeadSha` to
 * `newHeadSha`. `input` is untrusted: it is read through descriptors only
 * (`snapshotPlainDataRecord`, cost `O(own keys)`, the accepted engine bound)
 * inside `try/catch`; a getter, Proxy, hole, huge length or `__proto__` key
 * refuses `invalid-input`. `null` evidence fields (the evidence port could not
 * answer) refuse `unknown-evidence`, which the caller treats as "wait".
 */
export function qualifyBaseMergeCarry(input: unknown): ReceiptCarryResult {
  try {
    const snapshot = snapshotPlainDataRecord(input);
    if (snapshot === null) {
      return INVALID;
    }
    const keys = Object.keys(snapshot);
    if (keys.length !== INPUT_KEYS.length || !INPUT_KEYS.every((key) => Object.hasOwn(snapshot, key))) {
      return INVALID;
    }
    const parentsRead = readBoundedDenseArray(snapshot.newHeadParents, MAX_PARENTS);
    const prPaths = snapshot.prChangedPaths === null ? null : pathsOf(snapshot.prChangedPaths);
    const lanePaths = pathsOf(snapshot.laneChangedPaths);
    const decidedAt = snapshot.decidedAtIso;
    if (
      !isPlainText(snapshot.attemptId) ||
      !isSha(snapshot.reviewedHeadSha) ||
      !isSha(snapshot.newHeadSha) ||
      parentsRead === null ||
      !parentsRead.array.every(isSha) ||
      (snapshot.secondParentOnBase !== null && typeof snapshot.secondParentOnBase !== 'boolean') ||
      (snapshot.mainRangeBaseSha !== null && !isSha(snapshot.mainRangeBaseSha)) ||
      (snapshot.automaticMergeTreeSha !== null && !isSha(snapshot.automaticMergeTreeSha)) ||
      !isSha(snapshot.newHeadTreeSha) ||
      (snapshot.prChangedPaths !== null && prPaths === null) ||
      lanePaths === null ||
      !['passed', 'failed', 'pending', 'unknown'].includes(snapshot.ci as string) ||
      typeof decidedAt !== 'string' ||
      Number.isNaN(Date.parse(decidedAt))
    ) {
      return INVALID;
    }
    const parents = parentsRead.array as readonly string[];
    // 1. A merge commit whose first parent is the reviewed head.
    if (parents.length !== 2) {
      return refuse('not-a-merge-commit');
    }
    if (parents[0] !== snapshot.reviewedHeadSha) {
      return refuse('first-parent-not-reviewed-head');
    }
    if (
      snapshot.secondParentOnBase === null ||
      snapshot.automaticMergeTreeSha === null ||
      snapshot.mainRangeBaseSha === null ||
      prPaths === null
    ) {
      return refuse('unknown-evidence');
    }
    // 1b. The merged-in parent is reachable from the base branch.
    if (snapshot.secondParentOnBase !== true) {
      return refuse('second-parent-not-on-base');
    }
    // A merge the author resolved by hand (or edited) is not the clean automatic merge.
    if (snapshot.automaticMergeTreeSha !== snapshot.newHeadTreeSha) {
      return refuse('conflict-resolved');
    }
    // 2. The PR's own changes are exactly what the lane collected.
    if (!sameSet(prPaths, lanePaths)) {
      return refuse('lane-authored-change');
    }
    // 3. Required CI on the new head.
    if (snapshot.ci === 'failed') {
      return refuse('ci-red');
    }
    if (snapshot.ci !== 'passed') {
      return refuse('ci-not-ready');
    }
    return Object.freeze({
      carry: true,
      premergeCarry: Object.freeze({
        attemptId: snapshot.attemptId,
        fromHeadSha: snapshot.reviewedHeadSha,
        toHeadSha: snapshot.newHeadSha,
        mainParentSha: parents[1] as string,
        mainRangeBaseSha: snapshot.mainRangeBaseSha,
        changedPaths: Object.freeze([...prPaths]),
        decidedAtIso: new Date(decidedAt).toISOString(),
        reason: 'base-merge-clean',
      }),
    });
  } catch {
    return INVALID;
  }
}

/** Whether a refusal is "not yet known" (wait) rather than a definitive no (park). */
export function receiptCarryRefusalIsTransient(reason: ReceiptCarryRefusalReason): boolean {
  return reason === 'unknown-evidence' || reason === 'invalid-input' || reason === 'ci-not-ready';
}

const CARRY_KEYS = [
  'attemptId',
  'fromHeadSha',
  'toHeadSha',
  'mainParentSha',
  'mainRangeBaseSha',
  'changedPaths',
  'decidedAtIso',
  'reason',
] as const;

/**
 * Read a stored carry record (journal entry) back as typed data; null on any
 * deviation. Exact keys, descriptor reads only, bounded path list.
 */
export function readPremergeCarry(value: unknown): PremergeCarry | null {
  try {
    const record = readExactPlainRecord(value, CARRY_KEYS);
    if (record === null) {
      return null;
    }
    const paths = pathsOf(record.changedPaths);
    if (
      !isPlainText(record.attemptId) ||
      !isSha(record.fromHeadSha) ||
      !isSha(record.toHeadSha) ||
      !isSha(record.mainParentSha) ||
      !isSha(record.mainRangeBaseSha) ||
      paths === null ||
      typeof record.decidedAtIso !== 'string' ||
      Number.isNaN(Date.parse(record.decidedAtIso)) ||
      record.reason !== 'base-merge-clean'
    ) {
      return null;
    }
    return Object.freeze({
      attemptId: record.attemptId,
      fromHeadSha: record.fromHeadSha,
      toHeadSha: record.toHeadSha,
      mainParentSha: record.mainParentSha,
      mainRangeBaseSha: record.mainRangeBaseSha,
      changedPaths: Object.freeze([...paths]),
      decidedAtIso: record.decidedAtIso,
      reason: 'base-merge-clean',
    });
  } catch {
    return null;
  }
}

/** True when `carry` carries exactly `fromHeadSha` to `toHeadSha`. Both shas must be full 40-hex. */
export function premergeCarryMatches(
  carry: PremergeCarry | null | undefined,
  fromHeadSha: string | null | undefined,
  toHeadSha: string | null | undefined,
): carry is PremergeCarry {
  return (
    carry !== null && carry !== undefined &&
    isSha(fromHeadSha) && isSha(toHeadSha) &&
    carry.fromHeadSha === fromHeadSha && carry.toHeadSha === toHeadSha
  );
}
