// Lane SH12a: S6' conformance of conducted runs over one shadow day, pure.
// Rules 2-5, merged-run selection and the floor live here. Rules 1 and 6
// are SH12b's: their codes and the inputs they read are defined and
// validated here, and neither rule is evaluated. Until SH12b lands, the
// success-path return is `unknown/rules-incomplete` and this function never
// returns `pass`. Pure: no filesystem, no subprocess, no clock. Never
// throws, never echoes an input value (codes and counts only). Every
// function is linear in the capped input or constant; the caps are
// `SHADOW_CONFORMANCE_MAX_RUNS`, `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`,
// `SHADOW_CONFORMANCE_MAX_SHELL_FACTS` and `SHADOW_CONFORMANCE_MAX_HOPS`.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { head12Of, parseLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';
import { readExactPlainRecord } from './plain-record-reads.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';

/** Conforming merged runs required across the trailing window D-2..D. */
export const SHADOW_CONFORMANCE_MIN_RUNS = 5;
/** Conforming Tier 1 merged runs required in that window. */
export const SHADOW_CONFORMANCE_MIN_TIER1 = 3;
/** Conforming Tier 2 merged runs required in that window. */
export const SHADOW_CONFORMANCE_MIN_TIER2 = 2;
/** Cap on `runs`. An over-cap list is refused before any element is read. */
export const SHADOW_CONFORMANCE_MAX_RUNS = 2_000;
/**
 * Cap on each per-run list (`journal` and `reviewReceipts`). An over-cap
 * list is refused before any element is read.
 */
export const SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN = 10_000;
/**
 * Cap on each shell-fact list (`merges`, `headMoves`,
 * `headMovesIncompleteFor`). An over-cap list is refused before any element
 * is read.
 */
export const SHADOW_CONFORMANCE_MAX_SHELL_FACTS = 200_000;
/**
 * Cap on the head-linkage walk. SH12b uses it; it lives here so the input
 * caps stay in one place. This unit does not walk hops.
 */
export const SHADOW_CONFORMANCE_MAX_HOPS = 32;

/**
 * Nonconformance codes in judgement order. This unit emits only codes 2-5
 * (`gate-not-passed` through `premerge-not-posted-before-merge`). Codes 1
 * and 6 are SH12b's and stay at 0 in `byCode` until that unit lands.
 */
export const SHADOW_NONCONFORMANCE_CODES = [
  'merged-head-unlinked',
  'gate-not-passed',
  'code-review-missing',
  'pre-merge-missing',
  'premerge-not-posted-before-merge',
  'stray-one-way-action',
] as const;
export type ShadowNonconformanceCode = (typeof SHADOW_NONCONFORMANCE_CODES)[number];

/** One journal entry as this evaluator reads it. Append order is the caller's. */
export interface ShadowConformanceJournalEntry {
  readonly kind: 'intent' | 'result' | 'conduct';
  readonly key: string | null;
  readonly recordedAtIso: string;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
  readonly state: string | null;
}

/**
 * One conducted run. `headOid` is the run's latest collected head.
 * `reviewReceipts` are the receipts of the latest attempt at that head.
 * `journal` is the run's entries in append order.
 */
export interface ShadowConformanceRun {
  readonly runId: string;
  readonly tier: 1 | 2;
  readonly pullRequest: number;
  readonly headOid: string;
  /** Receipts of the latest attempt at `headOid`. */
  readonly reviewReceipts: readonly {
    readonly kind: 'brief-check' | 'code-review' | 'pre-merge';
    readonly result: 'pending' | 'pass' | 'fail' | 'unknown' | 'not-applicable';
  }[];
  readonly journal: readonly ShadowConformanceJournalEntry[];
}

/** A shell-recorded merge of one pull request. */
export interface ShadowShellMerge {
  readonly pullRequest: number;
  readonly headOid: string;
  readonly atIso: string;
}

/** A shell-recorded head move for one pull request. Read by SH12b's rule 1. */
export interface ShadowShellHeadMove {
  readonly pullRequest: number;
  readonly fromHeadOid: string;
  readonly toHeadOid: string;
  readonly atIso: string;
}

/**
 * Facts for one shadow day. `headMovesIncompleteFor` lists pull requests
 * whose shell head move could not have its origin read (SH12b).
 */
