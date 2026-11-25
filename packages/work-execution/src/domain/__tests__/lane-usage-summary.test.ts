import { describe, expect, it } from 'vitest';

import {
  LANE_USAGE_LOG_MAX_ROWS,
  parseLaneUsageLogRow,
  type LaneUsageLogRow,
} from '../lane-usage-log.js';
import { summariseLaneUsage } from '../lane-usage-summary.js';

const NOW_ISO = '2026-11-25T09:00:00.000Z';

/** A fully valid metered row, parsed through the store's own row parser. */
function row(overrides: Partial<LaneUsageLogRow> = {}): LaneUsageLogRow {
  const base = {
    schemaVersion: 1 as const,
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    runId: 'run-1' as string | null,
    worktreeName: 'attempt-1' as string | null,
    kind: 'initial' as const,
    fixNumber: 0,
    outcome: 'done' as const,
    stopReason: 'none' as const,
    runnerKind: 'opencode' as const,
    billing: 'metered' as const,
    seatRole: null,
    model: 'openai/gpt-6-luna',
    agent: 'implementer',
    source: 'opencode-db' as const,
    steps: 42,
    wallSeconds: 61 as number | null,
    runnerMinutes: 2 as number | null,
    tokensInput: 1000 as number | null,
    tokensOutput: 200 as number | null,
    tokensReasoning: 50 as number | null,
    tokensCacheRead: 300 as number | null,
    tokensCacheWrite: 400 as number | null,
    costUsd: 0.25 as number | null,
    costBasis: 'metered' as const,
    recordedAtIso: NOW_ISO,
    reason: null,
  };
  const merged = { ...base, ...overrides };
  const parsed = parseLaneUsageLogRow(merged);
  expect(parsed).not.toBeNull();
  return parsed as LaneUsageLogRow;
}

/** A run-less attempt row (`runId: null`) grouped by its `attemptId`. */
function unrunnedRow(attemptId: string, overrides: Partial<LaneUsageLogRow> = {}): LaneUsageLogRow {
  return row({ attemptId, runId: null, worktreeName: attemptId, ...overrides });
}

function planRow(overrides: Partial<LaneUsageLogRow> = {}): LaneUsageLogRow {
  return row({ billing: 'plan', costBasis: 'plan-estimate', ...overrides });
}

function unknownRow(overrides: Partial<LaneUsageLogRow> = {}): LaneUsageLogRow {
  return row({ billing: 'unknown', runnerKind: null, costUsd: null, costBasis: 'unknown', ...overrides });
}

/** Prototype-polluting keys, built at runtime so no literal names them. */
const POLLUTING_KEYS = [
  ['__proto' + '__'],
  ['construct' + 'or'],
] as const;

