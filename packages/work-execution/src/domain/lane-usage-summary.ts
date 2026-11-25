/**
 * LaneUsageSummary (FC10A): the pure per-lane aggregation of
 * `LaneUsageLogRow` values into a cost report. No port, adapter, store or
 * route: this module only groups and sums rows it has re-validated through
 * the row parser, and it never mutates or retains its input. `plan-estimate`
 * cost is never folded into `metered` cost; an `unknown` row contributes only
 * to `unknownCount`. A free seat's `costUsd: 0` stays `0`, distinct from
 * `null`, and an all-`null` field sums to `null`, never `0`.
 */

import {
  LANE_USAGE_LOG_MAX_ROWS,
  parseLaneUsageLogRow,
  type LaneUsageLogRow,
} from './lane-usage-log.js';
import { readBoundedDenseArray } from './plain-record-reads.js';

/** Per-lane cost totals, split by the row's declared cost basis. */
export interface LaneUsageSummaryCost {
  /** `0` when free metered rows exist with `costUsd: 0`; `null` when no `metered` row is in the lane. */
  readonly meteredUsd: number | null;
  /** `0` when free plan-estimate rows exist with `costUsd: 0`; `null` when no `plan-estimate` row is in the lane. */
  readonly planEstimateUsd: number | null;
  /** Count of rows with `costBasis: 'unknown'`; never contributes to a numeric USD total. */
  readonly unknownCount: number;
}