export interface ShadowConformanceInput {
  readonly day: string;
  readonly runs: readonly ShadowConformanceRun[];
  readonly merges: readonly ShadowShellMerge[];
  readonly headMoves: readonly ShadowShellHeadMove[];
  readonly headMovesIncompleteFor: readonly number[];
}

/** The day's verdict plus counts. `byCode` always carries all six codes. */
export type ShadowConformanceEvaluation = ShadowCriterionEvaluation & {
  readonly mergedRuns: number;
  readonly conforming: number;
  readonly conformingTier1: number;
  readonly conformingTier2: number;
  readonly nonconformingOnDay: number;
  readonly byCode: Readonly<Record<ShadowNonconformanceCode, number>>;
};

type ReviewReceipt = ShadowConformanceRun['reviewReceipts'][number];
type ReviewKind = ReviewReceipt['kind'];
type ReviewResult = ReviewReceipt['result'];
type JournalKind = ShadowConformanceJournalEntry['kind'];

/** A rule's verdict: conforming, a code, or an unjudgeable `unknown-<reason>`. */
type RuleVerdict = ShadowNonconformanceCode | `unknown-${string}` | null;

interface RuleContext {
  readonly headMoves: readonly ShadowShellHeadMove[];
  readonly headMovesIncompleteFor: readonly number[];
  readonly windowStart: number;
  readonly dayStart: number;
  readonly windowEnd: number;
}

type RuleEvaluator = (
  run: ShadowConformanceRun,
  merge: ShadowShellMerge,
  context: RuleContext,
) => RuleVerdict;

interface Bounds {
  readonly windowStart: number;
  readonly dayStart: number;
  readonly windowEnd: number;
}

interface ParsedInput {
  readonly bounds: Bounds;
  readonly runs: readonly ShadowConformanceRun[];
  readonly merges: readonly ShadowShellMerge[];
  readonly headMoves: readonly ShadowShellHeadMove[];
  readonly headMovesIncompleteFor: readonly number[];
}

interface MergedRun {
  readonly run: ShadowConformanceRun;
  readonly merge: ShadowShellMerge;
}

type Selection =
  | { readonly kind: 'unknown'; readonly reason: 'merge-ambiguous' | 'pull-request-has-several-runs' }
  | { readonly kind: 'ok'; readonly runs: readonly MergedRun[] };

interface Counts {
  mergedRuns: number;
  conforming: number;
  conformingTier1: number;
  conformingTier2: number;
  nonconformingOnDay: number;
  byCode: Record<ShadowNonconformanceCode, number>;
}

interface Score {
  readonly counts: Counts;
  readonly dayCodes: readonly ShadowNonconformanceCode[];
  readonly unknownReason: string | null;
}

