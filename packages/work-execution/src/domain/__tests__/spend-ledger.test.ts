import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../execution-records.js';
import {
  buildSpendLedgerRow,
  decideProviderBudget,
  monthKeyOf,
  providerOfModel,
  readProviderBudget,
  readSpendLedgerRow,
  SPEND_LEDGER_ROW_KEYS,
  summariseSpendMonth,
  type SpendLedgerRow,
} from '../spend-ledger.js';

const NOW_ISO = '2026-11-25T09:00:00.000Z';
const MODEL = 'openrouter/z-ai/glm-5.3-flash';

/** A minimal valid attempt record with the fields the builder reads. */
function attempt(overrides: Record<string, unknown> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'seat-1',
      model: MODEL,
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    usage: {
      source: 'opencode-db',
      readAtIso: NOW_ISO,
      sessionId: null,
      steps: 3,
      wallSeconds: 61,
      tokensInput: 1000,
      tokensOutput: 200,
      tokensReasoning: 50,
      tokensCacheRead: 300,
      tokensCacheWrite: 400,
      costUsd: 0.25,
      model: MODEL,
      agent: 'implementer',
      reason: null,
    },
    ...overrides,
  } as unknown as AttemptRecord;
}

/** A fully valid row built through the domain builder itself. */
function row(overrides: Record<string, unknown> = {}): SpendLedgerRow {
  const { attempt: attemptOverrides, nowIso, ...fieldOverrides } = overrides;
  const built = buildSpendLedgerRow({
    attempt: attempt(attemptOverrides as Record<string, unknown> | undefined),
    runId: 'run-1',
    nowIso: (nowIso as string | undefined) ?? NOW_ISO,
  });
  expect(built).not.toBeNull();
  const read = readSpendLedgerRow({ ...(built as SpendLedgerRow), ...fieldOverrides });
  expect(read.ok).toBe(true);
  return (read as { ok: true; row: SpendLedgerRow }).row;
}

/** A plain object with exactly the row keys, every value behind a getter. */
function getterRow(): Record<string, unknown> {
  let runs = 0;
  const hostile: Record<string, unknown> = {};
  for (const key of SPEND_LEDGER_ROW_KEYS) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() {
        runs += 1;
        return key === 'attemptId' ? 'attempt-1' : undefined;
      },
    });
  }
  return Object.defineProperty(hostile, 'getterRuns', { enumerable: false, value: runs }) as Record<string, unknown>;
}

describe('providerOfModel', () => {
  it('providerOfModel returns the segment before the first slash', () => {
    expect(providerOfModel('openrouter/z-ai/glm-5.3-flash')).toBe('openrouter');
    expect(providerOfModel('openai/gpt-6-luna')).toBe('openai');
    expect(providerOfModel('a/b/c/d')).toBe('a');
  });

  it('providerOfModel returns unknown for a model with no slash', () => {
    expect(providerOfModel('gpt-6-luna')).toBe('unknown');
    expect(providerOfModel('openrouter/')).toBe('unknown');
    expect(providerOfModel('/glm')).toBe('unknown');
    expect(providerOfModel(42)).toBe('unknown');
    expect(providerOfModel(null)).toBe('unknown');
    expect(providerOfModel(`${'x'.repeat(129)}/m`)).toBe('unknown');
    expect(providerOfModel('attempt\u0000x/m')).toBe('unknown');
  });
});

describe('monthKeyOf', () => {
  it('monthKeyOf splits the month at the UTC boundary', () => {
    expect(monthKeyOf('2026-11-30T23:59:59.999Z')).toBe('2026-11');
    expect(monthKeyOf('2026-12-01T00:00:00.000Z')).toBe('2026-12');
    expect(monthKeyOf('2026-01-01T00:00:00.000Z')).toBe('2026-01');
  });

  it('monthKeyOf returns null for invalid months 00 and 13 or non-canonical instants', () => {
    expect(monthKeyOf('2026-13-01T00:00:00.000Z')).toBeNull();
    expect(monthKeyOf('2026-00-10T00:00:00.000Z')).toBeNull();
    expect(monthKeyOf('2026-02-30T00:00:00.000Z')).toBeNull();
    expect(monthKeyOf('2026-11-30T23:59:59Z')).toBeNull();
    expect(monthKeyOf('2026-11-30')).toBeNull();
    expect(monthKeyOf(1764508800000)).toBeNull();
    expect(monthKeyOf(null)).toBeNull();
  });
});

