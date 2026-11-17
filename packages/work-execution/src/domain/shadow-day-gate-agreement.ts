// Lane SH11: the S4' evaluator. For one shadow day, the conductor's recorded
// gate verdict on each conducted-run head is compared with the CI `gate`
// context on the same commit. Pure over already-assembled facts: no
// filesystem, no subprocess, no clock. Never throws, never echoes an input
// value; the only exported function takes `unknown` and returns a typed
// evaluation whose refusal carries a named reason code.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { isCalendarDateTime, readExactPlainRecord } from './plain-record-reads.js';
import { compareShadowGateVerdicts } from './shadow-comparators.js';
import type { ShadowComparisonResult, ShadowDivergence } from './shadow-comparators.js';
import type { ShadowCriterionEvaluation, ShadowCriterionStatus } from './shadow-evidence-ledger.js';

/** Heads that must agree across the trailing window before a day can pass. */
export const SHADOW_GATE_MIN_AGREEING_HEADS = 30;

/** Sanity cap. An input longer than this is refused before any element is read. */
export const SHADOW_GATE_MAX_HEADS = 2_000;

/** Trailing UTC days compared for day D: D-2, D-1 and D. */
export const SHADOW_GATE_WINDOW_DAYS = 3;

/** CI check context this criterion compares. Also the comparator predicate. */
export const SHADOW_GATE_CONTEXT = 'gate';

/** The six CI check states. Declared here; not imported from a port. */
export type ShadowGateCiState = 'success' | 'failure' | 'pending' | 'missing' | 'other' | 'ambiguous';

/** One conducted-run head already paired with its conductor verdict and CI gate state. */
export interface ShadowGateHeadFact {
  readonly headOid: string;
  readonly conductorVerdict: 'pass' | 'fail';
  readonly pushedAtIso: string;
  readonly ciGate: ShadowGateCiState;
}

/** The facts SH18 assembles. This unit only evaluates them. */
export interface ShadowGateAgreementInput {
  readonly day: string;
  readonly heads: readonly ShadowGateHeadFact[];
}

