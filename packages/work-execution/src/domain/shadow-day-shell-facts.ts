import { isZonedIsoDateTime } from './conductor-halt.js';
import type { ShadowShellHeadMove, ShadowShellMerge } from './shadow-day-conformance.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { readExactPlainRecord } from './plain-record-reads.js';
import { readShellEvent } from './shadow-day-merge-set.js';
import { SHELL_EVENTS_MAX_LINES } from './shell-train-events.js';
import type { ShellTrainEvent } from './shell-train-events.js';

/** The event-list cap for this extractor; a longer list is refused before any element is read. */
export const SHADOW_SHELL_FACTS_MAX_EVENTS = SHELL_EVENTS_MAX_LINES;

/** Anomalies this extractor reports about the shell's events log. */
export const SHADOW_SHELL_ANOMALY_CODES = ['unpaired-update', 'unclassified-update', 'unresolved-merge'] as const;

export type ShadowShellAnomalyCode = (typeof SHADOW_SHELL_ANOMALY_CODES)[number];

/** One premerge carry decision paired from the shell's intent/result update records. */
export interface ShadowShellCarryDecision {
  readonly pullRequest: number;
  readonly oldHeadOid: string;
  readonly newHeadOid: string;
  readonly atIso: string;
  readonly shellCarry: 'carried' | 'not-carried';
}

/** One anomaly with no detail text: only when it happened and why. */
export interface ShadowShellAnomaly {
  readonly atIso: string;
  readonly code: ShadowShellAnomalyCode;
}

/** Facts the shell train's events log carries, read for S6' and S5'. */
export interface ShadowShellFacts {
  readonly merges: readonly ShadowShellMerge[];
  readonly headMoves: readonly ShadowShellHeadMove[];
  readonly headMovesIncompleteFor: readonly number[];
  readonly carryDecisions: readonly ShadowShellCarryDecision[];
  readonly anomalies: readonly ShadowShellAnomaly[];
}

export type ShadowShellFactsExtraction =
  | { readonly ok: false; readonly reason: 'invalid-input' }
  | { readonly ok: true; readonly facts: ShadowShellFacts };

/**
 * Extract shell merges, head moves and premerge carry decisions from the
 * shell train's parsed events log. Cost: linear in the capped input —
 * O(SHADOW_SHELL_FACTS_MAX_EVENTS) element reads at worst, each element
 * validated by `readShellEvent`; the list cap is checked from the length
 * descriptor before any element is read. Sorting `headMovesIncompleteFor`
 * costs O(k log k) in the number of distinct incomplete pull requests, k
 * bounded by the event cap. Never throws; every refusal is the typed
 * `invalid-input` result. Reads only own data-property descriptors, so no
 * getter on the list root or on any element ever runs.
 */
export function extractShadowShellFacts(events: unknown): ShadowShellFactsExtraction {
  try {
    const read = readEventList(events);
    if (read === null) {
      return { ok: false, reason: 'invalid-input' };
    }
    return { ok: true, facts: extractFacts(read) };
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
}

/**
 * Validate the list as a real, dense array of `Array.prototype`, capped by
 * `SHADOW_SHELL_FACTS_MAX_EVENTS` from its own length descriptor with its own
 * key count confirmed, then every element via `readShellEvent`, with `line`
 * strictly ascending. Returns null on any refusal.
 */
function readEventList(events: unknown): readonly ShellTrainEvent[] | null {
  if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(events, 'length');
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > SHADOW_SHELL_FACTS_MAX_EVENTS
  ) {
    return null;
  }
  if (Reflect.ownKeys(events).length !== length + 1) {
    return null;
  }
  const out: ShellTrainEvent[] = [];
  let previousLine = -1;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    const event = readShellEvent(descriptor.value);
    if (event === null || event.line <= previousLine) {
      return null;
    }
    previousLine = event.line;
    out.push(event);
  }
  return out;
}

/** Pair the validated events into facts, in list order. */
function extractFacts(events: readonly ShellTrainEvent[]): ShadowShellFacts {
  const incomplete = new Set<number>();
  const merges: ShadowShellMerge[] = [];
  const headMoves: ShadowShellHeadMove[] = [];
  const carryDecisions: ShadowShellCarryDecision[] = [];
  const anomalies: ShadowShellAnomaly[] = [];
  const pendingUpdates = new Map<number, string>();
  for (const event of events) {
    if (event.kind === 'result' && event.pullRequest !== null && event.outcome !== 'updated') {
      pendingUpdates.delete(event.pullRequest);
    }
    if (event.kind === 'result' && event.outcome === 'merged') {
      readMergedEvent(event, merges, anomalies);
    } else if (event.kind === 'head-moved') {
      readHeadMovedEvent(event, headMoves, incomplete);
    } else if (event.kind === 'intent' && event.outcome === 'update-branch') {
      readUpdateIntentEvent(event, pendingUpdates);
    } else if (event.kind === 'result' && event.outcome === 'updated') {
      readUpdatedEvent(event, headMoves, carryDecisions, anomalies, incomplete, pendingUpdates);
    }
  }
  return {
    merges,
    headMoves,
    headMovesIncompleteFor: [...incomplete].sort((a, b) => a - b),
    carryDecisions,
    anomalies,
  };
}