describe('buildSpendLedgerRow', () => {
  it('buildSpendLedgerRow carries the attempt usage and the month of recordedAtIso', () => {
    const built = buildSpendLedgerRow({ attempt: attempt(), runId: 'run-1', nowIso: NOW_ISO });
    expect(built).not.toBeNull();
    expect(built).toEqual({
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      runId: 'run-1',
      seatId: 'seat-1',
      seatRole: 'first-pass',
      provider: 'openrouter',
      model: MODEL,
      month: '2026-11',
      tokensInput: 1000,
      tokensOutput: 200,
      tokensReasoning: 50,
      tokensCacheRead: 300,
      tokensCacheWrite: 400,
      costUsd: 0.25,
      costBasis: 'metered',
      recordedAtIso: NOW_ISO,
    });
  });

  it('buildSpendLedgerRow returns null when the attempt has no usage record', () => {
    expect(buildSpendLedgerRow({ attempt: attempt({ usage: null }), nowIso: NOW_ISO })).toBeNull();
    expect(buildSpendLedgerRow({ attempt: attempt({ usage: undefined }), nowIso: NOW_ISO })).toBeNull();
  });

  it('buildSpendLedgerRow returns null when the attempt usage has no model', () => {
    expect(
      buildSpendLedgerRow({ attempt: attempt({ usage: { model: null } }), nowIso: NOW_ISO }),
    ).toBeNull();
    expect(
      buildSpendLedgerRow({ attempt: attempt({ usage: { model: 'no-slash-model' } }), nowIso: NOW_ISO }),
    ).not.toBeNull();
    expect(
      buildSpendLedgerRow({ attempt: attempt({ usage: { model: 42 } }), nowIso: NOW_ISO }),
    ).toBeNull();
  });

  it('buildSpendLedgerRow returns null on an invalid attempt or a non-canonical nowIso', () => {
    expect(buildSpendLedgerRow({ attempt: attempt({ id: 'bad id' }), nowIso: NOW_ISO })).toBeNull();
    expect(buildSpendLedgerRow({ attempt: attempt(), nowIso: '2026-11-25T09:00:00Z' })).toBeNull();
    expect(
      buildSpendLedgerRow({ attempt: null as unknown as AttemptRecord, nowIso: NOW_ISO }),
    ).toBeNull();
    expect(
      buildSpendLedgerRow({ attempt: attempt(), nowIso: 42 as unknown as string }),
    ).toBeNull();
  });
});

describe('readSpendLedgerRow', () => {
  it('readSpendLedgerRow refuses null, primitives, arrays, Proxies, extra keys, and prototype-polluting keys', () => {
    expect(readSpendLedgerRow(null).ok).toBe(false);
    expect(readSpendLedgerRow(undefined).ok).toBe(false);
    expect(readSpendLedgerRow(42).ok).toBe(false);
    expect(readSpendLedgerRow('row').ok).toBe(false);
    expect(readSpendLedgerRow([]).ok).toBe(false);
    expect(readSpendLedgerRow(new Proxy({}, {})).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), extra: 1 }).ok).toBe(false);
    const polluted: Record<string, unknown> = { ...row() };
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: {} });
    expect(readSpendLedgerRow(polluted).ok).toBe(false);
    const missing: Record<string, unknown> = { ...row() } as Record<string, unknown>;
    delete missing.runId;
    expect(readSpendLedgerRow(missing).ok).toBe(false);
  });

  it('readSpendLedgerRow refuses a getter-backed row without running the getter', () => {
    const hostile = getterRow();
    const result = readSpendLedgerRow(hostile);
    expect(result.ok).toBe(false);
    expect((hostile.getterRuns as number) ?? 0).toBe(0);
    // The instrumented getter itself never ran.
    let instrumented = 0;
    const getterOnly: Record<string, unknown> = {};
    for (const key of SPEND_LEDGER_ROW_KEYS) {
      Object.defineProperty(getterOnly, key, {
        enumerable: true,
        get() {
          instrumented += 1;
          return undefined;
        },
      });
    }
    expect(readSpendLedgerRow(getterOnly).ok).toBe(false);
    expect(instrumented).toBe(0);
  });

  it('readSpendLedgerRow refuses a negative cost', () => {
    expect(readSpendLedgerRow({ ...row(), costUsd: -0.25 }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), tokensInput: -1 }).ok).toBe(false);
  });

  it('readSpendLedgerRow refuses NaN and Infinity token or cost values', () => {
    expect(readSpendLedgerRow({ ...row(), tokensInput: Number.NaN }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), tokensOutput: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), costUsd: Number.NEGATIVE_INFINITY }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), costUsd: Number.NaN }).ok).toBe(false);
  });

  it('readSpendLedgerRow refuses a month of 00 or 13 or a non-YYYY-MM string', () => {
    expect(readSpendLedgerRow({ ...row(), month: '2026-00' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), month: '2026-13' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), month: '2026-1' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), month: 'november' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), month: '2026-12' }).ok).toBe(false);
  });

  it('readSpendLedgerRow refuses a model or identifier with a secret shape or control characters', () => {
    expect(readSpendLedgerRow({ ...row(), model: 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAA/m1' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), attemptId: 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAA' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), attemptId: 'attempt\u00001' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), workOrderId: 'wo\n-1' }).ok).toBe(false);
    expect(readSpendLedgerRow({ ...row(), provider: `${'x'.repeat(129)}` }).ok).toBe(false);
  });
});

