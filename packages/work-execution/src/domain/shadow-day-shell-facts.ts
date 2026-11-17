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

/** The carry-decision cap for S5'; see the constant's comment for why it cannot drift. */
export const SHADOW_CARRY_MAX_DECISIONS = SHADOW_SHELL_FACTS_MAX_EVENTS / 2;

/** The S5' evaluation adds the replay counters to the shared criterion shape. */
export type ShadowPremergeCarryEvaluation = ShadowCriterionEvaluation & {
  readonly compared: number;
  readonly laxCarries: number;
  readonly stricterNoCarries: number;
};

interface ScopedDecision {
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

const REFUSAL = (reason: string): ShadowPremergeCarryEvaluation => ({
  status: 'unknown',
  reason,
  compared: 0,
  laxCarries: 0,
  stricterNoCarries: 0,
});
const INVALID_EVAL = REFUSAL('invalid-input');
const SHELL_INCOMPLETE_EVAL = REFUSAL('shell-incomplete');
const INVALID_PARSE = { ok: false, reason: 'invalid' } as const;
const SHELL_INCOMPLETE_PARSE = { ok: false, reason: 'shell-incomplete' } as const;

/**
 * S5' (OD-3b): replay the shell train's premerge carry decisions through
 * fleet-v2's answer and require the two to agree. Cost: linear in the capped
 * input — at most `SHADOW_CARRY_MAX_DECISIONS` decisions plus
 * `SHADOW_SHELL_FACTS_MAX_EVENTS` anomalies, each read through its own data
 * property descriptors, so no getter and no Proxy `get` trap ever runs; the
 * list caps are checked from the length descriptors before any element is
 * read. Never throws; every refusal is the typed unknown result with the
 * named reason, and no input value is ever echoed into the result.
 */
export function evaluateShadowPremergeCarry(input: unknown): ShadowPremergeCarryEvaluation {
  try {
    return evaluateCarry(input);
  } catch {
    return INVALID_EVAL;
  }
}

/** Validate, then scope to the day and compare, in the brief's rule order. */
function evaluateCarry(input: unknown): ShadowPremergeCarryEvaluation {
  const parsed = parseCarryInput(input);
  if (!parsed.ok) {
    return parsed.reason === 'invalid' ? INVALID_EVAL : SHELL_INCOMPLETE_EVAL;
  }
  const start = Date.parse(`${parsed.day}T00:00:00.000Z`);
  const end = start + DAY_MS;
  const dayDecisions = parsed.decisions.filter((decision) => inDayWindow(decision.atIso, start, end));
  const dayAnomalies = parsed.anomalies.filter((anomaly) => inDayWindow(anomaly.atIso, start, end));
  if (dayAnomalies.some((anomaly) => PAIRING_ANOMALY_CODES.includes(anomaly.code))) {
    return REFUSAL('carry-pairing-incomplete');
  }
  if (dayDecisions.some((decision) => decision.fleetCarry === 'unknown')) {
    return REFUSAL('fleet-carry-unknown');
  }
  const deduped = dedupeByNewHead(dayDecisions);
  if (deduped === null) {
    return REFUSAL('carry-facts-conflicting');
  }
  return compareCarries(deduped);
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
  const decisions = boundedCarryList(record.decisions, SHADOW_CARRY_MAX_DECISIONS);
  const anomalies = boundedCarryList(record.anomalies, SHADOW_SHELL_FACTS_MAX_EVENTS);
  if (decisions === null || anomalies === null) {
    return INVALID_PARSE;
  }
  const readDecisions = collectCarryItems(decisions, readCarryDecision);
  const readAnomalies = collectCarryItems(anomalies, readCarryAnomaly);
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
function boundedCarryList(value: unknown, cap: number): readonly unknown[] | null {
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
  return value as readonly unknown[];
}

/** The own data-property element at `index`; a hole or an accessor reads as undefined. */
function carryElement(list: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** Every element through `read`, or null at the first one out of shape. */
function collectCarryItems<T>(
  list: readonly unknown[],
  read: (raw: unknown) => T | null,
): readonly T[] | null {
  const out: T[] = [];
  for (let index = 0; index < list.length; index += 1) {
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
  return { newHeadOid, atIso, shellCarry, fleetCarry };
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
 * Decisions sharing a `newHeadOid` collapse into one when both the shell and
 * the fleet carry agree; any disagreement is a conflict, since the same head
 * cannot carry two different answers.
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
 * The equality check itself: one linear pass over the deduped decisions, in
 * which the fleet is lax (carrying where the shell did not) or stricter
 * (not carrying where the shell did) — either breaks the equality criterion.
 */
function compareCarries(decisions: readonly ScopedDecision[]): ShadowPremergeCarryEvaluation {
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
    };
  }
  return {
    status: 'pass',
    reason: 'carry-decisions-equal',
    compared: decisions.length,
    laxCarries: 0,
    stricterNoCarries: 0,
  };
}