/** S4' for one day: the shared criterion shape plus counts. Codes and counts only. */
export type ShadowGateAgreementEvaluation = ShadowCriterionEvaluation & {
  readonly compared: number;
  readonly agreeing: number;
  readonly falsePasses: number;
  readonly stricterFails: number;
  readonly unsettled: number;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_KEYS: readonly string[] = ['day', 'heads'];
const HEAD_KEYS: readonly string[] = ['headOid', 'conductorVerdict', 'pushedAtIso', 'ciGate'];
const INCOMPLETE_CODES: ReadonlySet<string> = new Set(['invalid-item', 'missing-in-fleet', 'missing-in-shell']);
const GATE_KEY_SUFFIX = `#${SHADOW_GATE_CONTEXT}`;

interface GateCounts {
  readonly compared: number;
  readonly agreeing: number;
  readonly falsePasses: number;
  readonly stricterFails: number;
  readonly unsettled: number;
}

interface CalendarDay {
  readonly windowStartMs: number;
  readonly dayStartMs: number;
  readonly endMs: number;
}

interface BoundedArray {
  readonly array: readonly unknown[];
  readonly length: number;
}

interface ValidHead {
  readonly headOid: string;
  readonly conductorVerdict: 'pass' | 'fail';
  readonly pushedAtMs: number;
  readonly ciGate: ShadowGateCiState;
}

interface GateItem {
  readonly headOid: string;
  readonly predicate: typeof SHADOW_GATE_CONTEXT;
  readonly verdict: 'pass' | 'fail';
}

interface DivergenceTally {
  readonly falsePasses: number;
  readonly stricterFails: number;
  readonly valueDiffers: number;
  readonly falsePassOnDay: boolean;
}

const ZERO_COUNTS: GateCounts = Object.freeze({
  compared: 0,
  agreeing: 0,
  falsePasses: 0,
  stricterFails: 0,
  unsettled: 0,
});

/** Cost: O(1). Copies the five counts onto a frozen result and returns it. */
function evaluation(status: ShadowCriterionStatus, reason: string, counts: GateCounts): ShadowGateAgreementEvaluation {
  return Object.freeze({
    status,
    reason,
    compared: counts.compared,
    agreeing: counts.agreeing,
    falsePasses: counts.falsePasses,
    stricterFails: counts.stricterFails,
    unsettled: counts.unsettled,
  });
}

const INVALID_INPUT = evaluation('unknown', 'invalid-input', ZERO_COUNTS);
const CONFLICTING = evaluation('unknown', 'gate-facts-conflicting', ZERO_COUNTS);
const INCOMPLETE = evaluation('unknown', 'gate-comparison-incomplete', ZERO_COUNTS);

/** Cost: O(1). One string comparison. */
function isConductorVerdict(value: unknown): value is 'pass' | 'fail' {
  return value === 'pass' || value === 'fail';
}

/** Cost: O(1). One set lookup over the six named CI codes. */
function isCiGate(value: unknown): value is ShadowGateCiState {
  return (
    value === 'success' ||
    value === 'failure' ||
    value === 'pending' ||
    value === 'missing' ||
    value === 'other' ||
    value === 'ambiguous'
  );
}

/** Cost: O(1). Settled means the CI check has a success or failure state. */
function isSettledGate(ciGate: ShadowGateCiState): boolean {
  return ciGate === 'success' || ciGate === 'failure';
}

/**
 * Cost: O(1) descriptor reads. Returns the length when it is a safe integer
 * in `0..cap`, otherwise null. An accessor length is refused here, and an
 * over-cap length returns before the caller looks at any index.
 */
function cappedLength(descriptor: PropertyDescriptor | undefined, cap: number): number | null {
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    return null;
  }
  const { value } = descriptor;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > cap) {
    return null;
  }
  return value;
}

/**
 * Cost: O(1) plus one key listing of a length already known to be within
 * `cap`. A real dense array, or null. The length comes from its own
 * descriptor, never from a `.length` read, so a Proxy `get` trap cannot
 * shorten the walk. Over-cap lengths return before `Object.keys`.
 */
function readBoundedArray(value: unknown, cap: number): BoundedArray | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const length = cappedLength(Object.getOwnPropertyDescriptor(value, 'length'), cap);
  if (length === null) {
    return null;
  }
  if (Object.keys(value).length !== length) {
    return null;
  }
  return { array: value, length };
}

/** Cost: O(1). One own descriptor read; a hole or an accessor yields undefined and its getter does not run. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

/** Cost: O(1). Year 2000-9999, so `Date.UTC` cannot hit its two-digit-year trap. */
function isSupportedYear(year: number): boolean {
  return year >= 2000 && year <= 9999;
}

/**
 * Cost: O(1). A real `YYYY-MM-DD` in 2000-9999, plus the half-open windows
 * W = [D-2 00:00Z, D+1 00:00Z) and D = [D 00:00Z, D+1 00:00Z), both from
 * `Date.UTC` on the validated fields.
 */
function readCalendarDay(value: unknown): CalendarDay | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const dayOfMonth = Number(value.slice(8, 10));
  if (!isSupportedYear(year) || !isCalendarDateTime(`${value}T00:00:00Z`)) {
    return null;
  }
  const monthIndex = month - 1;
  const daysBefore = SHADOW_GATE_WINDOW_DAYS - 1;
  return {
    windowStartMs: Date.UTC(year, monthIndex, dayOfMonth - daysBefore),
    dayStartMs: Date.UTC(year, monthIndex, dayOfMonth),
    endMs: Date.UTC(year, monthIndex, dayOfMonth + 1),
  };
}