/** Per-lane token totals; `null` when every row in the lane lacks the field. */
export interface LaneUsageSummaryTokens {
  readonly input: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

/** One lane's aggregated usage: a run's attempts, or one run-less attempt. */
export interface LaneUsageSummary {
  /** `null` when the lane is grouped by `attemptId` (no run owns the attempt). */
  readonly runId: string | null;
  /** `null` when grouped by `runId`; the `attemptId` when `runId === null`. */
  readonly attemptId: string | null;
  readonly attemptCount: number;
  /**
   * Sum of the rows' stored `runnerMinutes` — never recomputed from
   * `wallSeconds`. `null` when all rows in the lane have `runnerMinutes: null`.
   */
  readonly runnerMinutes: number | null;
  /** Count of rows in the lane whose `runnerMinutes` is `null` or non-finite/negative. */
  readonly unmeasuredAttempts: number;
  /** Sum of the rows' `wallSeconds`; `null` when all rows lack it. */
  readonly wallSeconds: number | null;
  readonly tokens: LaneUsageSummaryTokens;
  readonly cost: LaneUsageSummaryCost;
}

export type LaneUsageSummaryFailureReason = 'invalid-rows-array' | 'invalid-row';

export type LaneUsageSummaryResult =
  | { readonly ok: true; readonly lanes: readonly LaneUsageSummary[] }
  | { readonly ok: false; readonly reason: LaneUsageSummaryFailureReason };

/**
 * True when the value is a finite non-negative number: anything else is never
 * summed, so `NaN`, `Infinity`, negatives and non-numbers can never reach an
 * accumulator and `NaN` is never returned.
 */
function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Checked accumulation: the sum is refused, not rounded, when it leaves the
 * finite or the safe-integer range. The values are integer runner-minutes (and
 * bounded token counts), so the safe-integer bound is the contract; the finite
 * check catches float cost sums whose midpoint already exceeds
 * `Number.MAX_VALUE`. `null` means "refuse", never a partial sum.
 */
function addTo(acc: number, value: number): number | null {
  const next = acc + value;
  if (!Number.isFinite(next) || acc > Number.MAX_SAFE_INTEGER - value) {
    return null;
  }
  return next;
}

/** One summable field's accumulator for a lane. */
interface SumAccumulator {
  seen: boolean;
  value: number;
  overflow: boolean;
}

function newAccumulator(): SumAccumulator {
  return { seen: false, value: 0, overflow: false };
}

function accumulate(acc: SumAccumulator, value: number | null): void {
  if (value === null) {
    return;
  }
  if (!isFiniteNonNegativeNumber(value)) {
    acc.overflow = true;
    return;
  }
  const next = addTo(acc.value, value);
  if (next === null) {
    acc.overflow = true;
    return;
  }
  acc.seen = true;
  acc.value = next;
}

/** A lane's mutable working state, keyed in a `Map` (so no key can pollute a lookup). */
interface LaneGroup {
  runId: string | null;
  attemptId: string | null;
  attemptCount: number;
  unmeasuredAttempts: number;
  runnerMinutes: SumAccumulator;
  wallSeconds: SumAccumulator;
  tokensInput: SumAccumulator;
  tokensOutput: SumAccumulator;
  tokensReasoning: SumAccumulator;
  tokensCacheRead: SumAccumulator;
  tokensCacheWrite: SumAccumulator;
  meteredUsd: SumAccumulator;
  planEstimateUsd: SumAccumulator;
  unknownCount: number;
}

function newLaneGroup(runId: string | null, attemptId: string | null): LaneGroup {
  return {
    runId,
    attemptId,
    attemptCount: 0,
    unmeasuredAttempts: 0,
    runnerMinutes: newAccumulator(),
    wallSeconds: newAccumulator(),
    tokensInput: newAccumulator(),
    tokensOutput: newAccumulator(),
    tokensReasoning: newAccumulator(),
    tokensCacheRead: newAccumulator(),
    tokensCacheWrite: newAccumulator(),
    meteredUsd: newAccumulator(),
    planEstimateUsd: newAccumulator(),
    unknownCount: 0,
  };
}

function finish(acc: SumAccumulator): number | null {
  return acc.seen ? acc.value : null;
}

/**
 * The map key for a lane. The prefix makes a `run:` lane and an `attempt:`
 * lane unable to collide, and because the key lives in a `Map` (not a plain
 * object) a hostile identifier can never touch `Object.prototype` or shadow a
 * lookup the way a `__proto__` or `constructor` key would.
 */
function laneKey(runId: string | null, attemptId: string): string {
  return runId === null ? `attempt:${attemptId}` : `run:${runId}`;
}

/**
 * Group `LaneUsageLogRow` values by `runId` (and by `attemptId` when
 * `runId === null`) into per-lane totals. Pure: no wall clock, no randomness,
 * no I/O, no `console.*`; the input array and its rows are neither mutated nor
 * retained.
 *
 * Cost bound: one `O(n)` pass over `rows` validates and accumulates (`n` is
 * bounded by `LANE_USAGE_LOG_MAX_ROWS = 20_000`, enforced in `O(1)` by
 * `readBoundedDenseArray` before any element is read), `O(lanes)` memory for
 * the lane groups, plus an `O(lanes log lanes)` sort of the finished lanes.
 * Every failure — including a sum whose midpoint overflows — returns a typed
 * result; the function never throws and never returns a partial sum.
 */
export function summariseLaneUsage(rows: readonly LaneUsageLogRow[]): LaneUsageSummaryResult {
  const dense = readBoundedDenseArray(rows, LANE_USAGE_LOG_MAX_ROWS);
  if (dense === null) {
    return { ok: false, reason: 'invalid-rows-array' };
  }
  const lanes = new Map<string, LaneGroup>();
  for (const item of dense.array) {
    const row = parseLaneUsageLogRow(item);
    if (row === null) {
      return { ok: false, reason: 'invalid-row' };
    }
    const key = laneKey(row.runId, row.attemptId);
    let group = lanes.get(key);
    if (group === undefined) {
      // A run's lane carries no attemptId: only a run-less lane is identified
      // by the attempt it groups.
      group = newLaneGroup(row.runId, row.runId === null ? row.attemptId : null);
      lanes.set(key, group);
    }
    group.attemptCount += 1;
    if (row.runnerMinutes === null || !isFiniteNonNegativeNumber(row.runnerMinutes)) {
      group.unmeasuredAttempts += 1;
    }
    if (!isFiniteNonNegativeNumber(row.runnerMinutes)) {
      accumulate(group.runnerMinutes, row.runnerMinutes);
    } else if (!Number.isSafeInteger(row.runnerMinutes)) {
      // Runner-minutes are whole minutes by contract (`runnerMinutesOf`);
      // a fractional value is refused rather than summed.
      group.runnerMinutes.overflow = true;
    } else {
      accumulate(group.runnerMinutes, row.runnerMinutes);
    }
    accumulate(group.wallSeconds, row.wallSeconds);
    accumulate(group.tokensInput, row.tokensInput);
    accumulate(group.tokensOutput, row.tokensOutput);
    accumulate(group.tokensReasoning, row.tokensReasoning);
    accumulate(group.tokensCacheRead, row.tokensCacheRead);
    accumulate(group.tokensCacheWrite, row.tokensCacheWrite);
    if (row.costBasis === 'metered') {
      accumulate(group.meteredUsd, row.costUsd);
    } else if (row.costBasis === 'plan-estimate') {
      accumulate(group.planEstimateUsd, row.costUsd);
    } else {
      group.unknownCount += 1;
    }
  }
  for (const group of lanes.values()) {
    if (
      group.runnerMinutes.overflow || group.wallSeconds.overflow ||
      group.tokensInput.overflow || group.tokensOutput.overflow ||
      group.tokensReasoning.overflow || group.tokensCacheRead.overflow ||
      group.tokensCacheWrite.overflow || group.meteredUsd.overflow ||
      group.planEstimateUsd.overflow
    ) {
      return { ok: false, reason: 'invalid-row' };
    }
  }
  const sorted = [...lanes.values()].sort((a, b) => {
    if (a.runId !== null && b.runId !== null) {
      return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
    }
    if (a.runId !== null) {
      return -1;
    }
    if (b.runId !== null) {
      return 1;
    }
    return a.attemptId !== null && b.attemptId !== null
      ? (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0)
      : 0;
  });
  return {
    ok: true,
    lanes: sorted.map((group) => ({
      runId: group.runId,
      attemptId: group.attemptId,
      attemptCount: group.attemptCount,
      runnerMinutes: finish(group.runnerMinutes),
      unmeasuredAttempts: group.unmeasuredAttempts,
      wallSeconds: finish(group.wallSeconds),
      tokens: {
        input: finish(group.tokensInput),
        output: finish(group.tokensOutput),
        reasoning: finish(group.tokensReasoning),
        cacheRead: finish(group.tokensCacheRead),
        cacheWrite: finish(group.tokensCacheWrite),
      },
      cost: {
        meteredUsd: finish(group.meteredUsd),
        planEstimateUsd: finish(group.planEstimateUsd),
        unknownCount: group.unknownCount,
      },
    })),
  };
}