describe('summariseSpendMonth', () => {
  it('summariseSpendMonth counts only metered rows toward spentUsd', () => {
    const summary = summariseSpendMonth(
      [
        row({ attempt: { id: 'a1' }, costUsd: 0.25 }),
        row({ attempt: { id: 'a2' }, costUsd: 0.5 }),
      ],
      '2026-11',
    );
    if (!summary.ok) {
      throw new Error('expected a readable summary');
    }
    const entry = summary.summary.providers.find((candidate) => candidate.provider === 'openrouter');
    expect(entry?.spentUsd).toBe(0.75);
  });

  it('summariseSpendMonth reports plan-estimate cost separately and never as spend', () => {
    const summary = summariseSpendMonth(
      [
        row({ attempt: { id: 'a1' }, costUsd: 0.25 }),
        row({ attempt: { id: 'a2', runner: { kind: 'agy' } }, costUsd: 9 }),
      ],
      '2026-11',
    );
    if (!summary.ok) {
      throw new Error('expected a readable summary');
    }
    const entry = summary.summary.providers.find((candidate) => candidate.provider === 'openrouter');
    expect(entry?.planEstimateUsd).toBe(9);
    expect(entry?.spentUsd).toBe(0.25);
  });

  it('summariseSpendMonth ignores rows of another month', () => {
    const other = buildSpendLedgerRow({ attempt: attempt({ id: 'a3' }), runId: null, nowIso: '2026-12-01T00:00:00.000Z' });
    expect(other).not.toBeNull();
    const summary = summariseSpendMonth([row(), other as SpendLedgerRow], '2026-11');
    if (!summary.ok) {
      throw new Error('expected a readable summary');
    }
    expect(summary.summary.rowCount).toBe(1);
    expect(summary.summary.providers[0]?.rowCount).toBe(1);
  });

  it('summariseSpendMonth counts unknown-cost rows without adding to spentUsd', () => {
    const unknownCost = buildSpendLedgerRow({
      attempt: attempt({ id: 'a4', seatSelection: { tool: 'mystery' }, usage: { model: MODEL, costUsd: null } }),
      nowIso: NOW_ISO,
    });
    expect(unknownCost).not.toBeNull();
    const summary = summariseSpendMonth([unknownCost as SpendLedgerRow], '2026-11');
    if (!summary.ok) {
      throw new Error('expected a readable summary');
    }
    expect(summary.summary.unknownCostRows).toBe(1);
    expect(summary.summary.providers[0]?.spentUsd).toBeNull();
  });

  it('summariseSpendMonth refuses non-arrays, sparse arrays, Proxies, and invalid rows', () => {
    expect(summariseSpendMonth(null as unknown as unknown[], '2026-11').ok).toBe(false);
    expect(summariseSpendMonth(undefined as unknown as unknown[], '2026-11').ok).toBe(false);
    expect(summariseSpendMonth({ length: 1 } as unknown as unknown[], '2026-11').ok).toBe(false);
    expect(summariseSpendMonth(new Proxy([], {}) as unknown as unknown[], '2026-11').ok).toBe(true);
    const trapped = new Proxy([row()], {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    expect(summariseSpendMonth(trapped as unknown as unknown[], '2026-11')).toEqual({ ok: false, reason: 'invalid-rows-array' });
    const sparse: unknown[] = new Array(2);
    sparse[0] = row();
    expect(summariseSpendMonth(sparse, '2026-11')).toEqual({ ok: false, reason: 'invalid-rows-array' });
    expect(summariseSpendMonth([42], '2026-11')).toEqual({ ok: false, reason: 'invalid-row' });
    expect(summariseSpendMonth([{ ...row(), extra: 1 }], '2026-11')).toEqual({ ok: false, reason: 'invalid-row' });
  });

  it('summariseSpendMonth refuses an invalid month', () => {
    expect(summariseSpendMonth([row()], '2026-13')).toEqual({ ok: false, reason: 'invalid-month' });
    expect(summariseSpendMonth([row()], '2026-00')).toEqual({ ok: false, reason: 'invalid-month' });
    expect(summariseSpendMonth([row()], 'november')).toEqual({ ok: false, reason: 'invalid-month' });
  });
});

describe('readProviderBudget', () => {
  it('readProviderBudget refuses a getter-backed or extra-key budget', () => {
    let runs = 0;
    const getterBudget: Record<string, unknown> = {};
    for (const key of ['provider', 'monthlyUsd']) {
      Object.defineProperty(getterBudget, key, {
        enumerable: true,
        get() {
          runs += 1;
          return key === 'provider' ? 'openrouter' : 10;
        },
      });
    }
    expect(readProviderBudget(getterBudget).ok).toBe(false);
    expect(runs).toBe(0);
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: 10, extra: 1 }).ok).toBe(false);
    expect(readProviderBudget(null).ok).toBe(false);
    expect(readProviderBudget([]).ok).toBe(false);
  });

  it('readProviderBudget refuses zero, negative, NaN, or Infinity monthlyUsd', () => {
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: 0 }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: -5 }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: Number.NaN }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: '10' }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'openrouter', monthlyUsd: 10 }).ok).toBe(true);
  });

  it('readProviderBudget refuses a provider that is empty, over 128 characters or secret-shaped', () => {
    expect(readProviderBudget({ provider: '', monthlyUsd: 10 }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'x'.repeat(129), monthlyUsd: 10 }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAA', monthlyUsd: 10 }).ok).toBe(false);
    expect(readProviderBudget({ provider: 'pro\u0000vider', monthlyUsd: 10 }).ok).toBe(false);
    expect(readProviderBudget({ provider: 42, monthlyUsd: 10 }).ok).toBe(false);
  });
});