/** A `result`/`merged` event: a merge when identified, an anomaly otherwise. */
function readMergedEvent(
  event: ShellTrainEvent,
  merges: ShadowShellMerge[],
  anomalies: ShadowShellAnomaly[],
): void {
  if (event.pullRequest !== null && event.headOid !== null) {
    merges.push({ pullRequest: event.pullRequest, headOid: event.headOid, atIso: event.atIso });
  } else {
    anomalies.push({ atIso: event.atIso, code: 'unresolved-merge' });
  }
}

/** A `head-moved` event: a pushed move when complete, an incomplete record otherwise. */
function readHeadMovedEvent(
  event: ShellTrainEvent,
  headMoves: ShadowShellHeadMove[],
  incomplete: Set<number>,
): void {
  if (
    event.detailCode === 'head-moved-from' &&
    event.pullRequest !== null &&
    event.fromHeadOid !== null &&
    event.headOid !== null
  ) {
    headMoves.push({
      pullRequest: event.pullRequest,
      fromHeadOid: event.fromHeadOid,
      toHeadOid: event.headOid,
      atIso: event.atIso,
    });
  } else if (event.pullRequest !== null) {
    incomplete.add(event.pullRequest);
  }
}

/**
 * An `intent`/`update-branch` event: the newest intent per pull request is
 * kept; an intent with a null `headOid` for a non-null pull request deletes
 * any pending intent for that pull request (the update that follows started
 * from an unread head and must not pair with the older intent).
 */
function readUpdateIntentEvent(event: ShellTrainEvent, pendingUpdates: Map<number, string>): void {
  if (event.pullRequest === null) {
    return;
  }
  if (event.headOid === null) {
    pendingUpdates.delete(event.pullRequest);
    return;
  }
  pendingUpdates.set(event.pullRequest, event.headOid);
}

/** A `result`/`updated` event: pairs with its pending intent or is unpaired. */
function readUpdatedEvent(
  event: ShellTrainEvent,
  headMoves: ShadowShellHeadMove[],
  carryDecisions: ShadowShellCarryDecision[],
  anomalies: ShadowShellAnomaly[],
  incomplete: Set<number>,
  pendingUpdates: Map<number, string>,
): void {
  if (event.pullRequest === null) {
    anomalies.push({ atIso: event.atIso, code: 'unpaired-update' });
    return;
  }
  const pendingHeadOid = pendingUpdates.get(event.pullRequest);
  pendingUpdates.delete(event.pullRequest);
  if (pendingHeadOid === undefined || event.headOid === null) {
    anomalies.push({ atIso: event.atIso, code: 'unpaired-update' });
    incomplete.add(event.pullRequest);
    return;
  }
  headMoves.push({
    pullRequest: event.pullRequest,
    fromHeadOid: pendingHeadOid,
    toHeadOid: event.headOid,
    atIso: event.atIso,
  });
  if (event.detailCode === 'premerge-carried' || event.detailCode === 'premerge-not-carried') {
    carryDecisions.push({
      pullRequest: event.pullRequest,
      oldHeadOid: pendingHeadOid,
      newHeadOid: event.headOid,
      atIso: event.atIso,
      shellCarry: event.detailCode === 'premerge-carried' ? 'carried' : 'not-carried',
    });
  } else if (event.detailCode !== 'premerge-reposted') {
    anomalies.push({ atIso: event.atIso, code: 'unclassified-update' });
  }
}

/**
 * The carry-decision cap for S5'. Each carry decision is paired from exactly
 * one update intent and one result in the shell's events log, so a log of
 * `SHADOW_SHELL_FACTS_MAX_EVENTS` events can carry at most half that many
 * decisions. Deriving the cap from the extractor's event cap keeps the two
 * from drifting: the extractor can never emit more decisions than events, and
 * the evaluator refuses a list above this bound.
 */
export const SHADOW_CARRY_MAX_DECISIONS = SHADOW_SHELL_FACTS_MAX_EVENTS / 2;

