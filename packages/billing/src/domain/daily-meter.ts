/**
 * DailyMeter: the pure per-organisation daily shadow usage aggregate
 * (FC-10.3). Shadow only: nothing here bills, prices, charges or contacts
 * anything. Pure domain code: no Node built-ins, filesystem, subprocess,
 * network or vendor imports, no clock reads, no I/O, no `console.*`, and
 * nothing throws on hostile input.
 *
 * Hostile-input posture: the whole input is copied ONCE by the shared
 * `snapshotPlainData` guard from `@fleet/shared`, which reads own properties
 * through their descriptors only (no getter, setter or Proxy `get` trap ever
 * runs, and no value can change between check and use) and refuses accessors,
 * non-enumerable and symbol keys, sparse arrays, non-plain prototypes and,
 * with a detector, Proxies; the outer record and each row are then required
 * to carry exactly their expected keys, which also refuses `__proto__`,
 * `constructor` and `prototype`. A hostile Proxy trap surfaces as a typed
 * refusal, never a throw; a Proxy that lies consistently in every trap is an
 * accepted residual. Every hostile input maps to `invalid-input`; a
 * duplicate `attemptId`, a foreign-organisation row and a safe-integer sum
 * overflow each have their own reason. No input value is ever echoed back.
 *
 * Cost bound: the snapshot's enumerations are the minimum any correct
 * hidden-key and hidden-array-element refusal must do, O(own keys) plus
 * O(rows) with `rows` capped at `DAILY_METER_MAX_ROWS` by `maxArrayLength`
 * in O(1) before walking elements; beyond the snapshot every check is
 * O(1) per row (string lengths bounded: 63 for `organizationId`, 128 for
 * `attemptId`, 10 for a day key; safe-integer comparisons) and duplicate
 * detection is O(1) amortized via a `Set`.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

/** The maximum number of rows any single daily aggregate accepts. */
export const DAILY_METER_MAX_ROWS = 50_000;

/** One per-attempt shadow usage row: integer counts, no prices. */
export interface DailyMeterRow {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly runnerMinutes: number;
  readonly tokens: number;
  readonly modelCostMicros: number;
}

/** The aggregate request: one organisation, one calendar day, its rows. */
export interface DailyMeterInput {
  readonly organizationId: string;
  readonly dayKey: string;
  readonly rows: readonly DailyMeterRow[];
}

/** The shadow usage totals for one organisation on one calendar day. */
export interface DailyMeter {
  readonly organizationId: string;
  readonly dayKey: string;
  readonly attempts: number;
  readonly runnerMinutes: number;
  readonly tokens: number;
  readonly modelCostMicros: number;
}

/** Every reason `aggregateDailyMeter` can refuse. */
export type DailyMeterRefusalReason =
  | "invalid-input"
  | "duplicate-attempt"
  | "foreign-organization-row"
  | "sum-overflow";

/** The typed result of `aggregateDailyMeter`. */
export type DailyMeterResult =
  | { readonly ok: true; readonly meter: DailyMeter }
  | { readonly ok: false; readonly reason: DailyMeterRefusalReason };

/** Identifier shape of `organizationId` (shared with spend-cap's private copy). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Attempt identifier shape: slightly wider, at most 128 characters. */
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** An exact `YYYY-MM-DD` calendar day with captured year, month and day. */
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether the captured calendar day exists in that month of that year,
 * including the Gregorian leap-year rule. Cost bound: O(1) — fixed-size
 * arithmetic on three numeric fields.
 */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

/** The three own keys the outer record must carry, no more and no fewer. */
const METER_KEYS = ["organizationId", "dayKey", "rows"] as const;

/** The five own keys every row must carry, no more and no fewer. */
const ROW_KEYS = [
  "attemptId",
  "organizationId",
  "runnerMinutes",
  "tokens",
  "modelCostMicros",
] as const;

/**
 * Whether `value` is a non-negative safe integer (a metric count).
 * Cost bound: O(1) — two number checks.
 */
function isMetricCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `value` is a well-formed organisation identifier. Cost bound:
 * O(1) — one type check, one length bound and one bounded regular-expression
 * match over at most 63 characters.
 */
function isOrganizationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && ID_PATTERN.test(value);
}

/**
 * Whether `value` is a well-formed attempt identifier. Cost bound: O(1) —
 * one type check, one length bound and one bounded regular-expression match
 * over at most 128 characters.
 */
function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ATTEMPT_ID_PATTERN.test(value);
}

/**
 * Checked safe-integer accumulation: refuses (returns `null`) when
 * `acc + value` would leave the safe-integer range, rather than rounding.
 * Cost bound: O(1) — one comparison.
 */
function addSafe(acc: number, value: number): number | null {
  if (acc > Number.MAX_SAFE_INTEGER - value) {
    return null;
  }
  return acc + value;
}

/**
 * Whether a snapshotted value is a plain non-array, non-null object with
 * exactly `expectedKeys` (which also refuses `__proto__`, `constructor` and
 * `prototype`, none of which is expected). Only runs on the frozen snapshot
 * copy, so key checks cannot observe caller state.
 *
 * Cost bound: O(own keys) for the single `Object.keys` enumeration — the
 * minimum any correct extra-key refusal needs — then O(expectedKeys.length).
 */