interface BoundedArray {
  readonly array: readonly unknown[];
  readonly length: number;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEAD_OID_PATTERN = /^[0-9a-f]{40}$/;
const MIN_DAY_YEAR = 2000;
const MAX_DAY_YEAR = 9999;
const MAX_JOURNAL_KEY_LENGTH = 256;
const MAX_JOURNAL_TOKEN_LENGTH = 64;

const INPUT_KEYS: readonly string[] = ['day', 'runs', 'merges', 'headMoves', 'headMovesIncompleteFor'];
const RUN_KEYS: readonly string[] = ['runId', 'tier', 'pullRequest', 'headOid', 'reviewReceipts', 'journal'];
const RECEIPT_KEYS: readonly string[] = ['kind', 'result'];
const JOURNAL_KEYS: readonly string[] = ['kind', 'key', 'recordedAtIso', 'outcome', 'reasonCode', 'state'];
const MERGE_KEYS: readonly string[] = ['pullRequest', 'headOid', 'atIso'];
const HEAD_MOVE_KEYS: readonly string[] = ['pullRequest', 'fromHeadOid', 'toHeadOid', 'atIso'];

const JOURNAL_KINDS: readonly JournalKind[] = ['intent', 'result', 'conduct'];
const REVIEW_KINDS: readonly ReviewKind[] = ['brief-check', 'code-review', 'pre-merge'];
const REVIEW_RESULTS: readonly ReviewResult[] = ['pending', 'pass', 'fail', 'unknown', 'not-applicable'];

/**
 * S6' over `{ day, runs, merges, headMoves, headMovesIncompleteFor }`.
 * Window W is `[D-2 00:00Z, D+1 00:00Z)` and day D is `[D 00:00Z, D+1 00:00Z)`,
 * both computed with `Date.UTC`. Cost: linear in the capped input. Each list
 * is capped by `SHADOW_CONFORMANCE_MAX_RUNS`,
 * `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN` or
 * `SHADOW_CONFORMANCE_MAX_SHELL_FACTS` (and `SHADOW_CONFORMANCE_MAX_HOPS`
 * bounds the linkage walk SH12b adds); an oversized, sparse or non-array
 * list is refused from its own `length` descriptor before any element is
 * read. Every value is read through its own property descriptor, so no
 * getter runs and a Proxy either is refused or yields the plain data's
 * result with no `get` trap. Never throws. Never echoes an input value.
 * Never returns `pass`: rules 1 and 6 are not evaluated, so a set that
 * clears rules 2-5 and the floor returns `unknown/rules-incomplete`.
 */
export function evaluateShadowConductedConformance(input: unknown): ShadowConformanceEvaluation {
  try {
    return judgeConformance(input);
  } catch {
    // A revoked Proxy, or a trap that throws, must become a typed refusal.
    return invalidInput();
  }
}

function judgeConformance(input: unknown): ShadowConformanceEvaluation {
  const parsed = readConformanceInput(input);
  if (parsed === null) return invalidInput();
  const selected = selectMergedRuns(parsed);
  if (selected.kind === 'unknown') return unknownResult(selected.reason);
  return verdictFor(scoreMerged(selected.runs, contextOf(parsed)));
}

function verdictFor(score: Score): ShadowConformanceEvaluation {
  if (score.unknownReason !== null) return conformanceResult('unknown', score.unknownReason, score.counts);
  const dayCode = earliestCode(score.dayCodes);
  if (dayCode !== null) return conformanceResult('fail', dayCode, score.counts);
  if (floorShort(score.counts)) return conformanceResult('fail', 'too-few-conforming-runs', score.counts);
  // Rules 1 and 6 are not in CONFORMANCE_RULES. SH12b replaces this return.
  return conformanceResult('unknown', 'rules-incomplete', score.counts);
}

function contextOf(parsed: ParsedInput): RuleContext {
  return {
    headMoves: parsed.headMoves,
    headMovesIncompleteFor: parsed.headMovesIncompleteFor,
    windowStart: parsed.bounds.windowStart,
    dayStart: parsed.bounds.dayStart,
    windowEnd: parsed.bounds.windowEnd,
  };
}

/** Half-open UTC bounds of D-2..D and of D. `Date.UTC` rolls month boundaries. */
function windowBounds(day: string): Bounds {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return {
    windowStart: Date.UTC(year, month - 1, date - 2),
    dayStart: Date.UTC(year, month - 1, date),
    windowEnd: Date.UTC(year, month - 1, date + 1),
  };
}

/** True when `iso` falls in `[start, end)`. Instants, so offsets compare equal. */
function inWindow(iso: string, start: number, end: number): boolean {
  const instant = Date.parse(iso);
  return instant >= start && instant < end;
}

function floorShort(counts: Counts): boolean {
  return (
    counts.conforming < SHADOW_CONFORMANCE_MIN_RUNS ||
    counts.conformingTier1 < SHADOW_CONFORMANCE_MIN_TIER1 ||
    counts.conformingTier2 < SHADOW_CONFORMANCE_MIN_TIER2
  );
}

function earliestCode(codes: readonly ShadowNonconformanceCode[]): ShadowNonconformanceCode | null {
  for (const code of SHADOW_NONCONFORMANCE_CODES) {
    if (codes.includes(code)) return code;
  }
  return null;
}

function selectMergedRuns(parsed: ParsedInput): Selection {
  const byPullRequest = mergesInWindow(parsed.merges, parsed.bounds);
  if (hasAmbiguousMerge(parsed.runs, byPullRequest)) {
    return { kind: 'unknown', reason: 'merge-ambiguous' };
  }
  return claimMergedRuns(parsed.runs, byPullRequest);
}

/** True when any run's pull request has more than one merge inside W. */
function hasAmbiguousMerge(
  runs: readonly ShadowConformanceRun[],
  byPullRequest: ReadonlyMap<number, readonly ShadowShellMerge[]>,
): boolean {
  for (const run of runs) {
    const found = byPullRequest.get(run.pullRequest);
    if (found !== undefined && found.length > 1) return true;
  }
  return false;
}

/** One in-window merge per run. A pull request claimed twice cannot be judged. */
function claimMergedRuns(
  runs: readonly ShadowConformanceRun[],
  byPullRequest: ReadonlyMap<number, readonly ShadowShellMerge[]>,
): Selection {
  const chosen: MergedRun[] = [];
  const seen = new Set<number>();
  for (const run of runs) {
    const claimed = claimOne(run, byPullRequest, seen);
    if (claimed === 'shared') return { kind: 'unknown', reason: 'pull-request-has-several-runs' };
    if (claimed !== null) chosen.push(claimed);
  }
  return { kind: 'ok', runs: chosen };
}

function claimOne(
  run: ShadowConformanceRun,
  byPullRequest: ReadonlyMap<number, readonly ShadowShellMerge[]>,
  seen: Set<number>,
): MergedRun | 'shared' | null {
  const found = byPullRequest.get(run.pullRequest);
  if (found === undefined || found.length !== 1) return null;
  if (seen.has(run.pullRequest)) return 'shared';
  const merge = found[0];
  if (merge === undefined) return null;
  seen.add(run.pullRequest);
  return { run, merge };
}

/** In-window merges grouped by pull request. Cost: linear in the capped merge list. */
function mergesInWindow(merges: readonly ShadowShellMerge[], bounds: Bounds): Map<number, ShadowShellMerge[]> {
  const byPullRequest = new Map<number, ShadowShellMerge[]>();
  for (const merge of merges) {
    if (!inWindow(merge.atIso, bounds.windowStart, bounds.windowEnd)) continue;
    const existing = byPullRequest.get(merge.pullRequest);
    if (existing === undefined) byPullRequest.set(merge.pullRequest, [merge]);
    else existing.push(merge);
  }
  return byPullRequest;
}

function scoreMerged(merged: readonly MergedRun[], context: RuleContext): Score {
  const counts = zeroCounts();
  counts.mergedRuns = merged.length;
  const dayCodes: ShadowNonconformanceCode[] = [];
  let unknownReason: string | null = null;
  for (const item of merged) {
    unknownReason = noteVerdict(item, context, counts, dayCodes, unknownReason);
  }
  return { counts, dayCodes, unknownReason };
}

function noteVerdict(
  item: MergedRun,
  context: RuleContext,
  counts: Counts,
  dayCodes: ShadowNonconformanceCode[],
  unknownReason: string | null,
): string | null {
  const verdict = firstVerdict(item.run, item.merge, context);
  if (verdict === null) {
    noteConforming(counts, item.run.tier);
    return unknownReason;
  }
  if (isUnknownVerdict(verdict)) return unknownReason ?? unknownReasonOf(verdict);
  noteNonconforming(counts, dayCodes, verdict, item.merge.atIso, context);
  return unknownReason;
}

function noteConforming(counts: Counts, tier: 1 | 2): void {
  counts.conforming += 1;
  if (tier === 1) counts.conformingTier1 += 1;
  else counts.conformingTier2 += 1;
}

function noteNonconforming(
  counts: Counts,
  dayCodes: ShadowNonconformanceCode[],
  code: ShadowNonconformanceCode,
  atIso: string,
  context: RuleContext,
): void {
  counts.byCode[code] += 1;
  if (!inWindow(atIso, context.dayStart, context.windowEnd)) return;
  counts.nonconformingOnDay += 1;
  dayCodes.push(code);
}

function firstVerdict(run: ShadowConformanceRun, merge: ShadowShellMerge, context: RuleContext): RuleVerdict {
  for (const rule of CONFORMANCE_RULES) {
    const verdict = rule(run, merge, context);
    if (verdict !== null) return verdict;
  }
  return null;
}

function isUnknownVerdict(verdict: RuleVerdict): verdict is `unknown-${string}` {
  return typeof verdict === 'string' && verdict.startsWith('unknown-');
}

/** The reason token of an `unknown-<reason>` rule verdict. Never an input echo. */
function unknownReasonOf(verdict: `unknown-${string}`): string {
  const reason = verdict.slice('unknown-'.length);
  return reason.length > 0 ? reason : 'invalid-input';
}

/**
 * Rules 2-5 in `SHADOW_NONCONFORMANCE_CODES` order. SH12b inserts rule 1
 * (`merged-head-unlinked`) at the front and rule 6 (`stray-one-way-action`)
 * at the end. A rule returns null when the run conforms on it, its code
 * when it does not, or `unknown-<reason>` when it cannot be judged.
 */
const CONFORMANCE_RULES: readonly RuleEvaluator[] = [ruleGate, ruleCodeReview, rulePreMerge, rulePremergePosted];

/** Rule 2. A passed gate at this head also proves the diff check was clean. */
function ruleGate(run: ShadowConformanceRun, _merge: ShadowShellMerge, _context: RuleContext): RuleVerdict {
  const head12 = head12Of(run.headOid);
  for (const entry of run.journal) {
    if (isGatePassed(entry, head12)) return null;
  }
  return 'gate-not-passed';
}

/** Rule 3. Some code-review receipt passed. */
function ruleCodeReview(run: ShadowConformanceRun, _merge: ShadowShellMerge, _context: RuleContext): RuleVerdict {
  if (hasPassingReceipt(run, 'code-review')) return null;
  return 'code-review-missing';
}

/** Rule 4. Tier 2 only: some pre-merge receipt passed. Tier 1 skips this rule. */
function rulePreMerge(run: ShadowConformanceRun, _merge: ShadowShellMerge, _context: RuleContext): RuleVerdict {
  if (run.tier !== 2) return null;
  if (hasPassingReceipt(run, 'pre-merge')) return null;
  return 'pre-merge-missing';
}

/** Rule 5. A premerge success at this head was posted strictly before the merge. */
function rulePremergePosted(run: ShadowConformanceRun, merge: ShadowShellMerge, _context: RuleContext): RuleVerdict {
  const head12 = head12Of(run.headOid);
  for (const entry of run.journal) {
    if (isPremergeBefore(entry, head12, merge.atIso)) return null;
  }
  return 'premerge-not-posted-before-merge';
}

function hasPassingReceipt(run: ShadowConformanceRun, kind: ReviewKind): boolean {
  for (const receipt of run.reviewReceipts) {
    if (receipt.kind === kind && receipt.result === 'pass') return true;
  }
  return false;
}

function isGatePassed(entry: ShadowConformanceJournalEntry, head12: string | null): boolean {
  if (head12 === null || !isCompleted(entry, 'gate-passed')) return false;
  return gateHead12(entry.key) === head12;
}

function isPremergeBefore(entry: ShadowConformanceJournalEntry, head12: string | null, mergeAtIso: string): boolean {
  if (head12 === null || !isCompleted(entry, 'premerge-success')) return false;
  if (premergeHead12(entry.key) !== head12) return false;
  return Date.parse(entry.recordedAtIso) < Date.parse(mergeAtIso);
}

function isCompleted(entry: ShadowConformanceJournalEntry, reasonCode: string): boolean {
  return entry.kind === 'result' && entry.outcome === 'completed' && entry.reasonCode === reasonCode;
}

function gateHead12(key: string | null): string | null {
  const parsed = parseLaneRunKey(key);
  if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'gate') return null;
  return parsed.head12;
}

