/**
 * FC13B: pure weekly SLO report builder and deterministic plain-text
 * renderer for plan item FC-13.4, on top of the FC13A calculators.
 *
 * Both exported functions read their untrusted object exactly once through
 * `snapshotPlainData` from `@fleet/shared`: the snapshot deep-copies plain
 * JSON-like data into frozen objects and dense frozen arrays while refusing
 * Proxies, accessors, cycles, sparse arrays and oversized shapes without
 * running a single getter or Proxy trap. Every downstream check runs on the
 * frozen copy, every failure is a typed refusal that never echoes a rejected
 * value, sample or stack, and this module is domain-only: no clock read, no
 * randomness, no network, no filesystem, no persistence, no `console.*`.
 */

import { snapshotPlainData } from '@fleet/shared';
import type { IsProxy, PlainDataRefusalReason } from '@fleet/shared';

import { isCalendarDateTime } from './plain-record-reads.js';
import {
  MAX_SLO_SAMPLES,
  summariseAdmissionSlo,
  summariseParkNotifySlo,
} from './slo-calculators.js';
import type {
  AdmissionSloSummary,
  ParkNotifySloSummary,
  SloSummaryRefusalReason,
} from './slo-calculators.js';

export type { IsProxy };

/** The SLOs a weekly report can breach. */
export type SloBreachName = 'admission' | 'park-notify';

/** Calculator-level refusal reasons carried by the wrapper refusals. */
export type SloReportCalculatorRefusalReason = SloSummaryRefusalReason | 'invalid-slo-input';

/** One week's SLO outcome: both summaries plus the derived breach list. */
export interface WeeklySloReport {
  readonly weekStartIso: string;
  readonly weekEndIso: string;
  readonly admission: AdmissionSloSummary;
  readonly parkNotify: ParkNotifySloSummary;
  readonly breaches: readonly SloBreachName[];
}

export type WeeklySloReportResult =
  | { readonly ok: true; readonly report: WeeklySloReport }
  | { readonly ok: false; readonly reason: 'invalid-week' }
  | {
      readonly ok: false;
      readonly reason: 'admission-refused' | 'park-notify-refused';
      readonly calculatorReason: SloReportCalculatorRefusalReason;
    };

export type RenderSloReportTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'invalid-report' };

/**
 * Snapshot bounds for the weekly report input: depth 5 (root `0` ->
 * wrapper `1` -> `samplesMs` `2` -> sample `3` -> field `4`), at most 8 keys
 * per object, at most `MAX_SLO_SAMPLES` array items, `MAX_SLO_SAMPLES * 6 + 18`
 * nodes (two full `100_000`-sample lists of 3 nodes each plus wrapper and
 * root overhead) and 64-character strings — all enforced by
 * `snapshotPlainData` before any unbounded traversal.
 */
const BUILD_LIMITS = Object.freeze({
  maxDepth: 5,
  maxKeys: 8,
  maxArrayLength: MAX_SLO_SAMPLES,
  maxNodes: MAX_SLO_SAMPLES * 6 + 18,
  maxStringLength: 64,
});

/**
 * Snapshot bounds for an already-built report: depth 4 (root `0` ->
 * `admission`/`parkNotify`/`breaches` `1` -> summary field or breach string
 * `2`), at most 8 keys (top-level 5, `admission` 6, `parkNotify` 7), at
 * most 2 array items (`breaches`), 32 nodes and 64-character strings.
 */
const RENDER_LIMITS = Object.freeze({
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 2,
  maxNodes: 32,
  maxStringLength: 64,
});

/** Exactly seven days, the only span a weekly report may cover. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The strict zoned ISO-8601 instant shape every timestamp field must carry. */
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

const ADMISSION_SUMMARY_KEYS: readonly string[] = ['ok', 'count', 'invalid', 'p50Ms', 'p95Ms', 'met'];
const PARK_NOTIFY_SUMMARY_KEYS: readonly string[] = [
  'ok',
  'count',
  'invalid',
  'unnotified',
  'p50Ms',
  'p95Ms',
  'met',
];

const INVALID_REPORT: RenderSloReportTextResult = Object.freeze({ ok: false, reason: 'invalid-report' });