/**
 * The cap on the unresolved-decision ids echoed in S5''s non-digested
 * diagnostics: `unresolvedCount` always holds the full deduped unresolved
 * count, while `unresolvedIds` holds at most this many ids, so the result
 * stays bounded however many decisions a day carried (2026-11-18 owner
 * decision).
 */
export const SHADOW_CARRY_MAX_UNRESOLVED_IDS = 50;

/**
 * The S5' evaluation adds the replay counters to the shared criterion shape,
 * plus the non-digested unresolved diagnostics: `unresolvedCount` is the full
 * deduped count of day-scoped decisions the fleet resolver left `unknown`, and
 * `unresolvedIds` holds at most `SHADOW_CARRY_MAX_UNRESOLVED_IDS` sorted,
 * bounded ids for them. Neither field is ever part of the S5' digest.
 */
export type ShadowPremergeCarryEvaluation = ShadowCriterionEvaluation & {
  readonly compared: number;
  readonly laxCarries: number;
  readonly stricterNoCarries: number;
  readonly unresolvedCount: number;
  readonly unresolvedIds: readonly string[];
};

interface ScopedDecision {
  readonly pullRequest: number;
  readonly newHeadOid: string;
  readonly atIso: string;
  readonly shellCarry: 'carried' | 'not-carried';
  readonly fleetCarry: 'carry' | 'no-carry' | 'unknown';
}