function premergeHead12(key: string | null): string | null {
  const parsed = parseLaneRunKey(key);
  if (parsed === null || parsed.kind !== 'premerge') return null;
  return parsed.head12;
}

/**
 * The whole input, or null. List caps are applied before any element read.
 * Cost: linear in the capped input.
 */
function readConformanceInput(raw: unknown): ParsedInput | null {
  const record = readExactPlainRecord(raw, INPUT_KEYS);
  if (record === null) return null;
  const day = readDay(record.day);
  if (day === null) return null;
  const lists = readInputLists(record);
  if (lists === null) return null;
  return { bounds: windowBounds(day), ...lists };
}

function readInputLists(record: Record<string, unknown>): Omit<ParsedInput, 'bounds'> | null {
  const runs = readCapped(record.runs, SHADOW_CONFORMANCE_MAX_RUNS, readRun);
  const merges = readCapped(record.merges, SHADOW_CONFORMANCE_MAX_SHELL_FACTS, readMerge);
  const headMoves = readCapped(record.headMoves, SHADOW_CONFORMANCE_MAX_SHELL_FACTS, readHeadMove);
  const headMovesIncompleteFor = readCapped(
    record.headMovesIncompleteFor,
    SHADOW_CONFORMANCE_MAX_SHELL_FACTS,
    readPullRequest,
  );
  if (runs === null || merges === null || headMoves === null || headMovesIncompleteFor === null) return null;
  return { runs, merges, headMoves, headMovesIncompleteFor };
}

