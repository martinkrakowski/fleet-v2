// Lane SH5a: the S1 (merge set of a shadow day) evaluator, pure over one
// UTC day's worth of already-collected facts: the shell train's events and
// the fleet merge pass's journaled results. Pure: no filesystem, no
// subprocess, no clock. Never throws, never echoes an input value; every
// exported function takes `unknown` at its boundary and returns a typed
// evaluation whose refusal carries a named reason code.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { isCalendarDateTime } from './plain-record-reads.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { MERGE_KEY_ONE_WAY_ACTIONS, head12Of, parseLaneRunKey } from './lane-run-keys.js';
import { compareShadowMergeSets } from './shadow-comparators.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { SHELL_DETAIL_CODES, SHELL_TRAIN_EVENT_KINDS } from './shell-train-events.js';
import type { ShellTrainEvent } from './shell-train-events.js';
import { readBoundedDenseArray, readExactPlainRecord, snapshotPlainDataRecord } from './plain-record-reads.js';
import {
  SHADOW_CONFORMANCE_MAX_RUNS,
  SHADOW_CONFORMANCE_MAX_SHELL_FACTS,
  createShadowRunConformanceContext,
  dedupeRunsByRunId,
  evaluateRunS6WithContext,
  readPullRequest,
  readShadowConformanceRunDetailed,
  readShadowHeadMove,
} from './shadow-day-conformance.js';
import type { ShadowConformanceRun, ShadowShellHeadMove, ShadowShellMerge } from './shadow-day-conformance.js';

/**
 * How far past either midnight boundary a shell merge or fleet would-merge
 * may fall and still belong to day D: a merge train running at 23:59:55
 * journals its fleet counterpart just after 00:00:00 the next day, and the
 * pair must still be compared. Both ends of the day window are widened by
 * this much.
 */
export const SHADOW_DAY_BOUNDARY_GRACE_MS = 600_000;

/** A sanity cap on how many events, results or entries one evaluator walks before refusing as unevaluable. */
export const SHADOW_MERGE_SET_MAX_ITEMS = 100_000;

/** At most this many per-criterion divergence diagnostics ride on an evaluation as non-digested observability. */
export const SHADOW_DIVERGENCE_DIAGNOSTICS_MAX = 20;

/**
 * One non-digested divergence diagnostic. Every field is read from values an
 * evaluator has already validated, so this type adds no untrusted-input
 * boundary: `pr` is a positive safe integer, `head12` the 12-hex prefix of a
 * validated 40/64-hex commit id, `side` the side the divergence is on, and
 * `code` an evaluator's own divergence code.
 */
export interface ShadowDivergenceDiagnosticItem {
  readonly pr: number;
  readonly head12: string;
  readonly side: 'fleet' | 'shell';
  readonly code: string;
}

/**
 * A criterion's non-digested divergence diagnostics: the full divergence
 * count (the same number the criterion already counted) plus at most
 * `SHADOW_DIVERGENCE_DIAGNOSTICS_MAX` deterministically sorted items. Never
 * part of any verdict digest; never echoes a free-text or secret-shaped
 * value — `code` is an evaluator's own fixed code.
 */
export interface ShadowDivergenceDetails {
  readonly totalCount: number;
  readonly items: readonly ShadowDivergenceDiagnosticItem[];
}

/** Deterministic diagnostic order: by pull request, then head, side and code. */
export function sortDivergenceDiagnosticItems(
  items: readonly ShadowDivergenceDiagnosticItem[],
): readonly ShadowDivergenceDiagnosticItem[] {
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return items
    .slice()
    .sort((a, b) => a.pr - b.pr || compare(a.head12, b.head12) || compare(a.side, b.side) || compare(a.code, b.code))
    .slice(0, SHADOW_DIVERGENCE_DIAGNOSTICS_MAX);
}

