// Lane SH12a/SH12b: S6' conformance of conducted runs over one shadow day,
// pure. Rules 1-6, merged-run selection and the floor live here. Pure: no
// filesystem, no subprocess, no clock. Never throws, never echoes an input
// value (codes and counts only). Every function is linear in the capped
// input or constant; the caps are `SHADOW_CONFORMANCE_MAX_RUNS`,
// `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`,
// `SHADOW_CONFORMANCE_MAX_SHELL_FACTS` and `SHADOW_CONFORMANCE_MAX_HOPS`.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { head12Of, parseLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN, LANE_RUN_ONE_WAY_STEPS } from './lane-run-records.js';
import { readExactPlainRecord, readBoundedDenseArray, readOwnDataElement } from './plain-record-reads.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { LANE_RUN_STATES } from './value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';

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
 * Cap on the head-linkage walk (rule 1). A path of more than this many head
 * moves does not link. The walk stops after this many hops, so a cycle
 * cannot run unbounded. Cost: constant.
 */
export const SHADOW_CONFORMANCE_MAX_HOPS = 32;

/**
 * Nonconformance codes in judgement order. Rule 1 emits
 * `merged-head-unlinked`, rules 2-5 the four codes between them, and rule 6
 * `stray-one-way-action`.
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

type OneWayStep = (typeof LANE_RUN_ONE_WAY_STEPS)[number];

/** `prepare` and `dispatch` are issued from the same four states. */
const READY_FAMILY_STATES: readonly LaneRunStateValue[] = Object.freeze([
  'ready',
  'dispatching',
  'seat-failed',
  'fixing',
]);

/**
 * States from which a `park` step may be issued: every `LANE_RUN_STATES`
 * value except `merged`, `stopped` and `parked`. Cost: constant.
 */
const PARK_ISSUE_STATES: readonly LaneRunStateValue[] = Object.freeze(
  LANE_RUN_STATES.filter((state) => state !== 'merged' && state !== 'stopped' && state !== 'parked'),
);

/**
 * States from which each one-way step may be issued, keyed by
 * `LANE_RUN_ONE_WAY_STEPS`. Frozen, including each row. Cost: constant; the
 * table does not read the capped input.
 */
export const SHADOW_ONE_WAY_STEP_STATES: {
  readonly [Step in OneWayStep]: readonly LaneRunStateValue[];
} = Object.freeze({
  prepare: READY_FAMILY_STATES,
  dispatch: READY_FAMILY_STATES,
  'open-pr': Object.freeze(['opening-pr'] as const satisfies readonly LaneRunStateValue[]),
  push: Object.freeze(['pushing'] as const satisfies readonly LaneRunStateValue[]),
  merge: Object.freeze(['merging'] as const satisfies readonly LaneRunStateValue[]),
  park: PARK_ISSUE_STATES,
});

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

/** A shell-recorded head move for one pull request. Rule 1 walks these. */
export interface ShadowShellHeadMove {
  readonly pullRequest: number;
  readonly fromHeadOid: string;
  readonly toHeadOid: string;
  readonly atIso: string;
}

/**
 * Facts for one shadow day. `headMovesIncompleteFor` lists pull requests
 * whose shell head-move origin could not be read. Rule 1 returns unknown
 * for one of those pull requests only when no linkage path exists.
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
  /** Built once so rule 1 stays linear in the capped head-move list. */
  readonly headMovesByPullRequest: ReadonlyMap<number, ShadowShellHeadMove[]>;
  readonly incompletePullRequests: ReadonlySet<number>;
  readonly windowStart: number;
  readonly dayStart: number;
  readonly windowEnd: number;
}