function readRun(raw: unknown): ShadowConformanceRun | null {
  const record = readExactPlainRecord(raw, RUN_KEYS);
  if (record === null) return null;
  const identity = readRunIdentity(record);
  if (identity === null) return null;
  const lists = readRunLists(record);
  if (lists === null) return null;
  return { ...identity, ...lists };
}

function readRunIdentity(
  record: Record<string, unknown>,
): Pick<ShadowConformanceRun, 'runId' | 'tier' | 'pullRequest' | 'headOid'> | null {
  const runId = readRunId(record.runId);
  const tier = readTier(record.tier);
  const pullRequest = readPullRequest(record.pullRequest);
  const headOid = readHeadOid(record.headOid);
  if (runId === null || tier === null || pullRequest === null || headOid === null) return null;
  return { runId, tier, pullRequest, headOid };
}

function readRunLists(
  record: Record<string, unknown>,
): Pick<ShadowConformanceRun, 'reviewReceipts' | 'journal'> | null {
  const reviewReceipts = readCapped(record.reviewReceipts, SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN, readReceipt);
  const journal = readCapped(record.journal, SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN, readJournalEntry);
  if (reviewReceipts === null || journal === null) return null;
  return { reviewReceipts, journal };
}

function readReceipt(raw: unknown): ReviewReceipt | null {
  const record = readExactPlainRecord(raw, RECEIPT_KEYS);
  if (record === null) return null;
  if (!isReviewKind(record.kind) || !isReviewResult(record.result)) return null;
  return { kind: record.kind, result: record.result };
}