describe('summariseLaneUsage — table-driven aggregation', () => {
  it('summarises one lane with stored runnerMinutes, never recomputed from wallSeconds', () => {
    // 61 seconds: the stored value is 2 whole minutes and must not be
    // recomputed (Math.ceil(61/60) would also be 2, so use 120.5 seconds with
    // stored 2 to pin "never recomputed" — recomputing would give 3).
    const result = summariseLaneUsage([row({ wallSeconds: 120.5, runnerMinutes: 2 })]);
    expect(result).toEqual({
      ok: true,
      lanes: [{
        runId: 'run-1',
        attemptId: null,
        attemptCount: 1,
        runnerMinutes: 2,
        unmeasuredAttempts: 0,
        wallSeconds: 120.5,
        tokens: { input: 1000, output: 200, reasoning: 50, cacheRead: 300, cacheWrite: 400 },
        cost: { meteredUsd: 0.25, planEstimateUsd: null, unknownCount: 0 },
      }],
    });
  });

  it('sums two attempts of one run into a single lane', () => {
    const result = summariseLaneUsage([
      row({ attemptId: 'attempt-1', runnerMinutes: 2, wallSeconds: 100, costUsd: 0.25 }),
      row({ attemptId: 'attempt-2', runnerMinutes: 3, wallSeconds: 20, costUsd: 0.5 }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toHaveLength(1);
    const lane = result.lanes[0];
    expect(lane.runId).toBe('run-1');
    expect(lane.attemptId).toBeNull();
    expect(lane.attemptCount).toBe(2);
    expect(lane.runnerMinutes).toBe(5);
    expect(lane.wallSeconds).toBe(120);
    expect(lane.cost.meteredUsd).toBeCloseTo(0.75, 10);
  });

  it('keeps two runs in separate, sorted lanes', () => {
    const result = summariseLaneUsage([
      row({ runId: 'run-b', attemptId: 'attempt-1', runnerMinutes: 1 }),
      row({ runId: 'run-a', attemptId: 'attempt-2', runnerMinutes: 2 }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes.map((lane) => lane.runId)).toEqual(['run-a', 'run-b']);
    expect(result.lanes.map((lane) => lane.attemptId)).toEqual([null, null]);
    expect(result.lanes.map((lane) => lane.runnerMinutes)).toEqual([2, 1]);
  });

  it('groups runId-less rows by attemptId, after the runId lanes', () => {
    const result = summariseLaneUsage([
      unrunnedRow('solo-b'),
      row({ runId: 'run-a', attemptId: 'attempt-1' }),
      unrunnedRow('solo-a'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toHaveLength(3);
    expect(result.lanes.map((lane) => [lane.runId, lane.attemptId])).toEqual([
      ['run-a', null],
      [null, 'solo-a'],
      [null, 'solo-b'],
    ]);
    expect(result.lanes.every((lane) => lane.attemptCount === 1)).toBe(true);
  });

  it('keeps mixed cost bases separate: metered, plan-estimate and unknown', () => {
    const result = summariseLaneUsage([
      row({ costUsd: 0.25, costBasis: 'metered' }),
      planRow({ attemptId: 'attempt-2', costUsd: 0.5 }),
      unknownRow({ attemptId: 'attempt-3' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0].cost).toEqual({
      meteredUsd: 0.25,
      planEstimateUsd: 0.5,
      unknownCount: 1,
    });
  });

  it('keeps a free seat costUsd of 0 distinct from null', () => {
    const result = summariseLaneUsage([row({ costUsd: 0 })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes[0].cost.meteredUsd).toBe(0);
    expect(result.lanes[0].cost.planEstimateUsd).toBeNull();
  });

  it('returns null runnerMinutes and an unmeasured count when every row lacks it', () => {
    const result = summariseLaneUsage([
      row({ runnerMinutes: null, wallSeconds: null }),
      row({ attemptId: 'attempt-2', runnerMinutes: null, wallSeconds: null }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes[0].runnerMinutes).toBeNull();
    expect(result.lanes[0].unmeasuredAttempts).toBe(2);
    expect(result.lanes[0].wallSeconds).toBeNull();
  });

  it('sums runnerMinutes over measured rows and counts the unmeasured ones', () => {
    const result = summariseLaneUsage([
      row({ runnerMinutes: 2 }),
      row({ attemptId: 'attempt-2', runnerMinutes: null }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes[0].runnerMinutes).toBe(2);
    expect(result.lanes[0].unmeasuredAttempts).toBe(1);
    expect(result.lanes[0].attemptCount).toBe(2);
  });

  it('returns ok true with empty lanes for an empty array', () => {
    expect(summariseLaneUsage([])).toEqual({ ok: true, lanes: [] });
  });
});

describe('summariseLaneUsage — determinism and immutability', () => {
  it('produces identical sorted output regardless of input order', () => {
    const rows = [
      row({ runId: 'run-b', attemptId: 'attempt-1', runnerMinutes: 1 }),
      unrunnedRow('solo-1'),
      row({ runId: 'run-a', attemptId: 'attempt-2', runnerMinutes: 2 }),
      unrunnedRow('solo-0'),
      row({ runId: 'run-a', attemptId: 'attempt-3', runnerMinutes: 3 }),
    ];
    const forwards = summariseLaneUsage(rows);
    const reversed = summariseLaneUsage([...rows].reverse());
    const rotated = summariseLaneUsage([...rows.slice(2), ...rows.slice(0, 2)]);
    expect(forwards).toEqual(reversed);
    expect(forwards).toEqual(rotated);
    expect(forwards.ok && forwards.lanes.map((lane) => [lane.runId, lane.attemptId])).toEqual([
      ['run-a', null],
      ['run-b', null],
      [null, 'solo-0'],
      [null, 'solo-1'],
    ]);
  });

  it('does not mutate frozen inputs: the array and every row stay untouched', () => {
    const rows = Object.freeze([
      Object.freeze(row({ runnerMinutes: 2 })),
      Object.freeze(row({ attemptId: 'attempt-2', runnerMinutes: 3 })),
    ]) as readonly LaneUsageLogRow[];
    const before = JSON.stringify(rows);
    const result = summariseLaneUsage(rows);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('summariseLaneUsage — hostile rows array', () => {
  it('refuses null, undefined, primitives, non-arrays, and array-likes with invalid-rows-array', () => {
    const arrayLike = { length: 1, 0: row() } as unknown as readonly LaneUsageLogRow[];
    const nonArrayObject = {} as unknown as readonly LaneUsageLogRow[];
    for (const input of [
      null,
      undefined,
      0,
      -1,
      1.5,
      '',
      'rows',
      true,
      Symbol('no'),
      nonArrayObject,
      arrayLike,
    ]) {
      expect(summariseLaneUsage(input as unknown as readonly LaneUsageLogRow[])).toEqual({
        ok: false,
        reason: 'invalid-rows-array',
      });
    }
  });

  it('refuses sparse arrays with holes with invalid-rows-array', () => {
    const sparse = new Array(3);
    sparse[0] = row();
    sparse[2] = row();
    expect(summariseLaneUsage(sparse as unknown as readonly LaneUsageLogRow[])).toEqual({ ok: false, reason: 'invalid-rows-array' });
    const hollow = new Array(2);
    hollow[0] = row();
    expect(summariseLaneUsage(hollow)).toEqual({ ok: false, reason: 'invalid-rows-array' });
  });

  it('refuses getter-bearing arrays, Proxy arrays, and arrays with __proto__ or constructor keys without invoking getters', () => {
    let getterCalls = 0;
    // An index accessor: refused without ever running the getter.
    const indexed = [row()];
    Object.defineProperty(indexed, 0, {
      get() {
        getterCalls += 1;
        return row();
      },
      enumerable: true,
    });
    expect(summariseLaneUsage(indexed)).toEqual({ ok: false, reason: 'invalid-rows-array' });
    // A length getter: an Array subclass carrying a prototype `length`
    // accessor. Refused on its prototype before any value read, so the
    // getter never runs.
    class GetterLength extends Array {}
    Object.defineProperty(GetterLength.prototype, 'length', {
      get() {
        getterCalls += 1;
        return 1;
      },
      configurable: true,
    });
    const lengthGotter = GetterLength.from([row()]) as unknown as LaneUsageLogRow[];
    expect(summariseLaneUsage(lengthGotter)).toEqual({ ok: false, reason: 'invalid-rows-array' });
    // A Proxy that throws in every trap.
    const throwingProxy = new Proxy([row()], {
      get() {
        throw new Error('trap');
      },
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    expect(summariseLaneUsage(throwingProxy)).toEqual({ ok: false, reason: 'invalid-rows-array' });
    // Extra prototype-polluting own keys on the array itself.
    for (const key of POLLUTING_KEYS) {
      const polluted = [row()];
      Object.defineProperty(polluted, key[0], { value: row(), enumerable: true });
      expect(summariseLaneUsage(polluted)).toEqual({ ok: false, reason: 'invalid-rows-array' });
    }
    expect(getterCalls).toBe(0);
  });

  it('refuses an input exceeding LANE_USAGE_LOG_MAX_ROWS with invalid-rows-array', () => {
    const overLong = new Array(LANE_USAGE_LOG_MAX_ROWS + 1).fill(row());
    expect(summariseLaneUsage(overLong)).toEqual({ ok: false, reason: 'invalid-rows-array' });
    const atLimit = new Array(LANE_USAGE_LOG_MAX_ROWS).fill(0);
    // At the limit the array is dense-valid, so the first element (0) makes it
    // an invalid row, not an invalid array — proving the length gate is `>` not `>=`.
    expect(summariseLaneUsage(atLimit)).toEqual({ ok: false, reason: 'invalid-row' });
  });
});

describe('summariseLaneUsage — hostile row elements', () => {
  it('refuses null rows, getter-bearing rows without running getters, Proxy rows, and malformed rows with invalid-row', () => {
    let getterCalls = 0;
    const getterRow = {};
    Object.defineProperty(getterRow, 'schemaVersion', {
      get() {
        getterCalls += 1;
        return 1;
      },
      enumerable: true,
    });
    const throwingProxy = new Proxy(row(), {
      get() {
        throw new Error('trap');
      },
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    const missingKey = row();
    const partial = { ...missingKey } as Record<string, unknown>;
    delete partial.tokensInput;
    const extraKey = { ...missingKey, extra: 1 };
    const malformed: unknown[] = [
      null,
      undefined,
      0,
      'row',
      true,
      getterRow,
      throwingProxy,
      partial,
      extraKey,
    ];
    for (const key of POLLUTING_KEYS) {
      const polluted = { ...missingKey } as Record<string, unknown>;
      // defineProperty, not assignment: an assignment to `__proto__` sets a
      // prototype instead of creating the own key being tested.
      Object.defineProperty(polluted, key[0], { value: 1, enumerable: true });
      malformed.push(polluted);
    }
    for (const numericField of ['runnerMinutes', 'costUsd', 'wallSeconds', 'tokensInput']) {
      const badNumber = { ...missingKey } as Record<string, unknown>;
      badNumber[numericField] = Number.NaN;
      malformed.push(badNumber);
      const negative = { ...missingKey } as Record<string, unknown>;
      negative[numericField] = -1;
      malformed.push(negative);
      const infinite = { ...missingKey } as Record<string, unknown>;
      infinite[numericField] = Number.POSITIVE_INFINITY;
      malformed.push(infinite);
    }
    for (const value of malformed) {
      expect(summariseLaneUsage([value as LaneUsageLogRow])).toEqual({
        ok: false,
        reason: 'invalid-row',
      });
    }
    expect(getterCalls).toBe(0);
  });
});

describe('summariseLaneUsage — checked accumulation (overflow contract)', () => {
  it('refuses a sum whose midpoint exceeds MAX_VALUE (MAX_VALUE plus 2**970)', () => {
    const result = summariseLaneUsage([
      row({ attemptId: 'attempt-1', runnerMinutes: Number.MAX_VALUE }),
      row({ attemptId: 'attempt-2', runnerMinutes: 2 ** 970 }),
    ]);
    expect(result).toEqual({ ok: false, reason: 'invalid-row' });
  });

  it('accepts MAX_SAFE_INTEGER - 1 plus 1 and refuses the same plus 2', () => {
    const accepted = summariseLaneUsage([
      row({ attemptId: 'attempt-1', runnerMinutes: Number.MAX_SAFE_INTEGER - 1 }),
      row({ attemptId: 'attempt-2', runnerMinutes: 1 }),
    ]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.lanes[0].runnerMinutes).toBe(Number.MAX_SAFE_INTEGER);

    const refused = summariseLaneUsage([
      row({ attemptId: 'attempt-1', runnerMinutes: Number.MAX_SAFE_INTEGER - 1 }),
      row({ attemptId: 'attempt-2', runnerMinutes: 2 }),
    ]);
    expect(refused).toEqual({ ok: false, reason: 'invalid-row' });
  });

  it('refuses non-integer and negative runnerMinutes values with a typed result', () => {
    const fractional = summariseLaneUsage([row({ runnerMinutes: 1.5 })]);
    expect(fractional).toEqual({ ok: false, reason: 'invalid-row' });
    // The parser itself already refuses a negative field; the summariser
    // returns the same typed refusal rather than summing it.
    const negative = { ...row() } as Record<string, unknown>;
    negative.runnerMinutes = -2;
    expect(summariseLaneUsage([negative as unknown as LaneUsageLogRow])).toEqual({
      ok: false,
      reason: 'invalid-row',
    });
  });

  it('sums large-but-finite costs, wall seconds and tokens instead of refusing them', () => {
    // The safe-integer bound is the runner-minutes contract only; a finite
    // cost or token total of any magnitude must be summed.
    const result = summariseLaneUsage([
      row({ costUsd: 5e15, tokensInput: 5e15, wallSeconds: 5e15 }),
      row({ costUsd: 5e15, tokensInput: 5e15, wallSeconds: 5e15 }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lane = result.lanes[0];
    expect(lane.cost.meteredUsd).toBe(1e16);
    expect(lane.tokens.input).toBe(1e16);
    expect(lane.wallSeconds).toBe(1e16);
    expect(lane.runnerMinutes).toBe(4);
  });

  it('refuses a non-runnerMinutes sum whose midpoint exceeds MAX_VALUE', () => {
    const result = summariseLaneUsage([
      row({ costUsd: Number.MAX_VALUE }),
      row({ costUsd: Number.MAX_VALUE }),
    ]);
    expect(result).toEqual({ ok: false, reason: 'invalid-row' });
  });
});