function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) {
    return false;
  }
  return keys.every((key) => expectedKeys.includes(key));
}

/**
 * Aggregate shadow usage rows for one organisation on one calendar day.
 * The input is untrusted: it is copied once through `snapshotPlainData`
 * (getters never run, Proxies are refused with a detector), then the outer
 * record and every row are validated against their exact key sets and
 * field shapes. `rows` is capped at `DAILY_METER_MAX_ROWS` (50,000) in O(1)
 * by the snapshot's `maxArrayLength` before any element is walked.
 *
 * Cost bound: O(1) for the snapshot of the outer record, O(rows) for the
 * snapshot of the rows array and the row loop, each row's work O(1), and
 * duplicate detection O(1) amortized. Never throws and never echoes input
 * values: every failure is a typed `DailyMeterResult` refusal.
 */
export function aggregateDailyMeter(input: unknown, isProxy?: IsProxy): DailyMeterResult {
  // Snapshot once (cost bound): depth 3 covers root (0) -> rows (1) ->
  // row object (2) -> row primitive (3); maxKeys 5 covers the five row
  // keys (the outer record has three); maxArrayLength caps rows at 50,000;
  // maxNodes 300,004 covers 1 root + 1 rows array + 2 outer primitives +
  // up to 50,000 * 6 row nodes; maxStringLength 4096 bounds every string.
  const snapshot = snapshotPlainData(input, isProxy ?? NO_DETECTOR, {
    maxDepth: 3,
    maxKeys: 5,
    maxArrayLength: DAILY_METER_MAX_ROWS,
    maxNodes: DAILY_METER_MAX_ROWS * 6 + 4,
    maxStringLength: 4096,
  });
  if (!snapshot.ok) {
    return { ok: false, reason: "invalid-input" };
  }
  const value = snapshot.value;
  if (!hasExactKeys(value, METER_KEYS)) {
    return { ok: false, reason: "invalid-input" };
  }
  const { organizationId, dayKey, rows } = value as {
    organizationId: unknown;
    dayKey: unknown;
    rows: unknown;
  };
  if (!isOrganizationId(organizationId)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (typeof dayKey !== "string" || dayKey.length !== 10) {
    return { ok: false, reason: "invalid-input" };
  }
  const dayMatch = DAY_KEY_PATTERN.exec(dayKey);
  if (dayMatch === null) {
    return { ok: false, reason: "invalid-input" };
  }
  if (!isRealCalendarDay(Number(dayMatch[1]), Number(dayMatch[2]), Number(dayMatch[3]))) {
    return { ok: false, reason: "invalid-input" };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, reason: "invalid-input" };
  }
  const seenAttempts = new Set<string>();
  let totalRunnerMinutes = 0;
  let totalTokens = 0;
  let totalModelCostMicros = 0;
  for (const row of rows) {
    if (!hasExactKeys(row, ROW_KEYS)) {
      return { ok: false, reason: "invalid-input" };
    }
    const {
      attemptId,
      organizationId: rowOrganizationId,
      runnerMinutes,
      tokens,
      modelCostMicros,
    } = row as {
      attemptId: unknown;
      organizationId: unknown;
      runnerMinutes: unknown;
      tokens: unknown;
      modelCostMicros: unknown;
    };
    if (!isAttemptId(attemptId) || !isOrganizationId(rowOrganizationId)) {
      return { ok: false, reason: "invalid-input" };
    }
    if (!isMetricCount(runnerMinutes) || !isMetricCount(tokens) || !isMetricCount(modelCostMicros)) {
      return { ok: false, reason: "invalid-input" };
    }
    if (rowOrganizationId !== organizationId) {
      return { ok: false, reason: "foreign-organization-row" };
    }
    if (seenAttempts.has(attemptId)) {
      return { ok: false, reason: "duplicate-attempt" };
    }
    seenAttempts.add(attemptId);
    const nextRunnerMinutes = addSafe(totalRunnerMinutes, runnerMinutes);
    if (nextRunnerMinutes === null) {
      return { ok: false, reason: "sum-overflow" };
    }
    const nextTokens = addSafe(totalTokens, tokens);
    if (nextTokens === null) {
      return { ok: false, reason: "sum-overflow" };
    }
    const nextModelCostMicros = addSafe(totalModelCostMicros, modelCostMicros);
    if (nextModelCostMicros === null) {
      return { ok: false, reason: "sum-overflow" };
    }
    totalRunnerMinutes = nextRunnerMinutes;
    totalTokens = nextTokens;
    totalModelCostMicros = nextModelCostMicros;
  }
  const meter: DailyMeter = {
    organizationId,
    dayKey,
    attempts: seenAttempts.size,
    runnerMinutes: totalRunnerMinutes,
    tokens: totalTokens,
    modelCostMicros: totalModelCostMicros,
  };
  return { ok: true, meter: Object.freeze(meter) };
}
