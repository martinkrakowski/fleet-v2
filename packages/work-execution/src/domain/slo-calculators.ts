/**
 * FC13A: pure, synchronous SLO latency calculators.
 *
 * Every function takes `unknown` at its boundary and never throws and never
 * reads a clock: the input is inspected through its own property descriptors
 * (no getter ever runs), reusing the shared hostile-input readers from
 * `./plain-record-reads.js`. Every failure is a typed refusal result; an
 * unknown state is never an implicit pass.
 */

import {
  isCalendarDateTime,
  readBoundedDenseArray,
  readExactPlainRecord,
} from './plain-record-reads.js';

/** The largest sample list any calculator accepts (refused in O(1) beyond). */
export const MAX_SLO_SAMPLES = 100_000;

/** Refusal reasons of `percentileNearestRank`. */
export type PercentileRefusalReason =
  | 'invalid-percentile'
  | 'invalid-samples-list'
  | 'too-many-samples'
  | 'no-samples'
  | 'invalid-sample';

export type PercentileResult =
  | { readonly ok: true; readonly valueMs: number }
  | { readonly ok: false; readonly reason: PercentileRefusalReason };

/** Refusal reasons shared by both SLO summaries. */
export type SloSummaryRefusalReason =
  | 'invalid-objective'
  | 'invalid-samples-list'
  | 'too-many-samples';

export interface AdmissionSloSummary {
  readonly ok: true;
  readonly count: number;
  readonly invalid: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly met: boolean;
}

export interface ParkNotifySloSummary {
  readonly ok: true;
  readonly count: number;
  readonly invalid: number;
  readonly unnotified: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly met: boolean;
}

export type SloSummaryResult =
  | AdmissionSloSummary
  | ParkNotifySloSummary
  | { readonly ok: false; readonly reason: SloSummaryRefusalReason };

/** The strict ISO-8601 UTC shape every timestamp field must carry. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * True when `value` is a strict ISO-8601 UTC timestamp naming a real calendar
 * instant. The regex alone cannot refuse `Date.parse` rollovers (02-31), so
 * `isCalendarDateTime` validates the fields; `Date.parse` only runs on the
 * regex-accepted shape and must still be finite.
 */
function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || !isCalendarDateTime(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/**
 * `readExactPlainRecord` wrapped in try/catch: `isPlainRecordObject` has no
 * try/catch of its own and throws on a revoked or throwing Proxy, so every
 * call must be guarded here and mapped to `null`.
 */
function safeReadExactPlainRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    return readExactPlainRecord(value, keys);
  } catch {
    return null;
  }
}

/**
 * The shared O(1) pre-gate before any key enumeration or element traversal:
 * inside try/catch it requires `Array.isArray`, prototype exactly
 * `Array.prototype`, and an own `length` data descriptor (no getter, no
 * setter, numeric value). A safe-integer length above `MAX_SLO_SAMPLES` is
 * refused as `too-many-samples` without ever calling `Reflect.ownKeys` or
 * scanning an element; the pre-gate throwing (revoked Proxy, throwing
 * `getOwnPropertyDescriptor` trap) is refused as `invalid-samples-list`.
 * Only then does the accepted O(K) engine bound of `readBoundedDenseArray`
 * run, whose `null` is also `invalid-samples-list`.
 */
function readSampleList(
  value: unknown,
): { readonly ok: true; readonly array: readonly unknown[] } | { readonly ok: false; readonly reason: 'too-many-samples' | 'invalid-samples-list' } {
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return { ok: false, reason: 'invalid-samples-list' };
    }
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    return { ok: false, reason: 'invalid-samples-list' };
  }
  if (
    lengthDescriptor !== undefined &&
    lengthDescriptor.get === undefined &&
    lengthDescriptor.set === undefined &&
    typeof lengthDescriptor.value === 'number' &&
    Number.isSafeInteger(lengthDescriptor.value) &&
    lengthDescriptor.value > MAX_SLO_SAMPLES
  ) {
    return { ok: false, reason: 'too-many-samples' };
  }
  const dense = readBoundedDenseArray(value, MAX_SLO_SAMPLES);
  if (dense === null) {
    return { ok: false, reason: 'invalid-samples-list' };
  }
  return { ok: true, array: dense.array };
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Nearest-rank percentile over a fresh ascending copy of already-validated samples. */
function percentileNearestRankOfValid(samplesMs: readonly number[], p: number): number {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1];
}