/**
 * True when `value` is a strict zoned ISO-8601 instant (`...Z` or
 * `...[+-]HH:MM` with `HH <= 23` and `MM <= 59`) naming a real calendar
 * instant. The regex cannot refuse `Date.parse` rollovers (`02-31`) or hour
 * 24, so `isCalendarDateTime` validates the calendar fields; `Date.parse`
 * only runs on the regex-accepted shape and must still be finite. O(length
 * of the candidate string), which the snapshot caps at 64 characters.
 */
function isZonedIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONED_ISO_PATTERN.test(value) || !isCalendarDateTime(value)) {
    return false;
  }
  if (!value.endsWith('Z')) {
    const offset = value.slice(-6);
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

/**
 * Whether `value` is a plain non-array object carrying exactly the given own
 * string keys and no own `__proto__` (which the snapshot copies as data).
 * One `Reflect.ownKeys` enumeration: the count is compared with
 * `keys.length` first, then each key against the expected set, so missing,
 * extra, symbol and prototype-polluting keys (`__proto__`, `constructor`,
 * `prototype`) are refused in O(own keys), one enumeration, capped at
 * `maxKeys: 8`, without reading a single property value.
 */
function isExactPlainRecord(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    return false;
  }
  const expected = new Set<string>(keys);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || key === '__proto__' || !expected.has(key)) {
      return false;
    }
  }
  return !Object.hasOwn(value, '__proto__');
}

/**
 * The injected detector inside try/catch: a detector that returns `true` or
 * throws refuses. O(1) per call; the snapshot has already refused Proxies on
 * the read path, so this is defence in depth for the calculator boundary,
 * which takes no detector of its own.
 */
function detectorRefuses(isProxy: IsProxy, value: unknown): boolean {
  try {
    return isProxy(value) === true;
  } catch {
    return true;
  }
}

/** A wrapper-shaped refusal: which SLO refused and why, echoing no values. */
interface WrapperRefusal {
  readonly ok: false;
  readonly reason: 'admission-refused' | 'park-notify-refused';
  readonly calculatorReason: SloReportCalculatorRefusalReason;
}

function wrapperRefusal(
  reason: 'admission-refused' | 'park-notify-refused',
  calculatorReason: SloReportCalculatorRefusalReason,
): WrapperRefusal {
  return { ok: false, reason, calculatorReason };
}

function isWrapperPath(path: string, wrapper: 'admission' | 'parkNotify'): boolean {
  return path === wrapper || path.startsWith(`${wrapper}.`) || path.startsWith(`${wrapper}[`);
}

/**
 * Maps one snapshot refusal inside a wrapper onto the calculator-shaped
 * refusal: the wrapper's own `objectiveMs` subpath is `invalid-objective`,
 * its `samplesMs` subpath is `too-many-samples` for an over-long array and
 * `invalid-samples-list` otherwise, and every other subpath (including an
 * over-limit element or an unexpected deeper key) is `invalid-slo-input`.
 */
function mapWrapperSnapshotPath(
  refused: 'admission-refused' | 'park-notify-refused',
  wrapper: 'admission' | 'parkNotify',
  reason: PlainDataRefusalReason,
  path: string,
): WeeklySloReportResult {
  if (path === `${wrapper}.objectiveMs` || path.startsWith(`${wrapper}.objectiveMs.`)) {
    return wrapperRefusal(refused, 'invalid-objective');
  }
  if (
    path === `${wrapper}.samplesMs` ||
    path.startsWith(`${wrapper}.samplesMs.`) ||
    path.startsWith(`${wrapper}.samplesMs[`)
  ) {
    return wrapperRefusal(refused, reason === 'too-many-items' ? 'too-many-samples' : 'invalid-samples-list');
  }
  return wrapperRefusal(refused, 'invalid-slo-input');
}

/**
 * Maps one snapshot refusal onto the typed build refusal: only `admission`
 * and `parkNotify` paths reach the wrapper refusals (never a fallback), and
 * every other path — the root itself, `weekStartIso`, an unexpected root
 * key such as `extra` or `extra[*]`, or `null` (a non-function detector) —
 * falls through to `invalid-week`.
 */
function mapSnapshotRefusalToBuild(
  reason: PlainDataRefusalReason,
  path: string | null,
): WeeklySloReportResult {
  if (path !== null && isWrapperPath(path, 'admission')) {
    return mapWrapperSnapshotPath('admission-refused', 'admission', reason, path);
  }
  if (path !== null && isWrapperPath(path, 'parkNotify')) {
    return mapWrapperSnapshotPath('park-notify-refused', 'parkNotify', reason, path);
  }
  return { ok: false, reason: 'invalid-week' };
}