/** Cost: O(1). Four descriptor reads inside `readExactPlainRecord`, then constant checks. */
function readHead(raw: unknown): ValidHead | null {
  const record = readExactPlainRecord(raw, HEAD_KEYS);
  if (record === null) {
    return null;
  }
  const { headOid, conductorVerdict, pushedAtIso, ciGate } = record;
  if (!isMergeHex40(headOid) || !isConductorVerdict(conductorVerdict)) {
    return null;
  }
  if (!isZonedIsoDateTime(pushedAtIso) || !isCiGate(ciGate)) {
    return null;
  }
  return { headOid, conductorVerdict, pushedAtMs: Date.parse(pushedAtIso), ciGate };
}

/**
 * Cost: linear in the capped length, at most `SHADOW_GATE_MAX_HEADS`
 * descriptor reads. Null when the value is not a dense array within the cap
 * or any element is out of shape. The cap is applied before the loop.
 */
function readHeads(value: unknown): readonly ValidHead[] | null {
  const bounded = readBoundedArray(value, SHADOW_GATE_MAX_HEADS);
  if (bounded === null) {
    return null;
  }
  const heads: ValidHead[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const head = readHead(ownElement(bounded.array, index));
    if (head === null) {
      return null;
    }
    heads.push(head);
  }
  return heads;
}

/** Cost: O(1). Half-open instant check against the two bounds. */
function isInside(instantMs: number, startMs: number, endMs: number): boolean {
  return instantMs >= startMs && instantMs < endMs;
}

/** Cost: O(1). Identical facts share the conductor verdict and the CI state. */
function sameFacts(left: ValidHead, right: ValidHead): boolean {
  return left.conductorVerdict === right.conductorVerdict && left.ciGate === right.ciGate;
}

/**
 * Cost: O(1). Keeps `head` when it is new or an earlier copy of the same
 * facts. Returns false when the same oid disagrees, which refuses the day.
 */
function absorb(kept: Map<string, ValidHead>, head: ValidHead): boolean {
  const prior = kept.get(head.headOid);
  if (prior === undefined) {
    kept.set(head.headOid, head);
    return true;
  }
  if (!sameFacts(prior, head)) {
    return false;
  }
  if (head.pushedAtMs < prior.pushedAtMs) {
    kept.set(head.headOid, head);
  }
  return true;
}

/**
 * Cost: linear in the capped head list. Heads outside W are ignored.
 * Identical in-window copies collapse to the earliest push. A disagreement
 * returns null.
 */
function dedupeInWindow(heads: readonly ValidHead[], day: CalendarDay): Map<string, ValidHead> | null {
  const kept = new Map<string, ValidHead>();
  for (const head of heads) {
    if (!isInside(head.pushedAtMs, day.windowStartMs, day.endMs)) {
      continue;
    }
    if (!absorb(kept, head)) {
      return null;
    }
  }
  return kept;
}

/** Cost: linear in the deduped heads, at most `SHADOW_GATE_MAX_HEADS`. */
function splitSettled(kept: ReadonlyMap<string, ValidHead>): { readonly settled: readonly ValidHead[]; readonly unsettled: number } {
  const settled: ValidHead[] = [];
  let unsettled = 0;
  for (const head of kept.values()) {
    if (isSettledGate(head.ciGate)) {
      settled.push(head);
    } else {
      unsettled += 1;
    }
  }
  return { settled, unsettled };
}

/** Cost: O(1). One plain object the comparator can read without touching caller input. */
function toFleetItem(head: ValidHead): GateItem {
  return { headOid: head.headOid, predicate: SHADOW_GATE_CONTEXT, verdict: head.conductorVerdict };
}

/** Cost: O(1). CI success is a shell pass; CI failure is a shell fail. */
function toShellItem(head: ValidHead): GateItem {
  return {
    headOid: head.headOid,
    predicate: SHADOW_GATE_CONTEXT,
    verdict: head.ciGate === 'success' ? 'pass' : 'fail',
  };
}