interface ParsedCarryInput {
  readonly ok: true;
  readonly day: string;
  readonly decisions: readonly ScopedDecision[];
  readonly anomalies: readonly ShadowShellAnomaly[];
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEAD_OID_PATTERN = /^[0-9a-f]{40}$/;
const CARRY_INPUT_KEYS = ['day', 'unknownLines', 'decisions', 'anomalies'] as const;
const CARRY_DECISION_KEYS = ['pullRequest', 'oldHeadOid', 'newHeadOid', 'atIso', 'shellCarry', 'fleetCarry'] as const;
const CARRY_ANOMALY_KEYS = ['atIso', 'code'] as const;
const PAIRING_ANOMALY_CODES: readonly ShadowShellAnomalyCode[] = ['unpaired-update', 'unclassified-update'];
const DAY_MS = 86_400_000;

/**
 * A FRESH unknown result per call: a returned refusal must never be a shared,
 * mutable singleton, or one caller's mutation of it would poison every later
 * call into accepting the mutated verdict.
 */
const REFUSAL = (reason: string): ShadowPremergeCarryEvaluation => ({
  status: 'unknown',
  reason,
  compared: 0,
  laxCarries: 0,
  stricterNoCarries: 0,
  unresolvedCount: 0,
  unresolvedIds: [],
});
const INVALID_PARSE = { ok: false, reason: 'invalid' } as const;
const SHELL_INCOMPLETE_PARSE = { ok: false, reason: 'shell-incomplete' } as const;

/**
 * S5' (OD-3b): replay the shell train's premerge carry decisions through
 * fleet-v2's answer and require the two to agree on every decision the
 * resolver could answer (`carry`/`no-carry`). A decision the resolver left
 * `unknown` is never compared: per the 2026-11-18 owner decision it is
 * reported in the non-digested diagnostics `unresolvedCount` (the full
 * deduped unresolved count) and `unresolvedIds` (at most
 * `SHADOW_CARRY_MAX_UNRESOLVED_IDS` ids, each
 * `${pullRequest}@${newHeadOid.slice(0, 12)}`, sorted) instead — the PR ids
 * with head prefixes are echoed deliberately there, and only there, bounded
 * by the caps. Cost: linear in the capped input — at most
 * `SHADOW_CARRY_MAX_DECISIONS` decisions plus `SHADOW_SHELL_FACTS_MAX_EVENTS`
 * anomalies, each read through its own data property descriptors, so no
 * getter and no Proxy `get` trap ever runs; the list caps are checked from
 * the length descriptors before any element is read — plus an O(u log u)
 * sort over at most `SHADOW_CARRY_MAX_DECISIONS` unresolved ids. Never
 * throws; every refusal is the typed unknown result with the named reason.
 */
export function evaluateShadowPremergeCarry(input: unknown): ShadowPremergeCarryEvaluation {
  try {
    return evaluateCarry(input);
  } catch {
    return REFUSAL('invalid-input');
  }
}

/** Validate, then scope to the day and compare, in the brief's rule order. */
function evaluateCarry(input: unknown): ShadowPremergeCarryEvaluation {
  const parsed = parseCarryInput(input);
  if (!parsed.ok) {
    return parsed.reason === 'invalid' ? REFUSAL('invalid-input') : REFUSAL('shell-incomplete');
  }
  const start = Date.parse(`${parsed.day}T00:00:00.000Z`);
  const end = start + DAY_MS;
  const dayDecisions = parsed.decisions.filter((decision) => inDayWindow(decision.atIso, start, end));
  const dayAnomalies = parsed.anomalies.filter((anomaly) => inDayWindow(anomaly.atIso, start, end));
  if (dayAnomalies.some((anomaly) => PAIRING_ANOMALY_CODES.includes(anomaly.code))) {
    return REFUSAL('carry-pairing-incomplete');
  }
  const deduped = dedupeByNewHead(dayDecisions);
  if (deduped === null) {
    return REFUSAL('carry-facts-conflicting');
  }
  // 2026-11-18 owner decision: S5' compares only the decisions fleet-v2 can
  // resolve. An `unknown` answer is never treated as a success or a failure —
  // it is recorded in the non-digested diagnostics instead of refusing the
  // day, and a lax carry whose decision is unresolved is missed by design.
  // When every deduped in-day decision is unresolved the day still passes
  // with `compared: 0` plus the unresolved count (owner acceptance:
  // while the composition pins the resolver to `'unknown'`, S5' compares
  // nothing on any day with a complete, paired shell log).
  const resolved = deduped.filter((decision) => decision.fleetCarry !== 'unknown');
  const unresolved = deduped.filter((decision) => decision.fleetCarry === 'unknown');
  const unresolvedIds = unresolved
    .map((decision) => `${decision.pullRequest}@${decision.newHeadOid.slice(0, 12)}`)
    .sort(compareCodeUnitOrder)
    .slice(0, SHADOW_CARRY_MAX_UNRESOLVED_IDS);
  return compareCarries(resolved, unresolved.length, unresolvedIds);
}

/** The whole input, validated down to typed decisions and anomalies. */
function parseCarryInput(input: unknown): ParsedCarryInput | { ok: false; reason: 'invalid' | 'shell-incomplete' } {
  const record = readExactPlainRecord(input, CARRY_INPUT_KEYS);
  if (record === null) {
    return INVALID_PARSE;
  }
  const day = readCarryDay(record.day);
  if (day === null) {
    return INVALID_PARSE;
  }
  const unknownLines = record.unknownLines;
  if (!isCarryCount(unknownLines)) {
    return INVALID_PARSE;
  }
  const boundedDecisions = boundedCarryList(record.decisions, SHADOW_CARRY_MAX_DECISIONS);
  const boundedAnomalies = boundedCarryList(record.anomalies, SHADOW_SHELL_FACTS_MAX_EVENTS);
  if (boundedDecisions === null || boundedAnomalies === null) {
    return INVALID_PARSE;
  }
  const readDecisions = collectCarryItems(boundedDecisions.list, boundedDecisions.length, readCarryDecision);
  const readAnomalies = collectCarryItems(boundedAnomalies.list, boundedAnomalies.length, readCarryAnomaly);
  if (readDecisions === null || readAnomalies === null) {
    return INVALID_PARSE;
  }
  // An incomplete shell record is never evidence either way.
  if (unknownLines > 0) {
    return SHELL_INCOMPLETE_PARSE;
  }
  return { ok: true, day, decisions: readDecisions, anomalies: readAnomalies };
}

/** A real UTC calendar day `YYYY-MM-DD` in years 2000-9999, or null. */
function readCarryDay(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value) || Number(value.slice(0, 4)) < 2000) {
    return null;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return value;
}

/** A non-negative safe integer count. */
function isCarryCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A real, dense array of `Array.prototype` within `cap`, refused from its own
 * length descriptor and own key count alone, before any element is touched.
 */
function boundedCarryList(
  value: unknown,
  cap: number,
): { list: readonly unknown[]; length: number } | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > cap ||
    Reflect.ownKeys(value).length !== length + 1
  ) {
    return null;
  }
  // The length is captured here and never read off the list again: a Proxy
  // `get` trap could otherwise answer a different `.length` inside the loop.
  return { list: value as readonly unknown[], length };
}

/** The own data-property element at `index`; a hole or an accessor reads as undefined. */
function carryElement(list: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** Every element through `read`, or null at the first one out of shape. */
function collectCarryItems<T>(
  list: readonly unknown[],
  length: number,
  read: (raw: unknown) => T | null,
): readonly T[] | null {
  const out: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = read(carryElement(list, index));
    if (item === null) {
      return null;
    }
    out.push(item);
  }
  return out;
}