type ReadWrapperResult =
  | { readonly ok: true; readonly samplesMs: unknown; readonly objectiveMs: unknown }
  | { readonly ok: false; readonly refusal: WrapperRefusal };

/**
 * Exact-key and detector validation of one wrapper on the frozen snapshot:
 * the wrapper must be a plain non-array object with exactly the own keys
 * `samplesMs` and `objectiveMs` and no own `__proto__`. Because
 * `summariseAdmissionSlo` and `summariseParkNotifySlo` take no detector,
 * `isProxy` runs here — inside try/catch — on the wrapper, on `samplesMs`
 * and on the fresh objective `{ p95Ms: objectiveMs }` immediately before
 * the calculators are called; a positive or throwing detector maps to
 * `invalid-slo-input`, `invalid-samples-list` or `invalid-objective`
 * respectively. O(own keys), one enumeration, plus O(1) detector calls.
 */
function readWrapper(
  value: unknown,
  isProxy: IsProxy,
  refused: 'admission-refused' | 'park-notify-refused',
): ReadWrapperResult {
  if (!isExactPlainRecord(value, ['samplesMs', 'objectiveMs'])) {
    return { ok: false, refusal: wrapperRefusal(refused, 'invalid-slo-input') };
  }
  const wrapper = value as Record<string, unknown>;
  if (detectorRefuses(isProxy, wrapper)) {
    return { ok: false, refusal: wrapperRefusal(refused, 'invalid-slo-input') };
  }
  if (detectorRefuses(isProxy, wrapper.samplesMs)) {
    return { ok: false, refusal: wrapperRefusal(refused, 'invalid-samples-list') };
  }
  const objective = { p95Ms: wrapper.objectiveMs };
  if (detectorRefuses(isProxy, objective)) {
    return { ok: false, refusal: wrapperRefusal(refused, 'invalid-objective') };
  }
  return { ok: true, samplesMs: wrapper.samplesMs, objectiveMs: wrapper.objectiveMs };
}

/**
 * The breach rule shared by the builder and the renderer: a summary breaches
 * when it did not meet its objective AND it observed at least one sample —
 * invalid (or, for park-notify, unnotified) samples count even when
 * `count === 0`, so a week of only-bad samples can never hide a breach,
 * while an empty week (`count === 0, invalid === 0`) does not. O(1).
 */
function isBreached(count: number, invalid: number, unnotified: number, met: boolean): boolean {
  return !met && count + invalid + unnotified > 0;
}

/**
 * Builds the weekly SLO report from an untrusted input object.
 *
 * The input is read exactly once through `snapshotPlainData` with
 * `BUILD_LIMITS`; every later check runs on the frozen snapshot copy. The
 * root must be a plain non-array object with exactly the own keys
 * `weekStartIso`, `admission` and `parkNotify`; `weekStartIso` must be a
 * strict zoned ISO-8601 instant and `weekEndIso` is derived as exactly seven
 * UTC days later (DST-free), never read from the input. The two wrappers are
 * validated the same way and handed to the FC13A calculators, whose refusal
 * reasons are propagated verbatim without echoing any sample or rejected
 * value. Never throws; every failure is a typed refusal.
 */