/** Cost: O(1). The 40-hex oid in front of `#gate`, or null when the key is not that shape. */
function headOidFromGateKey(key: string): string | null {
  if (key.length !== 40 + GATE_KEY_SUFFIX.length || !key.endsWith(GATE_KEY_SUFFIX)) {
    return null;
  }
  const headOid = key.slice(0, 40);
  return isMergeHex40(headOid) ? headOid : null;
}

/**
 * Cost: O(1) map lookup. A false pass whose key is not one of our heads is
 * unmapped (null): the comparator result is not what this function built.
 */
function falsePassOnDay(key: string, kept: ReadonlyMap<string, ValidHead>, day: CalendarDay): boolean | null {
  const headOid = headOidFromGateKey(key);
  if (headOid === null) {
    return null;
  }
  const head = kept.get(headOid);
  if (head === undefined) {
    return null;
  }
  return isInside(head.pushedAtMs, day.dayStartMs, day.endMs);
}

/** Cost: O(1). Classifies one divergence. Null means the comparison cannot be trusted. */
function placeDivergence(divergence: ShadowDivergence, kept: ReadonlyMap<string, ValidHead>, day: CalendarDay): DivergenceTally | null {
  if (divergence.code === 'false-pass') {
    const onDay = falsePassOnDay(divergence.key, kept, day);
    if (onDay === null) {
      return null;
    }
    return { falsePasses: 1, stricterFails: 0, valueDiffers: 0, falsePassOnDay: onDay };
  }
  if (divergence.code === 'stricter-fail') {
    return { falsePasses: 0, stricterFails: 1, valueDiffers: 0, falsePassOnDay: false };
  }
  if (divergence.code === 'value-differs') {
    return { falsePasses: 0, stricterFails: 0, valueDiffers: 1, falsePassOnDay: false };
  }
  return null;
}

/** Cost: linear in the listed divergences, which the comparator caps at `SHADOW_DIVERGENCE_MAX`. */
function tallyDivergences(
  divergences: readonly ShadowDivergence[],
  kept: ReadonlyMap<string, ValidHead>,
  day: CalendarDay,
): DivergenceTally | null {
  let falsePasses = 0;
  let stricterFails = 0;
  let valueDiffers = 0;
  let falsePassOnDay = false;
  for (const divergence of divergences) {
    const placed = placeDivergence(divergence, kept, day);
    if (placed === null) {
      return null;
    }
    falsePasses += placed.falsePasses;
    stricterFails += placed.stricterFails;
    valueDiffers += placed.valueDiffers;
    falsePassOnDay = falsePassOnDay || placed.falsePassOnDay;
  }
  return { falsePasses, stricterFails, valueDiffers, falsePassOnDay };
}

/** Cost: linear in the listed divergences. */
function hasIncompleteDivergence(divergences: readonly ShadowDivergence[]): boolean {
  for (const divergence of divergences) {
    if (INCOMPLETE_CODES.has(divergence.code)) {
      return true;
    }
  }
  return false;
}

/** Cost: O(1). Agreeing is `compared` minus the tallied divergence kinds. */
function countsFrom(compared: number, tallies: DivergenceTally, unsettled: number): GateCounts {
  return {
    compared,
    agreeing: compared - tallies.falsePasses - tallies.stricterFails - tallies.valueDiffers,
    falsePasses: tallies.falsePasses,
    stricterFails: tallies.stricterFails,
    unsettled,
  };
}

/** Cost: O(1) once the tallies exist. False pass on D outranks the agreeing-head floor. */
function decide(compared: number, tallies: DivergenceTally, unsettled: number): ShadowGateAgreementEvaluation {
  const counts = countsFrom(compared, tallies, unsettled);
  if (tallies.falsePassOnDay) {
    return evaluation('fail', 'gate-false-pass', counts);
  }
  if (counts.agreeing < SHADOW_GATE_MIN_AGREEING_HEADS) {
    return evaluation('fail', 'too-few-agreeing-heads', counts);
  }
  return evaluation('pass', 'gate-verdicts-agree', counts);
}