/** One carry decision as S5' reads it, or null when out of shape. */
function readCarryDecision(raw: unknown): ScopedDecision | null {
  const record = readExactPlainRecord(raw, CARRY_DECISION_KEYS);
  if (record === null) {
    return null;
  }
  const { pullRequest, oldHeadOid, newHeadOid, atIso, shellCarry, fleetCarry } = record;
  if (
    !isCarryCount(pullRequest) ||
    typeof oldHeadOid !== 'string' ||
    !HEAD_OID_PATTERN.test(oldHeadOid) ||
    typeof newHeadOid !== 'string' ||
    !HEAD_OID_PATTERN.test(newHeadOid) ||
    !isZonedIsoDateTime(atIso)
  ) {
    return null;
  }
  if (shellCarry !== 'carried' && shellCarry !== 'not-carried') {
    return null;
  }
  if (fleetCarry !== 'carry' && fleetCarry !== 'no-carry' && fleetCarry !== 'unknown') {
    return null;
  }
  return { pullRequest, newHeadOid, atIso, shellCarry, fleetCarry };
}

/** One anomaly as S5' reads it, or null when out of shape. */
function readCarryAnomaly(raw: unknown): ShadowShellAnomaly | null {
  const record = readExactPlainRecord(raw, CARRY_ANOMALY_KEYS);
  if (record === null) {
    return null;
  }
  const { atIso, code } = record;
  if (
    !isZonedIsoDateTime(atIso) ||
    !SHADOW_SHELL_ANOMALY_CODES.includes(code as ShadowShellAnomalyCode)
  ) {
    return null;
  }
  return { atIso, code: code as ShadowShellAnomalyCode };
}

/** Whether the instant `atIso` names falls inside the half-open day window. */
function inDayWindow(atIso: string, start: number, end: number): boolean {
  const instant = new Date(atIso).getTime();
  return instant >= start && instant < end;
}

/**
 * Locale-independent, deterministic code-unit order. `String.localeCompare`
 * depends on the host locale and would make `unresolvedIds` (pinned by the CLI
 * output and the tests) vary by host, so the comparison uses raw code units.
 */
function compareCodeUnitOrder(a: string, b: string): -1 | 0 | 1 {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Decisions sharing a `newHeadOid` collapse into one when both the shell and
 * the fleet carry agree; any disagreement is a conflict, since the same head
 * cannot carry two different answers. A resolved answer and an `'unknown'`
 * answer for the same head disagree on `fleetCarry` too, so they refuse the
 * same way — an unresolved decision never overrides a resolved one.
 */
function dedupeByNewHead(decisions: readonly ScopedDecision[]): readonly ScopedDecision[] | null {
  const byHead = new Map<string, ScopedDecision>();
  for (const decision of decisions) {
    const seen = byHead.get(decision.newHeadOid);
    if (seen === undefined) {
      byHead.set(decision.newHeadOid, decision);
      continue;
    }
    if (seen.shellCarry !== decision.shellCarry || seen.fleetCarry !== decision.fleetCarry) {
      return null;
    }
  }
  return [...byHead.values()];
}

/**
 * The equality check itself: one linear pass over the deduped, resolved
 * decisions, in which the fleet is lax (carrying where the shell did not) or
 * stricter (not carrying where the shell did) — either breaks the equality
 * criterion. `compared` counts resolved decisions only (2026-11-18 owner
 * decision), so it is resolver-dependent; the unresolved decisions ride along
 * only as the non-digested diagnostics.
 */
function compareCarries(
  decisions: readonly ScopedDecision[],
  unresolvedCount: number,
  unresolvedIds: readonly string[],
): ShadowPremergeCarryEvaluation {
  let laxCarries = 0;
  let stricterNoCarries = 0;
  for (const decision of decisions) {
    if (decision.fleetCarry === 'carry' && decision.shellCarry === 'not-carried') {
      laxCarries += 1;
    }
    if (decision.fleetCarry === 'no-carry' && decision.shellCarry === 'carried') {
      stricterNoCarries += 1;
    }
  }
  if (laxCarries > 0 || stricterNoCarries > 0) {
    return {
      status: 'fail',
      reason: 'carry-decision-differs',
      compared: decisions.length,
      laxCarries,
      stricterNoCarries,
      unresolvedCount,
      unresolvedIds,
    };
  }
  return {
    status: 'pass',
    reason: 'carry-decisions-equal',
    compared: decisions.length,
    laxCarries: 0,
    stricterNoCarries: 0,
    unresolvedCount,
    unresolvedIds,
  };
}