export function buildWeeklySloReport(input: unknown, isProxy: IsProxy): WeeklySloReportResult {
  const snapshot = snapshotPlainData(input, isProxy, BUILD_LIMITS);
  if (!snapshot.ok) {
    return mapSnapshotRefusalToBuild(snapshot.reason, snapshot.path);
  }
  const root = snapshot.value;
  if (!isExactPlainRecord(root, ['weekStartIso', 'admission', 'parkNotify'])) {
    return { ok: false, reason: 'invalid-week' };
  }
  const record = root as Record<string, unknown>;
  const weekStartIso = record.weekStartIso;
  if (!isZonedIsoInstant(weekStartIso)) {
    return { ok: false, reason: 'invalid-week' };
  }
  const weekEndIso = new Date(Date.parse(weekStartIso) + WEEK_MS).toISOString();

  const admission = readWrapper(record.admission, isProxy, 'admission-refused');
  if (!admission.ok) {
    return admission.refusal;
  }
  const parkNotify = readWrapper(record.parkNotify, isProxy, 'park-notify-refused');
  if (!parkNotify.ok) {
    return parkNotify.refusal;
  }

  const admissionSummary = summariseAdmissionSlo(admission.samplesMs, { p95Ms: admission.objectiveMs });
  if (!admissionSummary.ok) {
    return { ok: false, reason: 'admission-refused', calculatorReason: admissionSummary.reason };
  }
  const parkNotifySummary = summariseParkNotifySlo(parkNotify.samplesMs, { p95Ms: parkNotify.objectiveMs });
  if (!parkNotifySummary.ok) {
    return { ok: false, reason: 'park-notify-refused', calculatorReason: parkNotifySummary.reason };
  }

  const breaches: SloBreachName[] = [];
  if (isBreached(admissionSummary.count, admissionSummary.invalid, 0, admissionSummary.met)) {
    breaches.push('admission');
  }
  if (
    isBreached(
      parkNotifySummary.count,
      parkNotifySummary.invalid,
      parkNotifySummary.unnotified,
      parkNotifySummary.met,
    )
  ) {
    breaches.push('park-notify');
  }

  return {
    ok: true,
    report: {
      weekStartIso,
      weekEndIso,
      admission: admissionSummary,
      parkNotify: parkNotifySummary,
      breaches,
    },
  };
}