function readJournalEntry(raw: unknown): ShadowConformanceJournalEntry | null {
  const record = readExactPlainRecord(raw, JOURNAL_KEYS);
  if (record === null) return null;
  return journalFrom(record);
}

function journalFrom(record: Record<string, unknown>): ShadowConformanceJournalEntry | null {
  const kind = readJournalKind(record.kind);
  const key = readNullableString(record.key, MAX_JOURNAL_KEY_LENGTH);
  const recordedAtIso = readIso(record.recordedAtIso);
  const outcome = readNullableString(record.outcome, MAX_JOURNAL_TOKEN_LENGTH);
  const reasonCode = readNullableString(record.reasonCode, MAX_JOURNAL_TOKEN_LENGTH);
  const state = readNullableString(record.state, MAX_JOURNAL_TOKEN_LENGTH);
  if (kind === null || recordedAtIso === null) return null;
  if (key === undefined || outcome === undefined || reasonCode === undefined || state === undefined) return null;
  return { kind, key, recordedAtIso, outcome, reasonCode, state };
}

function readMerge(raw: unknown): ShadowShellMerge | null {
  const record = readExactPlainRecord(raw, MERGE_KEYS);
  if (record === null) return null;
  const pullRequest = readPullRequest(record.pullRequest);
  const headOid = readHeadOid(record.headOid);
  const atIso = readIso(record.atIso);
  if (pullRequest === null || headOid === null || atIso === null) return null;
  return { pullRequest, headOid, atIso };
}

function readHeadMove(raw: unknown): ShadowShellHeadMove | null {
  const record = readExactPlainRecord(raw, HEAD_MOVE_KEYS);
  if (record === null) return null;
  const pullRequest = readPullRequest(record.pullRequest);
  const fromHeadOid = readHeadOid(record.fromHeadOid);
  const toHeadOid = readHeadOid(record.toHeadOid);
  const atIso = readIso(record.atIso);
  if (pullRequest === null || fromHeadOid === null || toHeadOid === null || atIso === null) return null;
  return { pullRequest, fromHeadOid, toHeadOid, atIso };
}