/**
 * Cost: linear in the comparator's listed divergences. Truncation stays
 * fail-closed (`unknown/gate-comparison-incomplete`) and carries a fresh
 * result whose counts are what the comparator computed: `compared`, the
 * divergence tallies up to the cap, and the unsettled count. A listed code
 * that means the two sides were not the heads just built contributes no counts.
 */
function verdictFromComparison(
  comparison: ShadowComparisonResult,
  kept: ReadonlyMap<string, ValidHead>,
  day: CalendarDay,
  unsettled: number,
): ShadowGateAgreementEvaluation {
  if (hasIncompleteDivergence(comparison.divergences)) {
    return INCOMPLETE;
  }
  const tallies = tallyDivergences(comparison.divergences, kept, day);
  if (tallies === null) {
    return INCOMPLETE;
  }
  if (comparison.truncated) {
    return evaluation(
      'unknown',
      'gate-comparison-incomplete',
      countsFrom(comparison.compared, tallies, unsettled),
    );
  }
  return decide(comparison.compared, tallies, unsettled);
}

/** Cost: linear in the deduped heads, bounded by `SHADOW_GATE_MAX_HEADS`, plus the comparator's own linear walk. */
function compareKept(kept: ReadonlyMap<string, ValidHead>, day: CalendarDay): ShadowGateAgreementEvaluation {
  const { settled, unsettled } = splitSettled(kept);
  const comparison = compareShadowGateVerdicts({
    fleet: settled.map(toFleetItem),
    shell: settled.map(toShellItem),
  });
  return verdictFromComparison(comparison, kept, day, unsettled);
}

/**
 * Cost: linear in the capped input. Validates the record, then the day, then
 * at most `SHADOW_GATE_MAX_HEADS` heads. An over-cap `heads` length is refused
 * inside `readHeads` before any element is read.
 */
function judgeShadowGateAgreement(input: unknown): ShadowGateAgreementEvaluation {
  const record = readExactPlainRecord(input, INPUT_KEYS);
  if (record === null) {
    return INVALID_INPUT;
  }
  const day = readCalendarDay(record.day);
  if (day === null) {
    return INVALID_INPUT;
  }
  const heads = readHeads(record.heads);
  if (heads === null) {
    return INVALID_INPUT;
  }
  const kept = dedupeInWindow(heads, day);
  if (kept === null) {
    return CONFLICTING;
  }
  return compareKept(kept, day);
}

/**
 * S4', whether conductor gate verdicts agree with the CI `gate` context for
 * shadow day D. The day passes when, over the trailing three UTC days
 * D-2..D, at least `SHADOW_GATE_MIN_AGREEING_HEADS` settled heads agree and
 * no head pushed on D is a false pass (conductor `pass`, CI `failure`). A
 * stricter conductor (`fail` against CI `success`) does not fail the day.
 * Unsettled CI states are counted and never compared. Heads pushed outside
 * [D-2 00:00Z, D+1 00:00Z) are ignored.
 *
 * Cost: linear in the capped input — at most `SHADOW_GATE_MAX_HEADS` heads
 * are read, deduplicated and compared, and an oversized, sparse or non-dense
 * `heads` array is refused from its own `length` before any element is read.
 * Every value is taken from its own property descriptor, so no getter ever
 * runs and a Proxy stand-in either is refused or yields exactly the plain
 * data's verdict. Never throws. The result carries a status, a reason code
 * and counts only — never a head oid or any other input value.
 */
export function evaluateShadowGateAgreement(input: unknown): ShadowGateAgreementEvaluation {
  try {
    return judgeShadowGateAgreement(input);
  } catch {
    // A revoked Proxy, or a trap that throws, must become a typed refusal.
    return INVALID_INPUT;
  }
}