/** The neutral summary shape both render-side wrappers validate into. */
interface SummaryView {
  readonly count: number;
  readonly invalid: number;
  readonly unnotified: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly met: boolean;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeMs(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/**
 * Exact-key and field validation of one rendered summary: `ok` must be the
 * boolean `true`, the counters non-negative safe integers, the percentiles
 * finite non-negative numbers or `null`, and `met` a boolean. O(own keys),
 * one enumeration, capped at `maxKeys: 8`; null otherwise.
 */
function readSummary(value: unknown, keys: readonly string[]): SummaryView | null {
  if (!isExactPlainRecord(value, keys)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== true) {
    return null;
  }
  const count = record.count;
  const invalid = record.invalid;
  if (!isNonNegativeSafeInteger(count) || !isNonNegativeSafeInteger(invalid)) {
    return null;
  }
  let unnotified = 0;
  if (keys.includes('unnotified')) {
    const raw = record.unnotified;
    if (!isNonNegativeSafeInteger(raw)) {
      return null;
    }
    unnotified = raw;
  }
  const p50Ms = record.p50Ms;
  const p95Ms = record.p95Ms;
  if (!isNullableNonNegativeMs(p50Ms) || !isNullableNonNegativeMs(p95Ms)) {
    return null;
  }
  if (typeof record.met !== 'boolean') {
    return null;
  }
  return { count, invalid, unnotified, p50Ms, p95Ms, met: record.met };
}

/**
 * The calculator outcome invariants every rendered summary must satisfy:
 * `count === 0` forces null percentiles and `met: false`; `count > 0`
 * requires both percentiles non-null with `p50Ms <= p95Ms`; any invalid (or,
 * for park-notify, unnotified) sample forces `met: false`. O(1).
 */
function contradictsCalculatorOutcome(summary: SummaryView): boolean {
  if (summary.count === 0) {
    if (summary.p50Ms !== null || summary.p95Ms !== null || summary.met !== false) {
      return true;
    }
  } else if (summary.p50Ms === null || summary.p95Ms === null || summary.p50Ms > summary.p95Ms) {
    return true;
  }
  if (summary.invalid > 0 && summary.met) {
    return true;
  }
  if (summary.unnotified > 0 && summary.met) {
    return true;
  }
  return false;
}

/**
 * Validates the `breaches` array (bounded to 2 entries by the snapshot's
 * `maxArrayLength: 2` and re-checked here in O(2)) and requires it to equal
 * the breach list derived from the two summaries exactly — same entries, no
 * duplicates, in builder order (`admission` before `park-notify`). Null when
 * the array or its content is invalid or contradicts the outcomes.
 */
function readBreaches(
  value: unknown,
  admission: SummaryView,
  parkNotify: SummaryView,
): readonly SloBreachName[] | null {
  if (!Array.isArray(value) || value.length > 2) {
    return null;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if ((entry !== 'admission' && entry !== 'park-notify') || seen.has(entry)) {
      return null;
    }
    seen.add(entry);
  }
  const derived: SloBreachName[] = [];
  if (isBreached(admission.count, admission.invalid, 0, admission.met)) {
    derived.push('admission');
  }
  if (isBreached(parkNotify.count, parkNotify.invalid, parkNotify.unnotified, parkNotify.met)) {
    derived.push('park-notify');
  }
  if (value.length !== derived.length) {
    return null;
  }
  for (let index = 0; index < derived.length; index += 1) {
    if (value[index] !== derived[index]) {
      return null;
    }
  }
  return derived;
}

/** Integers as-is, `null` spelled out; no locale formatting, no clock. */
function formatNullableMs(value: number | null): string {
  return value === null ? 'null' : String(value);
}

/**
 * One deterministic SLO line: fixed key order, the SLO name and the sample
 * `count` always present; a breached line starts with the word `BREACH`.
 */
function sloLine(
  name: 'admission' | 'park-notify',
  summary: SummaryView,
  breached: boolean,
  includeUnnotified: boolean,
): string {
  const fields = [`count=${summary.count}`, `invalid=${summary.invalid}`];
  if (includeUnnotified) {
    fields.push(`unnotified=${summary.unnotified}`);
  }
  fields.push(
    `p50Ms=${formatNullableMs(summary.p50Ms)}`,
    `p95Ms=${formatNullableMs(summary.p95Ms)}`,
    `met=${summary.met}`,
  );
  return `${breached ? 'BREACH ' : ''}slo ${name} ${fields.join(' ')}`;
}

/**
 * Renders an already-built weekly SLO report as a deterministic plain-text
 * block.
 *
 * The report is read exactly once through `snapshotPlainData` with
 * `RENDER_LIMITS`; every later check runs on the frozen snapshot copy. The
 * root must be a plain non-array object with exactly the own keys
 * `weekStartIso`, `weekEndIso`, `admission`, `parkNotify` and `breaches`;
 * both timestamps must be strict zoned ISO instants exactly seven UTC days
 * apart; both summaries must carry the exact 6-key (`admission`) / 7-key
 * (`parkNotify`) sets with `ok === true` and must satisfy the calculator
 * outcome invariants; `breaches` must equal the list derived from the two
 * summaries exactly. Any refusal is `{ ok: false, reason: 'invalid-report' }`
 * and echoes nothing. Never throws; no clock, no randomness, no locale.
 */
export function renderSloReportText(report: unknown, isProxy: IsProxy): RenderSloReportTextResult {
  const snapshot = snapshotPlainData(report, isProxy, RENDER_LIMITS);
  if (!snapshot.ok) {
    return INVALID_REPORT;
  }
  const root = snapshot.value;
  if (!isExactPlainRecord(root, ['weekStartIso', 'weekEndIso', 'admission', 'parkNotify', 'breaches'])) {
    return INVALID_REPORT;
  }
  const record = root as Record<string, unknown>;
  const weekStartIso = record.weekStartIso;
  const weekEndIso = record.weekEndIso;
  if (!isZonedIsoInstant(weekStartIso) || !isZonedIsoInstant(weekEndIso)) {
    return INVALID_REPORT;
  }
  if (Date.parse(weekEndIso) - Date.parse(weekStartIso) !== WEEK_MS) {
    return INVALID_REPORT;
  }
  const admission = readSummary(record.admission, ADMISSION_SUMMARY_KEYS);
  const parkNotify = readSummary(record.parkNotify, PARK_NOTIFY_SUMMARY_KEYS);
  if (admission === null || parkNotify === null) {
    return INVALID_REPORT;
  }
  if (contradictsCalculatorOutcome(admission) || contradictsCalculatorOutcome(parkNotify)) {
    return INVALID_REPORT;
  }
  const breaches = readBreaches(record.breaches, admission, parkNotify);
  if (breaches === null) {
    return INVALID_REPORT;
  }

  const lines = [
    `week ${weekStartIso} to ${weekEndIso}`,
    `breaches ${breaches.length === 0 ? 'none' : breaches.join(',')}`,
    sloLine(
      'admission',
      admission,
      isBreached(admission.count, admission.invalid, 0, admission.met),
      false,
    ),
    sloLine(
      'park-notify',
      parkNotify,
      isBreached(parkNotify.count, parkNotify.invalid, parkNotify.unnotified, parkNotify.met),
      true,
    ),
  ];
  return { ok: true, text: `${lines.join('\n')}\n` };
}