/** A real UTC day `YYYY-MM-DD` in 2000-9999, or null. Cost: constant. */
function readDay(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  if (year < MIN_DAY_YEAR || year > MAX_DAY_YEAR) return null;
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function readRunId(value: unknown): string | null {
  if (typeof value !== 'string' || !LANE_RUN_ID_PATTERN.test(value)) return null;
  return value;
}

function readTier(value: unknown): 1 | 2 | null {
  if (value === 1 || value === 2) return value;
  return null;
}

function readPullRequest(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function readHeadOid(value: unknown): string | null {
  if (typeof value !== 'string' || !HEAD_OID_PATTERN.test(value)) return null;
  return value;
}

function readIso(value: unknown): string | null {
  if (!isZonedIsoDateTime(value)) return null;
  return value;
}

/** `null` when the value is null, the string when it fits, `undefined` when it is neither. */
function readNullableString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && value.length <= maxLength) return value;
  return undefined;
}

function readJournalKind(value: unknown): JournalKind | null {
  if (isJournalKind(value)) return value;
  return null;
}

function isJournalKind(value: unknown): value is JournalKind {
  return JOURNAL_KINDS.includes(value as JournalKind);
}

function isReviewKind(value: unknown): value is ReviewKind {
  return REVIEW_KINDS.includes(value as ReviewKind);
}

function isReviewResult(value: unknown): value is ReviewResult {
  return REVIEW_RESULTS.includes(value as ReviewResult);
}

/**
 * A dense array whose length is within `cap`, or null. Cost: constant before
 * the element loop — the length descriptor is read first, and an over-cap
 * length returns before `Object.keys` or any element. No getter and no
 * Proxy `get` trap runs.
 */
function readCapped<T>(value: unknown, cap: number, readOne: (raw: unknown) => T | null): readonly T[] | null {
  const bounded = boundedArray(value, cap);
  if (bounded === null) return null;
  const items: T[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const item = readOne(ownElement(bounded.array, index));
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function boundedArray(value: unknown, cap: number): BoundedArray | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = ownLength(value, cap);
  if (length === null) return null;
  if (Object.keys(value).length !== length) return null;
  return { array: value as readonly unknown[], length };
}

/** The array's own data `length` when it is an in-cap safe integer; otherwise null. */
function ownLength(value: object, cap: number): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!isCappedLength(descriptor, cap)) return null;
  return descriptor.value;
}

function isCappedLength(descriptor: PropertyDescriptor | undefined, cap: number): descriptor is { value: number } {
  return (
    descriptor !== undefined &&
    descriptor.get === undefined &&
    typeof descriptor.value === 'number' &&
    Number.isSafeInteger(descriptor.value) &&
    descriptor.value >= 0 &&
    descriptor.value <= cap
  );
}

/** The own data-property element at `index`. A hole or an accessor reads as undefined. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function conformanceResult(
  status: ShadowCriterionEvaluation['status'],
  reason: string,
  counts: Counts,
): ShadowConformanceEvaluation {
  return Object.freeze({
    status,
    reason,
    mergedRuns: counts.mergedRuns,
    conforming: counts.conforming,
    conformingTier1: counts.conformingTier1,
    conformingTier2: counts.conformingTier2,
    nonconformingOnDay: counts.nonconformingOnDay,
    byCode: Object.freeze({ ...counts.byCode }),
  });
}

function invalidInput(): ShadowConformanceEvaluation {
  return conformanceResult('unknown', 'invalid-input', zeroCounts());
}

function unknownResult(reason: string): ShadowConformanceEvaluation {
  return conformanceResult('unknown', reason, zeroCounts());
}

function zeroCounts(): Counts {
  return {
    mergedRuns: 0,
    conforming: 0,
    conformingTier1: 0,
    conformingTier2: 0,
    nonconformingOnDay: 0,
    byCode: emptyByCode(),
  };
}

function emptyByCode(): Record<ShadowNonconformanceCode, number> {
  const byCode = {
    'merged-head-unlinked': 0,
    'gate-not-passed': 0,
    'code-review-missing': 0,
    'pre-merge-missing': 0,
    'premerge-not-posted-before-merge': 0,
    'stray-one-way-action': 0,
  };
  return byCode;
}