/** Freezes the bounded, sorted diagnostic payload a criterion attaches when its divergence count is positive. */
export function divergenceDetailsOf(
  totalCount: number,
  items: readonly ShadowDivergenceDiagnosticItem[],
): ShadowDivergenceDetails {
  return Object.freeze({ totalCount, items: Object.freeze(sortDivergenceDiagnosticItems(items).slice()) });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHELL_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const REPO_DIGEST_PATTERN = /^[0-9a-f]{12}$/;
const SHELL_EVENT_KEYS: readonly string[] = ['line', 'atIso', 'kind', 'outcome', 'pullRequest', 'headOid', 'detailCode', 'fromHeadOid'];
const SHELL_INPUT_KEYS: readonly string[] = ['events', 'unknownLines'];
const FLEET_INPUT_KEYS: readonly string[] = ['results', 'entries'];
const FLEET_RESULT_KEYS: readonly string[] = ['key', 'outcome', 'reasonCode', 'recordedAtIso'];
const FLEET_ENTRY_KEYS: readonly string[] = ['pullRequest', 'headOid'];
const INPUT_KEYS: readonly string[] = ['day', 'repoDigest', 'excludeBatchMerges', 'shell', 'fleet'];

/** The evaluation every caller of this unit receives, with the day's counts attached. */
export type ShadowDayMergeSetEvaluation = ShadowCriterionEvaluation & {
  readonly mergesCompared: number;
  readonly excludedBatchMerges: number;
  readonly compared: number;
  readonly divergences: number;
  /**
   * Non-digested diagnostics, present only when `divergences` is positive:
   * the same divergence count plus at most
   * `SHADOW_DIVERGENCE_DIAGNOSTICS_MAX` parsed per-divergence items.
   * Malformed divergence keys stay counted in `divergences` but are omitted
   * from `items`. Never part of any verdict digest.
   */
  readonly divergenceDetails?: ShadowDivergenceDetails;
};

interface ShellMergeItem { readonly pullRequest: number; readonly headOid: string; readonly atIso: string; }
interface FleetMergeItem { readonly pullRequest: number; readonly headOid: string; readonly recordedAtIso: string; }

function evaluation(
  status: ShadowCriterionEvaluation,
  merges: number,
  excluded: number,
  compared: number,
  divergences: number,
  divergenceDetails?: ShadowDivergenceDetails,
): ShadowDayMergeSetEvaluation {
  return Object.freeze({
    status: status.status,
    reason: status.reason,
    mergesCompared: merges,
    excludedBatchMerges: excluded,
    compared,
    divergences,
    ...(divergenceDetails === undefined ? {} : { divergenceDetails }),
  });
}

const INVALID = (): ShadowDayMergeSetEvaluation => evaluation({ status: 'unknown', reason: 'invalid-input' }, 0, 0, 0, 0);

/**
 * A real, dense array within `SHADOW_MERGE_SET_MAX_ITEMS` as a fresh dense
 * copy, or null for any stand-in. Delegates to the shared
 * `readBoundedDenseArray`: an `O(1)` length/prototype pre-gate, the accepted
 * `O(K)` engine bound of the single `Reflect.ownKeys` call (K = the target's
 * own-property count) that rejects foreign named, symbol and non-enumerable
 * keys, then an `O(cap)` per-index descriptor traversal over
 * `SHADOW_MERGE_SET_MAX_ITEMS`. Symbol keys and non-enumerable extra keys —
 * which the previous `Object.keys` count ignored — are now refused, and an
 * accessor element refuses the whole list before any element reader runs.
 * The returned `array` is a fresh dense copy this module created, so plain
 * indexed reads on it can never run a getter or a Proxy `get` trap.
 */
function boundedArray(value: unknown, cap: number): readonly unknown[] | null {
  const read = readBoundedDenseArray(value, cap);
  return read === null ? null : read.array;
}

/** A real UTC calendar day `YYYY-MM-DD`, or null. */
function readUtcDay(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    return null;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return value;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One shell train event record as this evaluator reads it, or null when out of shape. */
export function readShellEvent(raw: unknown): ShellTrainEvent | null {
  try {
    return readShellEventRecord(raw);
  } catch {
    return null;
  }
}

/** The body of `readShellEvent`; a hostile trap throwing here is caught by the wrapper. */
function readShellEventRecord(raw: unknown): ShellTrainEvent | null {
  const record = readExactPlainRecord(raw, SHELL_EVENT_KEYS);
  if (record === null) {
    return null;
  }
  const { line, atIso, kind, outcome, pullRequest, headOid, detailCode, fromHeadOid } = record;
  if (!isCount(line) || typeof atIso !== 'string' || !SHELL_AT_PATTERN.test(atIso) || !isCalendarDateTime(atIso)) {
    return null;
  }
  if (typeof kind !== 'string' || !(SHELL_TRAIN_EVENT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof outcome !== 'string' || outcome.length === 0) {
    return null;
  }
  if (pullRequest !== null && (!isCount(pullRequest) || pullRequest === 0)) {
    return null;
  }
  if (headOid !== null && !isMergeHex40(headOid)) {
    return null;
  }
  if (typeof detailCode !== 'string' || !(SHELL_DETAIL_CODES as readonly string[]).includes(detailCode)) {
    return null;
  }
  if (fromHeadOid !== null && !isMergeHex40(fromHeadOid)) {
    return null;
  }
  return record as unknown as ShellTrainEvent;
}

/** One fleet journal result record, or null when out of shape. */
function readFleetResult(raw: unknown): Record<string, unknown> | null {
  const record = readExactPlainRecord(raw, FLEET_RESULT_KEYS);
  if (record === null) {
    return null;
  }
  if (
    typeof record.key !== 'string' ||
    typeof record.outcome !== 'string' ||
    typeof record.reasonCode !== 'string' ||
    typeof record.recordedAtIso !== 'string' ||
    !isZonedIsoDateTime(record.recordedAtIso)
  ) {
    return null;
  }
  return record;
}

/** One fleet head record, or null when out of shape. */
function readFleetEntry(raw: unknown): { readonly pullRequest: number; readonly headOid: string } | null {
  const record = readExactPlainRecord(raw, FLEET_ENTRY_KEYS);
  if (record === null) {
    return null;
  }
  const headOid = head12Of(record.headOid);
  if (!isCount(record.pullRequest) || record.pullRequest === 0 || headOid === null) {
    return null;
  }
  return { pullRequest: record.pullRequest, headOid: record.headOid as string };
}

/**
 * The exact instant an accepted ISO-8601 timestamp names, in nanoseconds
 * since the epoch, or null when the string does not match the accepted
 * shape. `Date.parse` keeps only whole milliseconds, so two stamps that
 * differ past the millisecond — e.g. `...T10:00:00Z` and
 * `...T10:00:00.000000001Z` — compare equal through it although the fleet
 * row is later; this parser keeps up to nine fractional digits and the
 * written offset exact, so the ordering verdict below reads the true
 * instant. Inputs are already shape- and calendar-validated at the
 * boundary, so null is a defensive fallback only.
 */
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function instantNanos(iso: string): bigint | null {
  const match = INSTANT_PATTERN.exec(iso);
  if (match === null) {
    return null;
  }
  const [, year, month, dayOfMonth, hour, minute, second, fraction, offset] = match;
  const dayMs = Date.UTC(Number(year), Number(month) - 1, Number(dayOfMonth));
  if (Number.isNaN(dayMs)) {
    return null;
  }
  // Date.UTC returns a whole-day instant with a zero time, so this division is exact.
  let seconds = BigInt(dayMs / 1000) + BigInt(Number(hour)) * 3600n + BigInt(Number(minute)) * 60n + BigInt(Number(second));
  if (offset !== 'Z') {
    const magnitude = BigInt(Number(offset.slice(1, 3))) * 3600n + BigInt(Number(offset.slice(4, 6))) * 60n;
    seconds -= offset[0] === '-' ? -magnitude : magnitude;
  }
  const nanos = fraction === undefined ? 0n : BigInt(fraction.padEnd(9, '0'));
  return seconds * 1_000_000_000n + nanos;
}

/** An instant in nanoseconds floored to its whole second (toward negative infinity). */
function floorToSecond(nanos: bigint): bigint {
  const rem = nanos % 1_000_000_000n;
  return rem < 0n ? nanos - rem - 1_000_000_000n : nanos - rem;
}

/** The exact instant as nanoseconds, falling back to millisecond precision for a defensively unmatched shape. */
function exactOrMillis(iso: string): bigint {
  const exact = instantNanos(iso);
  if (exact !== null) {
    return exact;
  }
  const ms = Date.parse(iso);
  return BigInt(Number.isNaN(ms) ? 0 : ms) * 1_000_000n;
}

/** Whether the instant `iso` names falls inside the half-open window `[start, end)`. */
function inWindow(iso: string, start: number, end: number): boolean {
  const instant = new Date(iso).getTime();
  return instant >= start && instant < end;
}

/**
 * Whether the instant the ISO string names falls on UTC day `day` — read off
 * the instant itself, never off the written date: a zoned time whose offset
 * carries it across midnight belongs to the day its instant falls on, and
 * the grace margin is not the day.
 */
function inDay(iso: string, day: string): boolean {
  const instant = new Date(iso);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === day;
}

/**
 * The batch PRs whose own `batch`/`opened` event exists anywhere in the shell
 * log — deliberately with NO day-window filter on the opened event, because a
 * batch opened before the window still owns merges inside it. Matched on PR
 * number alone, never on `(pullRequest, headOid)`: `update-branch` can move a
 * batch PR's head between its opening and its merge.
 */
function batchOpenedPullRequests(events: readonly ShellTrainEvent[]): Set<number> {
  const pullRequests = new Set<number>();
  for (const event of events) {
    if (event.kind === 'batch' && event.outcome === 'opened' && event.pullRequest !== null) {
      pullRequests.add(event.pullRequest);
    }
  }
  return pullRequests;
}

/**
 * The shell side of the merge set: every `result` event with outcome
 * `merged` and a non-null head, inside the day window; when
 * `excludeBatchMerges` is true, batch-member merges and the own merges of
 * batch-opened PRs are dropped and counted separately, with each dropped
 * merge's `(pullRequest, headOid)` pair recorded so the fleet side can drop
 * its matching rows too. `mergesCompared` counts the kept merges whose own
 * time falls inside day D itself — the value the later 20-merge floor
 * consumes.
 */
function shellSet(events: readonly ShellTrainEvent[], day: string, start: number, end: number, excludeBatchMerges: boolean): {
  readonly items: readonly ShellMergeItem[];
  readonly excludedBatchMerges: number;
  readonly excludedPullRequests: ReadonlySet<number>;
  readonly mergesCompared: number;
} {
  const items: ShellMergeItem[] = [];
  const excludedPullRequests = new Set<number>();
  let excludedBatchMerges = 0;
  let mergesCompared = 0;
  const batchPullRequests = excludeBatchMerges ? batchOpenedPullRequests(events) : new Set<number>();
  for (const event of events) {
    if (event.kind !== 'result' || event.outcome !== 'merged' || event.headOid === null) {
      continue;
    }
    if (!inWindow(event.atIso, start, end)) {
      continue;
    }
    if (excludeBatchMerges && (event.detailCode === 'batch-member' || (event.pullRequest !== null && batchPullRequests.has(event.pullRequest)))) {
      excludedBatchMerges += 1;
      if (event.pullRequest !== null) {
        excludedPullRequests.add(event.pullRequest);
      }
      continue;
    }
    if (inDay(event.atIso, day)) {
      mergesCompared += 1;
    }
    items.push({ pullRequest: event.pullRequest ?? 0, headOid: event.headOid, atIso: event.atIso });
  }
  return { items, excludedBatchMerges, excludedPullRequests, mergesCompared };
}

/** Whether a result's key is a one-way merge key belonging to this repo. */
function isOneWayMergeKeyFor(key: string, repoDigest: string): boolean {
  const parsed = parseLaneRunKey(key);
  return parsed !== null
    && parsed.kind === 'merge'
    && parsed.repoDigest === repoDigest
    && (MERGE_KEY_ONE_WAY_ACTIONS as readonly string[]).includes(parsed.action);
}

/**
 * S1, the merge set of one shadow day, over
 * `{ day, repoDigest, excludeBatchMerges, shell, fleet }`. Cost: linear in
 * the capped input — at most `SHADOW_MERGE_SET_MAX_ITEMS` events, results
 * and entries each are walked. Each array read pays the accepted engine
 * bound of `readBoundedDenseArray`: an `O(1)` length/prototype pre-gate,
 * `O(K)` in the target's own-property count K for the single
 * `Reflect.ownKeys` call, then `O(cap)` element traversal — so an oversized,
 * sparse, extra-keyed or accessor-backed array is refused before any
 * element is traversed. Every
 * value is read through its own property descriptor, so no getter ever runs
 * and a Proxy stand-in yields exactly the verdict of the data its own
 * reflection reports. Never throws, never echoes the input.
 */
export function evaluateShadowMergeSet(input: unknown): ShadowDayMergeSetEvaluation {
  try {
    return judgeShadowMergeSet(input);
  } catch {
    // A revoked Proxy, or one whose getPrototypeOf/ownKeys/descriptor trap
    // throws, can make even the descriptor readers throw; the never-throws
    // contract turns that into a typed refusal.
    return INVALID();
  }
}

interface ParsedMergeSetSnapshot {
  readonly kind: 'ok';
  readonly day: string;
  readonly repoDigest: string;
  readonly excludeBatchMerges: boolean;
  readonly shellEvents: readonly ShellTrainEvent[];
  readonly fleetResults: readonly Record<string, unknown>[];
  readonly fleetEntries: readonly { pullRequest: number; headOid: string }[];
}

type ParsedMergeSetInput = ParsedMergeSetSnapshot | { readonly kind: 'invalid' } | { readonly kind: 'shell-incomplete' };

const INVALID_PARSE: ParsedMergeSetInput = { kind: 'invalid' };
const SHELL_INCOMPLETE_PARSE: ParsedMergeSetInput = { kind: 'shell-incomplete' };

/** Every `events` element read through `readShellEvent`, or null at the first one out of shape. */
function collectShellEvents(events: readonly unknown[]): readonly ShellTrainEvent[] | null {
  const shellEvents: ShellTrainEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = readShellEvent(events[index]);
    if (event === null) {
      return null;
    }
    shellEvents.push(event);
  }
  return shellEvents;
}

/** Every `results` element read through `readFleetResult`, or null at the first one out of shape. */
function collectFleetResults(results: readonly unknown[]): readonly Record<string, unknown>[] | null {
  const fleetResults: Record<string, unknown>[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = readFleetResult(results[index]);
    if (result === null) {
      return null;
    }
    fleetResults.push(result);
  }
  return fleetResults;
}

/** Every `entries` element read through `readFleetEntry`, or null at the first one out of shape. */
function collectFleetEntries(entries: readonly unknown[]): readonly { pullRequest: number; headOid: string }[] | null {
  const fleetEntries: { pullRequest: number; headOid: string }[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = readFleetEntry(entries[index]);
    if (entry === null) {
      return null;
    }
    fleetEntries.push(entry);
  }
  return fleetEntries;
}

/**
 * The whole `{ day, repoDigest, excludeBatchMerges, shell, fleet }` snapshot,
 * validated and read down to typed arrays, or the refusal it reads as:
 * `'invalid'` for anything structurally wrong, `'shell-incomplete'` only once
 * `shell.unknownLines` is confirmed to be a genuine non-negative safe integer
 * greater than zero. The type is checked before the value: a malformed
 * `unknownLines` (a string, a negative number, a fraction) is `'invalid'`,
 * never `'shell-incomplete'` — that reason means specifically "the count is a
 * valid number greater than zero," not "the field has the wrong shape."
 */
function parseMergeSetInput(input: unknown): ParsedMergeSetInput {
  const snapshot = readExactPlainRecord(input, INPUT_KEYS);
  if (snapshot === null) {
    return INVALID_PARSE;
  }
  const day = readUtcDay(snapshot.day);
  const repoDigest = snapshot.repoDigest;
  if (day === null || typeof repoDigest !== 'string' || !REPO_DIGEST_PATTERN.test(repoDigest)) {
    return INVALID_PARSE;
  }
  if (typeof snapshot.excludeBatchMerges !== 'boolean') {
    return INVALID_PARSE;
  }
  const excludeBatchMerges = snapshot.excludeBatchMerges;
  const shell = readExactPlainRecord(snapshot.shell, SHELL_INPUT_KEYS);
  const fleet = readExactPlainRecord(snapshot.fleet, FLEET_INPUT_KEYS);
  if (shell === null || fleet === null) {
    return INVALID_PARSE;
  }
  const events = boundedArray(shell.events, SHADOW_MERGE_SET_MAX_ITEMS);
  const results = boundedArray(fleet.results, SHADOW_MERGE_SET_MAX_ITEMS);
  const entries = boundedArray(fleet.entries, SHADOW_MERGE_SET_MAX_ITEMS);
  if (events === null || results === null || entries === null) {
    return INVALID_PARSE;
  }
  const shellEvents = collectShellEvents(events);
  if (shellEvents === null) {
    return INVALID_PARSE;
  }
  const unknownLines = shell.unknownLines;
  if (!isCount(unknownLines)) {
    return INVALID_PARSE;
  }
  // An incomplete shell record is never evidence either way.
  if (unknownLines > 0) {
    return SHELL_INCOMPLETE_PARSE;
  }
  const fleetResults = collectFleetResults(results);
  if (fleetResults === null) {
    return INVALID_PARSE;
  }
  const fleetEntries = collectFleetEntries(entries);
  if (fleetEntries === null) {
    return INVALID_PARSE;
  }
  return { kind: 'ok', day, repoDigest, excludeBatchMerges, shellEvents, fleetResults, fleetEntries };
}

/**
 * Whether any fleet result is a live one-way action during shadow day `day`
 * (DT §4.3(1)): a blocking divergence, checked before the set comparison
 * below even runs.
 */
function hasLiveActionInShadow(fleetResults: readonly Record<string, unknown>[], repoDigest: string, day: string): boolean {
  for (const result of fleetResults) {
    const key = result.key as string;
    if (
      isOneWayMergeKeyFor(key, repoDigest)
      && inDay(result.recordedAtIso as string, day)
      && result.outcome !== 'dry-run'
    ) {
      return true;
    }
  }
  return false;
}

/** The comparator's verdict over an already-resolved fleet set and the shell set, plus the day's counts. */
function judgeComparison(
  fleetItems: readonly FleetMergeItem[],
  shellItems: { readonly items: readonly ShellMergeItem[]; readonly excludedBatchMerges: number; readonly mergesCompared: number },
  day: string,
): ShadowDayMergeSetEvaluation {
  // Temporal ordering on top of the set comparison: a fleet would-merge only
  // counts for a shell merge it was recorded at or before. The shell train
  // stamps whole seconds while the fleet stamps finer, so the FLEET instant is
  // floored to the whole second before it is compared with the shell merge's
  // own stamp: a fleet row 0.9 s into the shell merge's second passes, one at
  // the next whole second fails. Instants are read exactly (not through
  // `Date.parse`'s millisecond truncation) and offsets compare by instant. The
  // earliest matching fleet row decides, so a later re-journal never
  // disqualifies a pair the first row already covers. The same
  // earliest-per-pair reduction dedupes the fleet side for the comparator
  // itself: the merge set is a SET of pairs, and the journal may legitimately
  // carry several rows for one pair, which must compare as one member, not as
  // an invalid duplicate.
  const earliestFleetRows = new Map<string, FleetMergeItem>();
  for (const item of fleetItems) {
    const key = `${item.pullRequest}@${item.headOid}`;
    const previous = earliestFleetRows.get(key);
    if (previous === undefined || exactOrMillis(item.recordedAtIso) < exactOrMillis(previous.recordedAtIso)) {
      earliestFleetRows.set(key, item);
    }
  }
  const dedupedFleetItems = [...earliestFleetRows.values()];
  const comparison = compareShadowMergeSets({
    fleet: dedupedFleetItems.map((item) => ({ pullRequest: item.pullRequest, headOid: item.headOid })),
    shell: shellItems.items.map((item) => ({ pullRequest: item.pullRequest, headOid: item.headOid })),
  });

  const orderingDivergences: { key: string; code: string }[] = [];
  for (const shellItem of shellItems.items) {
    const key = `${shellItem.pullRequest}@${shellItem.headOid}`;
    const earliest = earliestFleetRows.get(key);
    if (earliest === undefined) {
      continue;
    }
    if (floorToSecond(exactOrMillis(earliest.recordedAtIso)) > exactOrMillis(shellItem.atIso)) {
      orderingDivergences.push({ key, code: 'fleet-recorded-after-merge' });
    }
  }

  const divergenceList = [...comparison.divergences, ...orderingDivergences];
  const surviving = survivingDivergences(divergenceList, dedupedFleetItems, shellItems.items, day);
  // Non-digested diagnostics: the same divergence count the day already
  // carries, parsed into bounded per-divergence items. `survivingDivergences`
  // above already counted every listed divergence exactly as today, so this
  // extraction never changes a verdict, count or digest; a divergence whose
  // key is not a parseable `<pr>@<head>` pair (e.g. an `invalid-item` entry)
  // is omitted from `items` while staying counted. Cost: O(D log D) over the
  // comparator-capped and day-surviving divergences D.
  const divergenceDetails = surviving > 0 ? mergeDivergenceDetails(surviving, divergenceList) : undefined;
  // The comparator caps its divergence list; beyond the cap an omitted
  // divergence may yet be same-day, so an all-grace listed set can never
  // certify a pass — the verdict stays open instead.
  if (comparison.truncated && surviving === 0) {
    return evaluation({ status: 'unknown', reason: 'merge-set-comparison-truncated' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, comparison.compared, surviving);
  }
  if (surviving > 0) {
    return evaluation({ status: 'fail', reason: 'merge-set-divergence' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, comparison.compared, surviving, divergenceDetails);
  }
  return evaluation({ status: 'pass', reason: 'merge-set-equal' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, comparison.compared, 0);
}

/**
 * The side a merge-set divergence sits on, by its own fixed code:
 * `missing-in-fleet` names a merge only the shell recorded, and
 * `missing-in-shell` / `fleet-recorded-after-merge` name fleet-side rows.
 * Any other code (an `invalid-item`, whose key is not a `<pr>@<head>` pair)
 * carries no side.
 */
function sideOfMergeDivergence(code: string): 'fleet' | 'shell' | null {
  if (code === 'missing-in-fleet') return 'shell';
  if (code === 'missing-in-shell' || code === 'fleet-recorded-after-merge') return 'fleet';
  return null;
}

/**
 * Parses a comparator key `<pr>@<headOid>`: a positive safe integer pull
 * request and a 40/64-hex head the `head12Of` prefix accepts, else null.
 * Cost: O(1) over a comparator-capped key string.
 */
function parseMergeDivergenceKey(key: string): { readonly pr: number; readonly head12: string } | null {
  const separator = key.indexOf('@');
  if (separator <= 0) return null;
  const prText = key.slice(0, separator);
  if (!/^\d+$/.test(prText)) return null;
  const pr = Number(prText);
  if (!Number.isSafeInteger(pr) || pr <= 0) return null;
  const head12 = head12Of(key.slice(separator + 1));
  if (head12 === null) return null;
  return { pr, head12 };
}

/** Cost: O(D log D) over the listed divergences D (comparator-capped). */
function mergeDivergenceDetails(totalCount: number, divergences: readonly { readonly key: string; readonly code: string }[]): ShadowDivergenceDetails {
  const items: ShadowDivergenceDiagnosticItem[] = [];
  for (const divergence of divergences) {
    const side = sideOfMergeDivergence(divergence.code);
    if (side === null) continue;
    const parsed = parseMergeDivergenceKey(divergence.key);
    if (parsed === null) continue;
    items.push({ pr: parsed.pr, head12: parsed.head12, side, code: divergence.code });
  }
  return divergenceDetailsOf(totalCount, items);
}

/**
 * Drops a fleet would-merge row for pull request P at head H when the shell
 * merged P at another head H2 that has its own fleet row, and the old row was
 * recorded at or before that shell merge: a head moved on and the old row is
 * superseded, not a missing merge. The row's instant is floored to the whole
 * second before the bound is applied because the shell stamps whole seconds
 * while the fleet stamps finer, exactly as the ordering rule in
 * `judgeComparison` does; a row from the next whole second onwards stays a
 * divergence. One pull request may carry several rows and several merges, so
 * the lookup holds a list per pull request.
 */
function dropSupersededFleetItems(fleetItems: readonly FleetMergeItem[], shellItems: readonly ShellMergeItem[]): readonly FleetMergeItem[] {
  const fleetPairs = new Set<string>(fleetItems.map((item) => `${item.pullRequest}@${item.headOid}`));
  const pairedMerges = new Map<number, { headOid: string; atNanos: bigint }[]>();
  for (const shellItem of shellItems) {
    if (!fleetPairs.has(`${shellItem.pullRequest}@${shellItem.headOid}`)) {
      continue;
    }
    const merges = pairedMerges.get(shellItem.pullRequest) ?? [];
    merges.push({ headOid: shellItem.headOid, atNanos: exactOrMillis(shellItem.atIso) });
    pairedMerges.set(shellItem.pullRequest, merges);
  }
  if (pairedMerges.size === 0) {
    return fleetItems;
  }
  return fleetItems.filter((item) => {
    const merges = pairedMerges.get(item.pullRequest);
    if (merges === undefined) {
      return true;
    }
    const recordedAt = floorToSecond(exactOrMillis(item.recordedAtIso));
    return !merges.some((merge) => merge.headOid !== item.headOid && recordedAt <= merge.atNanos);
  });
}

/** The S1 rules, over an already-validated snapshot: the shell/fleet set comparison and its divergence verdict. */
function evaluateMergeSet(parsed: ParsedMergeSetSnapshot): ShadowDayMergeSetEvaluation {
  const { day, repoDigest, excludeBatchMerges, shellEvents, fleetResults, fleetEntries } = parsed;
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  const start = dayStart - SHADOW_DAY_BOUNDARY_GRACE_MS;
  const end = dayStart + DAY_MS + SHADOW_DAY_BOUNDARY_GRACE_MS;

  const shellItems = shellSet(shellEvents, day, start, end, excludeBatchMerges);

  if (hasLiveActionInShadow(fleetResults, repoDigest, day)) {
    return evaluation({ status: 'fail', reason: 'live-action-in-shadow' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, 0, 0);
  }

  const fleetItems = resolveFleetSet(fleetResults, fleetEntries, repoDigest, day, start, end);
  if ('refusal' in fleetItems) {
    return evaluation(fleetItems.refusal, shellItems.mergesCompared, shellItems.excludedBatchMerges, 0, 0);
  }

  // An excluded batch merge with a daemon row must not become
  // `missing-in-shell`: drop the fleet rows of every excluded pull request (by number, since update-branch can move a head) before
  // the comparison runs.
  const keptFleetItems = shellItems.excludedPullRequests.size === 0
    ? fleetItems.items
    : fleetItems.items.filter((item) => !shellItems.excludedPullRequests.has(item.pullRequest));

  return judgeComparison(dropSupersededFleetItems(keptFleetItems, shellItems.items), shellItems, day);
}

function judgeShadowMergeSet(input: unknown): ShadowDayMergeSetEvaluation {
  const parsed = parseMergeSetInput(input);
  if (parsed.kind === 'invalid') {
    return INVALID();
  }
  if (parsed.kind === 'shell-incomplete') {
    return evaluation({ status: 'unknown', reason: 'shell-events-incomplete' }, 0, 0, 0, 0);
  }
  return evaluateMergeSet(parsed);
}

/**
 * An index of fleet entries by `${pullRequest}:${head12}`, built once over
 * `entries` before any result is resolved, so that `resolveHead` below does
 * a single Map lookup per result instead of rescanning `entries` in full
 * for every result — the join that makes the whole evaluator's cost linear
 * rather than `O(results × entries)`. Grouping is by the PAIR, not by PR
 * alone: two different full heads for the same PR with two different
 * 12-char prefixes must land in two different buckets, since a given
 * result's head12 can only ever be ambiguous against heads that share
 * *its own* prefix.
 */
function indexFleetEntries(entries: readonly { pullRequest: number; headOid: string }[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of entries) {
    const head12 = head12Of(entry.headOid);
    if (head12 === null) {
      continue;
    }
    const key = `${entry.pullRequest}:${head12}`;
    const heads = index.get(key);
    if (heads === undefined) {
      index.set(key, new Set([entry.headOid]));
    } else {
      heads.add(entry.headOid);
    }
  }
  return index;
}

/**
 * The fleet side of the merge set: every journaled `merge-pr` result with
 * outcome `dry-run`, a `would-merge` reason and a time inside the window.
 * Each key carries only a 12-character head, so it joins to a head record
 * sharing the PR whose own 12-char prefix matches, through the index built
 * once at the top of this function; an unmatched PR is a blocking refusal
 * and so is an ambiguous one.
 */
function resolveFleetSet(
  results: readonly Record<string, unknown>[],
  entries: readonly { pullRequest: number; headOid: string }[],
  repoDigest: string,
  day: string,
  start: number,
  end: number,
): { readonly items: readonly FleetMergeItem[] } | { readonly refusal: ShadowCriterionEvaluation } {
  const index = indexFleetEntries(entries);
  const items: FleetMergeItem[] = [];
  for (const result of results) {
    const key = result.key as string;
    const parsed = parseLaneRunKey(key);
    if (
      parsed === null || parsed.kind !== 'merge' || parsed.action !== 'merge-pr'
      || parsed.repoDigest !== repoDigest
      || result.outcome !== 'dry-run' || result.reasonCode !== 'would-merge'
      || !inWindow(result.recordedAtIso as string, start, end)
    ) {
      continue;
    }
    const headOid = resolveHead(index, parsed.pullRequest, parsed.head12);
    if (headOid === null) {
      return { refusal: { status: 'fail', reason: 'fleet-head-unresolved' } };
    }
    if (headOid === '') {
      return { refusal: { status: 'fail', reason: 'fleet-head-ambiguous' } };
    }
    items.push({ pullRequest: parsed.pullRequest, headOid, recordedAtIso: result.recordedAtIso as string });
  }
  return { items };
}

/**
 * The full head oid whose 12-char prefix matches `head12` on pull request
 * `pullRequest`, read from the pre-built `${pullRequest}:${head12}` index:
 * the oid when exactly one distinct head matches, `''` when several
 * distinct heads share the prefix, and null when none does.
 */
function resolveHead(index: ReadonlyMap<string, ReadonlySet<string>>, pullRequest: number, head12: string): string | null {
  const heads = index.get(`${pullRequest}:${head12}`);
  if (heads === undefined || heads.size === 0) {
    return null;
  }
  if (heads.size > 1) {
    return '';
  }
  const [only] = heads;
  return only;
}

/**
 * How many of the comparator's divergences still count as same-day: an
 * `invalid-item` divergence always counts; otherwise the divergence's own
 * event time — the shell merge's time for one missing on the fleet side or
 * recorded after the merge, the fleet result's time for one missing on the
 * shell side — must fall inside day D itself, not just the wider grace
 * window.
 */
function survivingDivergences(
  divergences: readonly { readonly key: string; readonly code: string }[],
  fleetItems: readonly FleetMergeItem[],
  shellItems: readonly ShellMergeItem[],
  day: string,
): number {
  const fleetTimes = new Map<string, string>();
  for (const item of fleetItems) {
    if (!fleetTimes.has(`${item.pullRequest}@${item.headOid}`)) {
      fleetTimes.set(`${item.pullRequest}@${item.headOid}`, item.recordedAtIso);
    }
  }
  const shellTimes = new Map<string, string>();
  for (const item of shellItems) {
    if (!shellTimes.has(`${item.pullRequest}@${item.headOid}`)) {
      shellTimes.set(`${item.pullRequest}@${item.headOid}`, item.atIso);
    }
  }
  let surviving = 0;
  for (const divergence of divergences) {
    if (divergence.code === 'invalid-item') {
      surviving += 1;
      continue;
    }
    const iso = divergence.code === 'missing-in-fleet' || divergence.code === 'fleet-recorded-after-merge'
      ? shellTimes.get(divergence.key)
      : fleetTimes.get(divergence.key) ?? shellTimes.get(divergence.key);
    if (iso !== undefined && inDay(iso, day)) {
      surviving += 1;
    }
  }
  return surviving;
}

// SR3 cut-over support: how many of the day's conducted runs count toward
// the certification streak. Reuses the S1 evaluation's own readers and set
// logic verbatim plus the per-run S6 evaluator; no existing verdict changes.

/** Every reason `countedRunsForDay` can refuse with. */
export type CountedRunsRefusalReason =
  | 'invalid-input'
  | 'invalid-tier'
  | 'unreadable-journal'
  | 'missing-review-receipts'
  | 'duplicate-run-conflict'
  | 'pull-request-has-several-runs'
  | 'unpaired-log'
  | 'unmatched-record'
  | 'tier2-batch-merge'
  | 'shell-events-incomplete'
  | 'live-action-in-shadow'
  | 'fleet-head-unresolved'
  | 'fleet-head-ambiguous'
  | 'head-moves-incomplete';

/** How many of the day's conducted runs count toward the streak, or a typed refusal. */
export type CountedRunsForDayResult =
  | { readonly ok: true; readonly countedRuns: number; readonly countedTier2: number }
  | { readonly ok: false; readonly reason: CountedRunsRefusalReason };

const COUNTED_RUNS_INPUT_KEYS: readonly string[] = ['day', 'repoDigest', 'shell', 'fleet', 'runs', 'headMoves', 'headMovesIncompleteFor'];

/** True when the snapshot carried an own enumerable `constructor` or `prototype` key. Cost: constant. */
function hasPollutingOwnKey(record: Record<string, unknown>): boolean {
  return Object.hasOwn(record, 'constructor') || Object.hasOwn(record, 'prototype');
}

/** True when the snapshot's own keys are exactly `keys`, each once. Cost: O(K) in the snapshot's own key count. */
function hasExactOwnKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  if (own.length !== keys.length) return false;
  for (const key of own) {
    if (!keys.includes(key)) return false;
  }
  return true;
}

/**
 * Counts the day's conducted runs that would count toward the cut-over
 * certification streak: every non-batch shell merge on day D whose fleet
 * `would-merge` row matches and whose conducted run conforms on every S6
 * rule, judged per run with NO aggregate floor. Tier 2 runs count both in
 * `countedRuns` and `countedTier2`.
 *
 * The input is read through `snapshotPlainDataRecord` (which already refuses
 * `__proto__`; `constructor` and `prototype` own keys are refused here), so
 * no getter ever runs and a revoked or throwing Proxy becomes a typed
 * refusal. Every list pays the accepted `readBoundedDenseArray` bound: an
 * `O(1)` length/prototype pre-gate, the accepted engine-level `O(K)` bound of
 * the single `Reflect.ownKeys` call, then `O(cap)` element traversal.
 *
 * Cost: `headMoves` is grouped once in O(M) (M <=
 * `SHADOW_CONFORMANCE_MAX_SHELL_FACTS`), the shell and fleet sets are walked
 * once each, and every run is evaluated against its one merge through the
 * pre-grouped context, so the whole evaluation is O(M + R) in the capped
 * head moves M and runs R — not O(M × R). Never throws, never echoes an
 * input value.
 */
export function countedRunsForDay(input: unknown): CountedRunsForDayResult {
  try {
    return judgeCountedRunsForDay(input);
  } catch {
    // A revoked Proxy, or a reflection trap that throws, must become a typed refusal.
    return { ok: false, reason: 'invalid-input' };
  }
}

function judgeCountedRunsForDay(input: unknown): CountedRunsForDayResult {
  const INVALID: CountedRunsForDayResult = { ok: false, reason: 'invalid-input' };
  const snapshot = snapshotPlainDataRecord(input);
  if (snapshot === null || hasPollutingOwnKey(snapshot) || !hasExactOwnKeys(snapshot, COUNTED_RUNS_INPUT_KEYS)) return INVALID;
  const day = readUtcDay(snapshot.day);
  const repoDigest = snapshot.repoDigest;
  if (day === null || typeof repoDigest !== 'string' || !REPO_DIGEST_PATTERN.test(repoDigest)) return INVALID;
  const shell = readExactPlainRecord(snapshot.shell, SHELL_INPUT_KEYS);
  const fleet = readExactPlainRecord(snapshot.fleet, FLEET_INPUT_KEYS);
  if (shell === null || fleet === null) return INVALID;
  const events = boundedArray(shell.events, SHADOW_MERGE_SET_MAX_ITEMS);
  const results = boundedArray(fleet.results, SHADOW_MERGE_SET_MAX_ITEMS);
  const entries = boundedArray(fleet.entries, SHADOW_MERGE_SET_MAX_ITEMS);
  const runsRaw = boundedArray(snapshot.runs, SHADOW_CONFORMANCE_MAX_RUNS);
  const headMovesRaw = boundedArray(snapshot.headMoves, SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
  const incompleteRaw = boundedArray(snapshot.headMovesIncompleteFor, SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
  if (events === null || results === null || entries === null || runsRaw === null || headMovesRaw === null || incompleteRaw === null) {
    return INVALID;
  }
  const shellEvents = collectShellEvents(events);
  if (shellEvents === null) return INVALID;
  const unknownLines = shell.unknownLines;
  if (!isCount(unknownLines)) return INVALID;
  // An incomplete shell record is never evidence either way.
  if (unknownLines > 0) return { ok: false, reason: 'shell-events-incomplete' };
  const fleetResults = collectFleetResults(results);
  const fleetEntries = collectFleetEntries(entries);
  if (fleetResults === null || fleetEntries === null) return INVALID;
  const headMoves: ShadowShellHeadMove[] = [];
  for (let index = 0; index < headMovesRaw.length; index += 1) {
    const move = readShadowHeadMove(headMovesRaw[index]);
    if (move === null) return INVALID;
    headMoves.push(move);
  }
  const headMovesIncompleteFor: number[] = [];
  for (let index = 0; index < incompleteRaw.length; index += 1) {
    const pullRequest = readPullRequest(incompleteRaw[index]);
    if (pullRequest === null) return INVALID;
    headMovesIncompleteFor.push(pullRequest);
  }
  const runs: ShadowConformanceRun[] = [];
  for (let index = 0; index < runsRaw.length; index += 1) {
    const parsedRun = readShadowConformanceRunDetailed(runsRaw[index]);
    if (!parsedRun.ok) return { ok: false, reason: parsedRun.reason };
    runs.push(parsedRun.run);
  }
  const deduped = dedupeRunsByRunId(runs);
  if (deduped.kind === 'unknown') return { ok: false, reason: deduped.reason };
  const dedupedRuns = deduped.runs;

  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  const start = dayStart - SHADOW_DAY_BOUNDARY_GRACE_MS;
  const end = dayStart + DAY_MS + SHADOW_DAY_BOUNDARY_GRACE_MS;

  // A merged shell event without a head or without a pull request can never
  // pair with a conducted run; refuse before the set walk runs.
  for (const event of shellEvents) {
    if (
      event.kind === 'result' && event.outcome === 'merged' && inWindow(event.atIso, start, end)
      && (event.headOid === null || event.pullRequest === null)
    ) {
      return { ok: false, reason: 'unpaired-log' };
    }
  }

  const shellItems = shellSet(shellEvents, day, start, end, true);
  if (hasLiveActionInShadow(fleetResults, repoDigest, day)) return { ok: false, reason: 'live-action-in-shadow' };
  // Batches neither count nor break: drop the fleet rows of every
  // batch-excluded pull request (by number, since update-branch can move a
  // head) before the fleet resolution runs, so an unresolved or ambiguous
  // head on an excluded batch merge cannot refuse the day.
  const excludedPullRequests = shellItems.excludedPullRequests;
  const keptFleetResults = excludedPullRequests.size === 0
    ? fleetResults
    : fleetResults.filter((result) => {
        const parsed = parseLaneRunKey(result.key as string);
        return parsed === null || parsed.kind !== 'merge' || !excludedPullRequests.has(parsed.pullRequest);
      });
  const keptFleetEntries = excludedPullRequests.size === 0
    ? fleetEntries
    : fleetEntries.filter((entry) => !excludedPullRequests.has(entry.pullRequest));
  const fleetSet = resolveFleetSet(keptFleetResults, keptFleetEntries, repoDigest, day, start, end);
  if ('refusal' in fleetSet) {
    const reason = fleetSet.refusal.reason;
    if (reason !== 'fleet-head-unresolved' && reason !== 'fleet-head-ambiguous') return INVALID;
    return { ok: false, reason };
  }
  const fleetItems = fleetSet.items;

  // Tier 2 is never batched: a batch-marked Tier 2 merge is a blocking refusal.
  for (const run of dedupedRuns) {
    if (run.tier === 2 && shellItems.excludedPullRequests.has(run.pullRequest)) {
      return { ok: false, reason: 'tier2-batch-merge' };
    }
  }

  // The same earliest-per-pair reduction the S1 comparator uses: a fleet
  // would-merge counts for a shell merge only when its whole-second instant
  // is at or before the merge's own instant.
  const earliestFleetRows = new Map<string, FleetMergeItem>();
  for (const item of fleetItems) {
    const key = `${item.pullRequest}@${item.headOid}`;
    const previous = earliestFleetRows.get(key);
    if (previous === undefined || exactOrMillis(item.recordedAtIso) < exactOrMillis(previous.recordedAtIso)) {
      earliestFleetRows.set(key, item);
    }
  }
  for (const item of shellItems.items) {
    if (!inDay(item.atIso, day)) continue;
    const earliest = earliestFleetRows.get(`${item.pullRequest}@${item.headOid}`);
    if (earliest === undefined || floorToSecond(exactOrMillis(earliest.recordedAtIso)) > exactOrMillis(item.atIso)) {
      return { ok: false, reason: 'unmatched-record' };
    }
  }

  // One conducted run per merged pull request on the day.
  const runsByRunId = new Map<string, ShadowConformanceRun>();
  const runIdsByPullRequest = new Map<number, Set<string>>();
  for (const run of dedupedRuns) {
    runsByRunId.set(run.runId, run);
    let ids = runIdsByPullRequest.get(run.pullRequest);
    if (ids === undefined) {
      ids = new Set([run.runId]);
      runIdsByPullRequest.set(run.pullRequest, ids);
    } else {
      ids.add(run.runId);
    }
  }
  const matched: { readonly run: ShadowConformanceRun; readonly merge: ShadowShellMerge }[] = [];
  // A conducted run counts at most once: if several same-day shell merges
  // name the same pull request (and therefore the same single run), only the
  // first pairing is evaluated, so one conforming run can never be counted
  // twice and inflate the certification streak total.
  const matchedRunIds = new Set<string>();
  for (const item of shellItems.items) {
    if (!inDay(item.atIso, day)) continue;
    const ids = runIdsByPullRequest.get(item.pullRequest);
    if (ids === undefined) return { ok: false, reason: 'unpaired-log' };
    if (ids.size > 1) return { ok: false, reason: 'pull-request-has-several-runs' };
    const [only] = ids;
    const run = runsByRunId.get(only);
    if (run === undefined) return { ok: false, reason: 'unpaired-log' };
    if (matchedRunIds.has(run.runId)) continue;
    matchedRunIds.add(run.runId);
    matched.push({ run, merge: item });
  }

  // The context groups `headMoves` exactly once; every run then evaluates
  // against its one merge without rescanning the list.
  const context = createShadowRunConformanceContext(day, headMoves, headMovesIncompleteFor);
  if (context === null) return INVALID;
  let countedRuns = 0;
  let countedTier2 = 0;
  for (const { run, merge } of matched) {
    const verdict = evaluateRunS6WithContext(run, merge, context);
    if (verdict.kind === 'unknown') {
      return { ok: false, reason: verdict.reason === 'head-moves-incomplete' ? 'head-moves-incomplete' : 'invalid-input' };
    }
    if (verdict.kind === 'conforming') {
      countedRuns += 1;
      if (run.tier === 2) countedTier2 += 1;
    }
  }
  return Object.freeze({ ok: true, countedRuns, countedTier2 });
}
