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
import { readExactPlainRecord } from './plain-record-reads.js';

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
};

interface ShellMergeItem { readonly pullRequest: number; readonly headOid: string; readonly atIso: string; }
interface FleetMergeItem { readonly pullRequest: number; readonly headOid: string; readonly recordedAtIso: string; }

function evaluation(status: ShadowCriterionEvaluation, merges: number, excluded: number, compared: number, divergences: number): ShadowDayMergeSetEvaluation {
  return Object.freeze({
    status: status.status,
    reason: status.reason,
    mergesCompared: merges,
    excludedBatchMerges: excluded,
    compared,
    divergences,
  });
}

const INVALID = (): ShadowDayMergeSetEvaluation => evaluation({ status: 'unknown', reason: 'invalid-input' }, 0, 0, 0, 0);

/** The own data-property element at `index`; a hole or an accessor reads as undefined. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * A real, dense array within `SHADOW_MERGE_SET_MAX_ITEMS`, or null for any
 * stand-in. Reads only the `length` own descriptor and `Object.keys` (no
 * values), so no getter and no Proxy `get` trap ever runs; an oversized,
 * sparse or accessor-backed array is refused from its length alone, before
 * any element is touched.
 */
function boundedArray(value: unknown, cap: number): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value > cap ||
    Object.keys(value).length !== lengthDescriptor.value
  ) {
    return null;
  }
  return value as readonly unknown[];
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
 * The shell side of the merge set: every `result` event with outcome
 * `merged` and a non-null head, inside the day window; when
 * `excludeBatchMerges` is true, batch-member merges are dropped and counted
 * separately. `mergesCompared` counts the kept merges whose own time falls
 * inside day D itself — the value the later 20-merge floor consumes.
 */
function shellSet(events: readonly ShellTrainEvent[], day: string, start: number, end: number, excludeBatchMerges: boolean): {
  readonly items: readonly ShellMergeItem[];
  readonly excludedBatchMerges: number;
  readonly mergesCompared: number;
} {
  const items: ShellMergeItem[] = [];
  let excludedBatchMerges = 0;
  let mergesCompared = 0;
  for (const event of events) {
    if (event.kind !== 'result' || event.outcome !== 'merged' || event.headOid === null) {
      continue;
    }
    if (!inWindow(event.atIso, start, end)) {
      continue;
    }
    if (excludeBatchMerges && event.detailCode === 'batch-member') {
      excludedBatchMerges += 1;
      continue;
    }
    if (inDay(event.atIso, day)) {
      mergesCompared += 1;
    }
    items.push({ pullRequest: event.pullRequest ?? 0, headOid: event.headOid, atIso: event.atIso });
  }
  return { items, excludedBatchMerges, mergesCompared };
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
 * and entries each are walked, and an oversized, sparse or non-dense array
 * is refused from its own `length` before any element is traversed. Every
 * value is read through its own property descriptor, so no getter ever runs
 * and a Proxy stand-in either is refused or yields exactly the plain data's
 * verdict. Never throws, never echoes the input.
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
    const event = readShellEvent(ownElement(events, index));
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
    const result = readFleetResult(ownElement(results, index));
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
    const entry = readFleetEntry(ownElement(entries, index));
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
  const comparison = compareShadowMergeSets({
    fleet: fleetItems.map((item) => ({ pullRequest: item.pullRequest, headOid: item.headOid })),
    shell: shellItems.items.map((item) => ({ pullRequest: item.pullRequest, headOid: item.headOid })),
  });

  const surviving = survivingDivergences(comparison.divergences, fleetItems, shellItems.items, day);
  // The comparator caps its divergence list; beyond the cap an omitted
  // divergence may yet be same-day, so an all-grace listed set can never
  // certify a pass — the verdict stays open instead.
  if (comparison.truncated && surviving === 0) {
    return evaluation({ status: 'unknown', reason: 'merge-set-comparison-truncated' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, comparison.compared, surviving);
  }
  if (surviving > 0) {
    return evaluation({ status: 'fail', reason: 'merge-set-divergence' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, comparison.compared, surviving);
  }
  return evaluation({ status: 'pass', reason: 'merge-set-equal' }, shellItems.mergesCompared, shellItems.excludedBatchMerges, comparison.compared, 0);
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

  return judgeComparison(fleetItems.items, shellItems, day);
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
 * event time — the shell merge's time for one missing on the fleet side,
 * the fleet result's time for one missing on the shell side — must fall
 * inside day D itself, not just the wider grace window.
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
    const iso = divergence.code === 'missing-in-fleet'
      ? shellTimes.get(divergence.key)
      : fleetTimes.get(divergence.key) ?? shellTimes.get(divergence.key);
    if (iso !== undefined && inDay(iso, day)) {
      surviving += 1;
    }
  }
  return surviving;
}