interface HopStep {
  readonly reached: boolean;
  readonly frontier: readonly string[];
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
 * both computed with `Date.UTC`. Cost: an `O(1)` length/prototype pre-gate,
 * then the accepted `O(K)` engine bound of `Reflect.ownKeys` (where `K` is
 * the target's own-property count), then `O(cap)` element traversal. Each
 * list is capped by `SHADOW_CONFORMANCE_MAX_RUNS`,
 * `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN` or
 * `SHADOW_CONFORMANCE_MAX_SHELL_FACTS`, and rule 1's walk is bounded by
 * `SHADOW_CONFORMANCE_MAX_HOPS`. An oversized, sparse, accessor-carrying,
 * non-enumerable-index, symbol-keyed, foreign-keyed, subclassed or
 * non-array list is refused from its own `length` descriptor and prototype
 * before any element is read.
 * Every value is read through its own property descriptor, so no getter
 * runs and a Proxy either is refused or yields the plain data's result
 * with no `get` trap. Never throws. Never echoes an input value. A set
 * that clears every rule and the floor returns `pass/conducted-runs-conform`.
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
  return conformanceResult('pass', 'conducted-runs-conform', score.counts);
}

/**
 * Builds the rule context. Cost: linear in `headMoves` and
 * `headMovesIncompleteFor`, each capped by
 * `SHADOW_CONFORMANCE_MAX_SHELL_FACTS`: it groups the capped head moves and
 * builds a set from the capped incomplete list.
 */
function contextOf(parsed: ParsedInput): RuleContext {
  return {
    headMoves: parsed.headMoves,
    headMovesIncompleteFor: parsed.headMovesIncompleteFor,
    headMovesByPullRequest: groupHeadMoves(parsed.headMoves),
    incompletePullRequests: new Set(parsed.headMovesIncompleteFor),
    windowStart: parsed.bounds.windowStart,
    dayStart: parsed.bounds.dayStart,
    windowEnd: parsed.bounds.windowEnd,
  };
}

/**
 * Head moves grouped by pull request. Cost: linear in `headMoves`, capped
 * by `SHADOW_CONFORMANCE_MAX_SHELL_FACTS`.
 */
function groupHeadMoves(headMoves: readonly ShadowShellHeadMove[]): Map<number, ShadowShellHeadMove[]> {
  const byPullRequest = new Map<number, ShadowShellHeadMove[]>();
  for (const move of headMoves) {
    const existing = byPullRequest.get(move.pullRequest);
    if (existing === undefined) byPullRequest.set(move.pullRequest, [move]);
    else existing.push(move);
  }
  return byPullRequest;
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
 * Rules 1-6 in `SHADOW_NONCONFORMANCE_CODES` order. A rule returns null when
 * the run conforms on it, its code when it does not, or `unknown-<reason>`
 * when it cannot be judged. Cost: each rule is linear in one capped list.
 */
const CONFORMANCE_RULES: readonly RuleEvaluator[] = [
  ruleHeadLinkage,
  ruleGate,
  ruleCodeReview,
  rulePreMerge,
  rulePremergePosted,
  ruleOneWayDiscipline,
];

/**
 * Rule 1. The merged head equals the run head, or a breadth-first path of
 * at most `SHADOW_CONFORMANCE_MAX_HOPS` same-pull-request head moves, each
 * at or before the merge instant, reaches it. A cycle is not a path. No
 * such path and the pull request listed in `headMovesIncompleteFor` yields
 * `unknown-head-moves-incomplete`; no path otherwise yields
 * `merged-head-unlinked`. Cost: linear in that pull request's head moves
 * (capped by `SHADOW_CONFORMANCE_MAX_SHELL_FACTS`); the walk takes at most
 * `SHADOW_CONFORMANCE_MAX_HOPS` hops.
 */
function ruleHeadLinkage(run: ShadowConformanceRun, merge: ShadowShellMerge, context: RuleContext): RuleVerdict {
  if (merge.headOid === run.headOid || linkedWithinHops(run, merge, context)) return null;
  if (context.incompletePullRequests.has(run.pullRequest)) return 'unknown-head-moves-incomplete';
  return 'merged-head-unlinked';
}

/**
 * True when a bounded breadth-first path links the run head to the merge head.
 * Cost: linear in the capped head moves (`SHADOW_CONFORMANCE_MAX_SHELL_FACTS`)
 * and bounded by `SHADOW_CONFORMANCE_MAX_HOPS` hops.
 */
function linkedWithinHops(run: ShadowConformanceRun, merge: ShadowShellMerge, context: RuleContext): boolean {
  const moves = context.headMovesByPullRequest.get(run.pullRequest);
  if (moves === undefined) return false;
  return walkHops(edgesBefore(moves, merge.atIso), run.headOid, merge.headOid);
}

/**
 * Edges whose instant is at or before the merge. Cost: linear in `moves`,
 * which is capped by `SHADOW_CONFORMANCE_MAX_SHELL_FACTS`.
 */
function edgesBefore(moves: readonly ShadowShellHeadMove[], mergeAtIso: string): Map<string, string[]> {
  const mergeInstant = Date.parse(mergeAtIso);
  const edges = new Map<string, string[]>();
  for (const move of moves) {
    if (Date.parse(move.atIso) > mergeInstant) continue;
    appendEdge(edges, move.fromHeadOid, move.toHeadOid);
  }
  return edges;
}

/** Cost: constant. */
function appendEdge(edges: Map<string, string[]>, from: string, to: string): void {
  const next = edges.get(from);
  if (next === undefined) edges.set(from, [to]);
  else next.push(to);
}

/**
 * Breadth-first reachability. `seen` makes a cycle not a path. Cost: linear
 * in the edge list and at most `SHADOW_CONFORMANCE_MAX_HOPS` hops.
 */
function walkHops(edges: ReadonlyMap<string, string[]>, start: string, target: string): boolean {
  const seen = new Set<string>([start]);
  let frontier: readonly string[] = [start];
  for (let hop = 0; hop < SHADOW_CONFORMANCE_MAX_HOPS && frontier.length > 0; hop += 1) {
    const step = nextHop(frontier, edges, seen, target);
    if (step.reached) return true;
    frontier = step.frontier;
  }
  return false;
}

/** One breadth-first hop. Cost: linear in the frontier's outgoing edges. */
function nextHop(
  frontier: readonly string[],
  edges: ReadonlyMap<string, string[]>,
  seen: Set<string>,
  target: string,
): HopStep {
  const next: string[] = [];
  for (const node of frontier) {
    if (enqueueUnseen(edges.get(node), seen, next, target)) return { reached: true, frontier: next };
  }
  return { reached: false, frontier: next };
}

/**
 * Enqueue destinations not yet seen. Reaching `target` stops the walk.
 * Cost: linear in `destinations`.
 */
function enqueueUnseen(
  destinations: readonly string[] | undefined,
  seen: Set<string>,
  next: string[],
  target: string,
): boolean {
  if (destinations === undefined) return false;
  for (const destination of destinations) {
    if (destination === target) return true;
    if (seen.has(destination)) continue;
    seen.add(destination);
    next.push(destination);
  }
  return false;
}

/**
 * Rule 6. Walk the journal in append order. The state is `ready` before any
 * conduct entry, then each conduct entry's `state`. An intent whose key
 * parses as a one-way step is stray when that step is not `park` and the
 * key was already issued, or when the current state is outside
 * `SHADOW_ONE_WAY_STEP_STATES` for the step (`park` included). `park` is
 * dropped from the duplicate check: its key is `<run>/r<round>/park/<seat>`
 * with no ordinal, so two legitimate parks in one round share a key. There
 * is no `step: 'park'` in non-test source on origin/main, so nothing is
 * lost. An unparseable key is ignored. Cost: linear in the journal, capped
 * by `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`.
 */
function ruleOneWayDiscipline(
  run: ShadowConformanceRun,
  _merge: ShadowShellMerge,
  _context: RuleContext,
): RuleVerdict {
  if (hasStrayOneWay(run.journal)) return 'stray-one-way-action';
  return null;
}

/** Cost: linear in `journal`, capped by `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`. */
function hasStrayOneWay(journal: readonly ShadowConformanceJournalEntry[]): boolean {
  const seen = new Set<string>();
  let state: string | null = 'ready';
  for (const entry of journal) {
    if (strayIntent(entry, state, seen)) return true;
    if (entry.kind === 'conduct') state = entry.state;
  }
  return false;
}

/** Cost: constant aside from the key parse, which is linear in the capped key. */
function strayIntent(entry: ShadowConformanceJournalEntry, state: string | null, seen: Set<string>): boolean {
  if (entry.kind !== 'intent') return false;
  const step = oneWayStep(entry.key);
  if (step === null) return false;
  if (step !== 'park' && repeatedKey(entry.key, seen)) return true;
  return !stateAllows(step, state);
}

/** A parsed one-way step, or null when the key is not one. Cost: linear in the key. */
function oneWayStep(key: string | null): OneWayStep | null {
  const parsed = parseLaneRunKey(key);
  if (parsed === null || parsed.kind !== 'step') return null;
  return oneWayOf(parsed.step);
}

/** Cost: constant (`LANE_RUN_ONE_WAY_STEPS` is a fixed list). */
function oneWayOf(step: string): OneWayStep | null {
  for (const candidate of LANE_RUN_ONE_WAY_STEPS) {
    if (candidate === step) return candidate;
  }
  return null;
}

/** True on the second sight of `key`. The first sight is recorded. Cost: constant. */
function repeatedKey(key: string | null, seen: Set<string>): boolean {
  if (key === null) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/** Cost: constant (each row of `SHADOW_ONE_WAY_STEP_STATES` is a fixed list). */
function stateAllows(step: OneWayStep, state: string | null): boolean {
  if (state === null) return false;
  const allowed: readonly string[] = SHADOW_ONE_WAY_STEP_STATES[step];
  return allowed.includes(state);
}

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
 * A dense array whose length is within `cap`, or null. Cost: an `O(1)`
 * length/prototype pre-gate, then the accepted `O(K)` engine bound of
 * `Reflect.ownKeys` (where `K` is the target's own-property count), then
 * `O(cap)` element traversal — the length descriptor is read first, and an
 * over-cap length returns before any key enumeration or element. No getter
 * and no Proxy `get` trap runs.
 */
function readCapped<T>(value: unknown, cap: number, readOne: (raw: unknown) => T | null): readonly T[] | null {
  const bounded = readBoundedDenseArray(value, cap);
  if (bounded === null) return null;
  const items: T[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const item = readOne(readOwnDataElement(bounded.array, index));
    if (item === null) return null;
    items.push(item);
  }
  return items;
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