describe('decideProviderBudget', () => {
  it('decideProviderBudget refuses when spent equals the monthly cap', () => {
    const summary = summariseSpendMonth(
      [
        row({ attempt: { id: 'a1' }, costUsd: 0.5 }),
        row({ attempt: { id: 'a2' }, costUsd: 0.5 }),
      ],
      '2026-11',
    );
    const decision = decideProviderBudget({ budget: { provider: 'openrouter', monthlyUsd: 1 }, summary });
    expect(decision).toEqual({ allowed: false, reason: 'budget-exhausted' });
  });

  it('decideProviderBudget allows when spent is one cent below the cap', () => {
    const summary = summariseSpendMonth(
      [
        row({ attempt: { id: 'a1' }, costUsd: 0.5 }),
        row({ attempt: { id: 'a2' }, costUsd: 0.49 }),
      ],
      '2026-11',
    );
    const decision = decideProviderBudget({ budget: { provider: 'openrouter', monthlyUsd: 1 }, summary });
    expect(decision).toEqual({ allowed: true });
  });

  it('decideProviderBudget returns budget-unknown for an unreadable summary', () => {
    const bad = summariseSpendMonth([42], '2026-11');
    expect(
      decideProviderBudget({ budget: { provider: 'openrouter', monthlyUsd: 1 }, summary: bad }),
    ).toEqual({ allowed: false, reason: 'budget-unknown' });
    expect(
      decideProviderBudget({ budget: { provider: 'openrouter', monthlyUsd: 0 }, summary: summariseSpendMonth([], '2026-11') }),
    ).toEqual({ allowed: false, reason: 'budget-unknown' });
    expect(
      decideProviderBudget({ budget: 42, summary: summariseSpendMonth([], '2026-11') }),
    ).toEqual({ allowed: false, reason: 'budget-unknown' });
  });

  it('decideProviderBudget allows a provider with no rows in the month', () => {
    const summary = summariseSpendMonth([row({ attempt: { id: 'a1' }, costUsd: 0.25 })], '2026-11');
    expect(
      decideProviderBudget({ budget: { provider: 'other-provider', monthlyUsd: 0.01 }, summary }),
    ).toEqual({ allowed: true });
  });
});