export function percentileNearestRank(samplesMs: unknown, p: unknown): PercentileResult {
  if (
    typeof p !== 'number' ||
    !Number.isFinite(p) ||
    p <= 0 ||
    p > 100
  ) {
    return { ok: false, reason: 'invalid-percentile' };
  }
  const samples = readSampleList(samplesMs);
  if (!samples.ok) {
    return { ok: false, reason: samples.reason };
  }
  const validated: number[] = [];
  for (const sample of samples.array) {
    if (!isFiniteNonNegativeNumber(sample)) {
      return { ok: false, reason: 'invalid-sample' };
    }
    validated.push(sample);
  }
  if (validated.length === 0) {
    return { ok: false, reason: 'no-samples' };
  }
  return { ok: true, valueMs: percentileNearestRankOfValid(validated, p) };
}

/**
 * Read the objective as a plain record whose only own enumerable data
 * property `p95Ms` is a finite non-negative number; anything else — null,
 * non-plain, extra or getter key, hostile Proxy — is `invalid-objective`.
 */
function readObjectiveP95Ms(objective: unknown): number | null {
  const record = safeReadExactPlainRecord(objective, ['p95Ms']);
  if (record === null || !isFiniteNonNegativeNumber(record.p95Ms)) {
    return null;
  }
  return record.p95Ms;
}

export function summariseAdmissionSlo(samples: unknown, objective: unknown): AdmissionSloSummary | { readonly ok: false; readonly reason: SloSummaryRefusalReason } {
  const p95Ms = readObjectiveP95Ms(objective);
  if (p95Ms === null) {
    return { ok: false, reason: 'invalid-objective' };
  }
  const sampleList = readSampleList(samples);
  if (!sampleList.ok) {
    return { ok: false, reason: sampleList.reason };
  }
  const validLatencies: number[] = [];
  let invalid = 0;
  for (const sample of sampleList.array) {
    const record = safeReadExactPlainRecord(sample, ['requestedAtIso', 'admittedAtIso']);
    if (
      record === null ||
      !isIsoUtcTimestamp(record.requestedAtIso) ||
      !isIsoUtcTimestamp(record.admittedAtIso)
    ) {
      invalid += 1;
      continue;
    }
    const requestedAtMs = Date.parse(record.requestedAtIso);
    const admittedAtMs = Date.parse(record.admittedAtIso);
    if (admittedAtMs < requestedAtMs) {
      invalid += 1;
      continue;
    }
    validLatencies.push(admittedAtMs - requestedAtMs);
  }
  if (validLatencies.length === 0) {
    return { ok: true, count: 0, invalid, p50Ms: null, p95Ms: null, met: false };
  }
  const p50 = percentileNearestRankOfValid(validLatencies, 50);
  const p95 = percentileNearestRankOfValid(validLatencies, 95);
  return {
    ok: true,
    count: validLatencies.length,
    invalid,
    p50Ms: p50,
    p95Ms: p95,
    met: invalid === 0 && p95 <= p95Ms,
  };
}

export function summariseParkNotifySlo(samples: unknown, objective: unknown): ParkNotifySloSummary | { readonly ok: false; readonly reason: SloSummaryRefusalReason } {
  const p95Ms = readObjectiveP95Ms(objective);
  if (p95Ms === null) {
    return { ok: false, reason: 'invalid-objective' };
  }
  const sampleList = readSampleList(samples);
  if (!sampleList.ok) {
    return { ok: false, reason: sampleList.reason };
  }
  const validLatencies: number[] = [];
  let invalid = 0;
  let unnotified = 0;
  for (const sample of sampleList.array) {
    const record = safeReadExactPlainRecord(sample, ['parkedAtIso', 'notifiedAtIso']);
    if (record === null || !isIsoUtcTimestamp(record.parkedAtIso)) {
      invalid += 1;
      continue;
    }
    if (record.notifiedAtIso === null) {
      unnotified += 1;
      continue;
    }
    if (!isIsoUtcTimestamp(record.notifiedAtIso)) {
      invalid += 1;
      continue;
    }
    const parkedAtMs = Date.parse(record.parkedAtIso);
    const notifiedAtMs = Date.parse(record.notifiedAtIso);
    if (notifiedAtMs < parkedAtMs) {
      invalid += 1;
      continue;
    }
    validLatencies.push(notifiedAtMs - parkedAtMs);
  }
  if (validLatencies.length === 0) {
    return {
      ok: true,
      count: 0,
      invalid,
      unnotified,
      p50Ms: null,
      p95Ms: null,
      met: false,
    };
  }
  const p50 = percentileNearestRankOfValid(validLatencies, 50);
  const p95 = percentileNearestRankOfValid(validLatencies, 95);
  return {
    ok: true,
    count: validLatencies.length,
    invalid,
    unnotified,
    p50Ms: p50,
    p95Ms: p95,
    met: invalid === 0 && unnotified === 0 && p95 <= p95Ms,
  };
}
