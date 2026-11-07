import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { LANE_RUN_ID_PATTERN, type LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { ReadReceiptsForHeadResult } from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type {
  LaneScorecardAppendResult,
  LaneScorecardReadResult,
  LaneScorecardRow,
} from '../../ports/out/LaneScorecardPort.out-port.js';
import {
  AppendScorecardUseCase,
  deriveDurationMs,
  deriveVerificationResult,
  keepRunAttempts,
  type AppendScorecardDependencies,
} from '../AppendScorecardUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-11-06T10:00:00.000Z';
const STORE_MESSAGE = 'ENOENT: /secret/state/dir/lane-runs.json';

function run(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 1,
    attemptIds: ['attempt-1', 'attempt-2'],
    prNumber: 42,
    parked: null,
    parkCount: 1,
    lease: null,
    revision: 3,
    runPolicyRevision: 'policy-example-1',
    branchName: 'fleet/run-secret-branch',
    ...overrides,
  };
}

function attempt(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-example-1',
    kind: 'dispatch',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/secret/worktree/path',
    baseCommit: 'b'.repeat(40),
    state: 'ended',
    outcome: 'done',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: 'ses_secret',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-11-06T08:00:00.000Z',
    updatedAtIso: '2026-11-06T08:30:00.000Z',
    ...overrides,
  } as unknown as AttemptRecord;
}

function conduct(state: LaneRunStateValue, index: number): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId: `entry-${index}`,
    kind: 'conduct',
    key: null,
    runId: RUN_ID,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state,
  };
}

function intent(index: number): LaneRunJournalEntryRecord {
  return { ...conduct('running', index), kind: 'intent', state: null };
}

const FOUND: ReadReceiptsForHeadResult = {
  outcome: 'found',
  verification: [{ receiptId: 'x' as never, result: 'pass', exitCode: 0, completedAtIso: NOW }],
  review: [
    {
      receiptId: 'y' as never,
      kind: 'code-review',
      result: 'pass',
      findings: { blocker: 0, major: 1, minor: 2, nit: 3 },
      completedAtIso: NOW,
    },
    {
      receiptId: 'z' as never,
      kind: 'pre-merge',
      result: 'pass',
      findings: { blocker: 1, major: 0, minor: 0, nit: 1 },
      completedAtIso: NOW,
    },
  ],
};

interface Harness {
  deps: AppendScorecardDependencies;
  readonly calls: string[];
  readonly appended: LaneScorecardRow[];
  stored: LaneScorecardReadResult;
}

interface HarnessOptions {
  readonly run?: LaneRunRecord | null | Error;
  readonly journal?: readonly LaneRunJournalEntryRecord[] | Error;
  readonly attempts?: readonly AttemptRecord[] | Error;
  readonly receipt?: (attemptId: string, head: string) => ReadReceiptsForHeadResult | Error;
  readonly stored?: LaneScorecardReadResult;
  readonly appendResult?: LaneScorecardAppendResult | Error;
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const appended: LaneScorecardRow[] = [];
  const state: Harness = {
    calls,
    appended,
    stored: options.stored ?? { outcome: 'absent' },
    deps: undefined as unknown as AppendScorecardDependencies,
  };
  const settle = <T>(value: T | Error): T => {
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  const deps: AppendScorecardDependencies = {
    runRepo: {
      get: async () => {
        calls.push('get');
        return settle(options.run === undefined ? run() : options.run);
      },
    },
    attemptRepo: {
      listAttemptsByWorkOrder: async () => {
        calls.push('listAttemptsByWorkOrder');
        return settle(
          options.attempts ??
            ([
              attempt('attempt-1', {
                outcome: 'partial',
                artifacts: { headCommit: 'c'.repeat(40) } as never,
                completionReceipt: { endedAtIso: '2026-11-06T08:20:00.000Z' } as never,
              }),
              attempt('attempt-2', {
                fixNumber: 1,
                artifacts: { headCommit: 'd'.repeat(40) } as never,
                completionReceipt: { endedAtIso: '2026-11-06T09:00:00.000Z' } as never,
                createdAtIso: '2026-11-06T08:40:00.000Z',
              }),
              attempt('attempt-other'),
            ] as const),
        );
      },
    },
    runJournal: {
      listForRun: async () => {
        calls.push('listForRun');
        return settle(options.journal ?? [conduct('running', 1), intent(2), conduct('merged', 3)]);
      },
    },
    receipts: {
      readReceiptsForHead: async (attemptId, head) => {
        calls.push('readReceiptsForHead');
        return settle(options.receipt ? options.receipt(attemptId, head) : FOUND);
      },
    },
    scorecard: {
      read: async () => {
        calls.push('read');
        return state.stored;
      },
      append: async (row) => {
        calls.push('append');
        const result = settle(options.appendResult ?? { outcome: 'appended' as const });
        if (result.outcome === 'appended') {
          appended.push(row);
        }
        return result;
      },
    },
  };
  state.deps = deps;
  return state;
}

describe('AppendScorecardUseCase', () => {
  it('appends one row for a terminal run', async () => {
    const h = harness();
    const result = await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW });
    const expected: LaneScorecardRow = {
      runId: RUN_ID,
      workOrderId: 'wo-example-1',
      tier: 2,
      finalState: 'merged',
      fixRounds: 1,
      attemptCount: 2,
      parkCount: 1,
      prNumber: 42,
      firstPassCompleted: false,
      reviewFindings: { blocker: 2, major: 2, minor: 4, nit: 8 },
      verificationResult: 'pass',
      durationMs: 3_600_000,
    };
    expect(result).toEqual({ outcome: 'appended', row: expected });
    expect(h.appended).toEqual([expected]);
  });

  it('marks a first pass that ended done and a stopped run', async () => {
    const h = harness({
      journal: [conduct('running', 1), conduct('stopped', 2)],
      attempts: [attempt('attempt-1'), attempt('attempt-2', { fixNumber: 1, outcome: 'no-commit' })],
      receipt: () => ({ outcome: 'none' }),
    });
    const result = await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW });
    expect(result.outcome).toBe('appended');
    if (result.outcome === 'appended') {
      expect(result.row.finalState).toBe('stopped');
      expect(result.row.firstPassCompleted).toBe(true);
      expect(result.row.reviewFindings).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
      expect(result.row.verificationResult).toBe('unknown');
      expect(result.row.durationMs).toBe(30 * 60 * 1000);
    }
  });

  it('derives the row only from the read-only stores', async () => {
    const h = harness();
    await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW });
    expect([...new Set(h.calls)].sort()).toEqual(
      ['append', 'get', 'listAttemptsByWorkOrder', 'listForRun', 'read', 'readReceiptsForHead'].sort(),
    );
    expect(h.calls.filter((call) => call === 'readReceiptsForHead')).toHaveLength(2);
    for (const store of [h.deps.runRepo, h.deps.attemptRepo, h.deps.runJournal, h.deps.receipts]) {
      expect(Object.keys(store)).toHaveLength(1);
    }
    expect(Object.keys(h.deps.scorecard).sort()).toEqual(['append', 'read']);
  });

  it('returns the recorded row when the run is already present', async () => {
    const recorded: LaneScorecardRow = {
      runId: RUN_ID,
      workOrderId: 'wo-recorded',
      tier: 1,
      finalState: 'merged',
      fixRounds: 0,
      attemptCount: 1,
      parkCount: 0,
      prNumber: null,
      firstPassCompleted: true,
      reviewFindings: { blocker: 0, major: 0, minor: 0, nit: 0 },
      verificationResult: 'unknown',
      durationMs: null,
    };
    const h = harness({ stored: { outcome: 'read', rows: [recorded], problems: [] } });
    const result = await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW });
    expect(result).toEqual({ outcome: 'already-present', row: recorded });
    expect(h.calls).toEqual(['read']);
  });

  it('answers already-present when the store reports a duplicate that is now recorded', async () => {
    const raced = harness({ appendResult: { outcome: 'refused', reason: 'duplicate-run' } });
    let reads = 0;
    const racedRow: LaneScorecardRow = {
      runId: RUN_ID, workOrderId: 'wo-raced', tier: 2, finalState: 'merged', fixRounds: 0, attemptCount: 0,
      parkCount: 0, prNumber: null, firstPassCompleted: false,
      reviewFindings: { blocker: 0, major: 0, minor: 0, nit: 0 }, verificationResult: 'unknown', durationMs: null,
    };
    const deps: AppendScorecardDependencies = {
      ...raced.deps,
      scorecard: {
        append: raced.deps.scorecard.append,
        read: async () => {
          reads += 1;
          return reads === 1 ? { outcome: 'absent' } : { outcome: 'read', rows: [racedRow], problems: [] };
        },
      },
    };
    expect(await new AppendScorecardUseCase(deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'already-present',
      row: racedRow,
    });
    expect(raced.appended).toEqual([]);
  });

  it('refuses a duplicate the store reports but does not hold', async () => {
    const h = harness({ appendResult: { outcome: 'refused', reason: 'duplicate-run' } });
    expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'duplicate-run',
    });
  });

  it('maps every scorecard refusal to a reason code', async () => {
    const cases: [LaneScorecardAppendResult, string][] = [
      [{ outcome: 'refused', reason: 'lock-busy' }, 'scorecard-locked'],
      [{ outcome: 'refused', reason: 'unreadable-store' }, 'scorecard-unreadable'],
      [{ outcome: 'refused', reason: 'unknown-schema-version' }, 'scorecard-unreadable'],
      [{ outcome: 'refused', reason: 'too-large' }, 'scorecard-unreadable'],
    ];
    for (const [appendResult, reason] of cases) {
      const h = harness({ appendResult });
      expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
        outcome: 'refused',
        reason,
      });
    }
    const thrown = harness({ appendResult: new Error(STORE_MESSAGE) });
    expect(await new AppendScorecardUseCase(thrown.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'scorecard-unreadable',
    });
  });

  it('refuses when the scorecard is unreadable', async () => {
    for (const stored of [
      { outcome: 'unreadable', reason: 'io-error' },
      { outcome: 'unreadable', reason: 'unknown-schema-version' },
    ] as const) {
      const h = harness({ stored });
      expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
        outcome: 'refused',
        reason: 'scorecard-unreadable',
      });
      expect(h.appended).toEqual([]);
    }
  });

  it('refuses a non-terminal run', async () => {
    for (const journal of [
      [conduct('ready', 1), conduct('running', 2)],
      [conduct('merged', 1), conduct('running', 2)],
      [conduct('parked', 1)],
      [intent(1)],
      [],
    ]) {
      const h = harness({ journal });
      expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
        outcome: 'refused',
        reason: 'run-not-terminal',
      });
      expect(h.calls).not.toContain('append');
    }
  });

  it('refuses an unknown run', async () => {
    const h = harness({ run: null });
    expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'run-not-found',
    });
    expect(h.calls).not.toContain('append');
  });

  it('refuses an unreadable store', async () => {
    const unreadable = { outcome: 'refused', reason: 'stores-unreadable' };
    const failures: HarnessOptions[] = [
      { run: new Error(STORE_MESSAGE) },
      { journal: new Error(STORE_MESSAGE) },
      { attempts: new Error(STORE_MESSAGE) },
      { receipt: () => new Error(STORE_MESSAGE) },
      { receipt: () => ({ outcome: 'unavailable', reason: 'evidence-unreadable' }) },
      { attempts: [attempt('attempt-1')] },
      { run: run({ workOrderId: '/secret/path' }) },
      { run: run({ round: -1 }) },
      { run: run({ runId: 'run-01JB0000000000000000000009' }) },
    ];
    for (const failure of failures) {
      const h = harness(failure);
      expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual(unreadable);
      expect(h.appended).toEqual([]);
      expect(h.calls).not.toContain('append');
    }
  });

  it('appends although a telemetry dispositions store would be unreadable', async () => {
    const h = harness();
    let dispositionReads = 0;
    const deps = {
      ...h.deps,
      dispositions: {
        read: async () => {
          dispositionReads += 1;
          throw new Error(STORE_MESSAGE);
        },
      },
    };
    const result = await new AppendScorecardUseCase(deps).appendScorecard({ runId: RUN_ID, nowIso: NOW });
    expect(result.outcome).toBe('appended');
    expect(h.appended).toHaveLength(1);
    expect(dispositionReads).toBe(0);
  });

  it('refuses a receipt read with an unknown outcome', async () => {
    const h = harness({ receipt: () => ({ outcome: 'error' } as never) });
    expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'stores-unreadable',
    });
    expect(h.appended).toEqual([]);
    expect(h.calls).not.toContain('append');
  });

  it('refuses a run record that repeats an attempt id', async () => {
    const h = harness({ run: run({ attemptIds: ['a1', 'a1'] }), attempts: [attempt('a1')] });
    expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'stores-unreadable',
    });
    expect(h.appended).toEqual([]);
    expect(h.calls).not.toContain('append');
  });

  it('refuses a run with more than 64 attempts', async () => {
    const ids = Array.from({ length: 65 }, (_, index) => `attempt-${index}`);
    const h = harness({ run: run({ attemptIds: ids }), attempts: ids.map((id) => attempt(id)) });
    expect(await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'stores-unreadable',
    });
  });

  it('writes nothing but the scorecard', async () => {
    const h = harness();
    await new AppendScorecardUseCase(h.deps).appendScorecard({ runId: RUN_ID, nowIso: NOW });
    expect(h.calls.filter((call) => call === 'append')).toHaveLength(1);
    expect(Object.keys(h.deps.runRepo)).toEqual(['get']);
    expect(Object.keys(h.deps.attemptRepo)).toEqual(['listAttemptsByWorkOrder']);
    expect(Object.keys(h.deps.runJournal)).toEqual(['listForRun']);
    expect(Object.keys(h.deps.receipts)).toEqual(['readReceiptsForHead']);
  });

  it('refuses a malformed request', async () => {
    const h = harness();
    const usecase = new AppendScorecardUseCase(h.deps);
    const throwing = {
      get runId(): string {
        throw new Error(STORE_MESSAGE);
      },
      nowIso: NOW,
    };
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(STORE_MESSAGE);
      },
    });
    const sparse = new Array(2);
    expect(LANE_RUN_ID_PATTERN.test('run-not-a-ulid')).toBe(false);
    const requests: unknown[] = [
      null,
      undefined,
      'run',
      42,
      [],
      sparse,
      {},
      { nowIso: NOW },
      { runId: 7, nowIso: NOW },
      { runId: RUN_ID },
      { runId: RUN_ID, nowIso: 'yesterday' },
      { runId: RUN_ID, nowIso: '2026-11-06T10:00:00' },
      { runId: '', nowIso: NOW },
      { runId: 'run-not-a-ulid', nowIso: NOW },
      { runId: `${RUN_ID}/../x`, nowIso: NOW },
      throwing,
      hostile,
    ];
    for (const request of requests) {
      expect(await usecase.appendScorecard(request as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(h.calls).toEqual([]);
  });

  it('never echoes a path or a stored value', async () => {
    const results = [
      await new AppendScorecardUseCase(harness({ run: new Error(STORE_MESSAGE) }).deps).appendScorecard({ runId: RUN_ID, nowIso: NOW }),
      await new AppendScorecardUseCase(harness({ receipt: () => ({ outcome: 'unavailable', reason: 'evidence-unreadable' }) }).deps).appendScorecard({ runId: RUN_ID, nowIso: NOW }),
      await new AppendScorecardUseCase(harness({ journal: [conduct('running', 1)] }).deps).appendScorecard({ runId: RUN_ID, nowIso: NOW }),
      await new AppendScorecardUseCase(harness().deps).appendScorecard({ runId: RUN_ID, nowIso: NOW }),
    ];
    const text = JSON.stringify(results);
    for (const forbidden of ['secret', 'ENOENT', '.json', 'ses_', 'fleet/', 'policy-example', 'worktree']) {
      expect(text).not.toContain(forbidden);
    }
    const rowText = JSON.stringify((results[3] as { row: LaneScorecardRow }).row);
    expect(rowText).not.toContain('/');
    expect(Object.keys(JSON.parse(rowText)).sort()).toEqual(
      ['attemptCount', 'durationMs', 'finalState', 'firstPassCompleted', 'fixRounds', 'parkCount', 'prNumber', 'reviewFindings', 'runId', 'tier', 'verificationResult', 'workOrderId'],
    );
  });

  it('keeps the generated behaviour without dependencies', async () => {
    await expect(new AppendScorecardUseCase().appendScorecard({ runId: RUN_ID, nowIso: NOW })).rejects.toThrow(
      'Not implemented: AppendScorecardUseCase',
    );
  });
});

describe('scorecard derivation helpers', () => {
  it('derives the verification result by precedence', () => {
    const read = (...results: string[]): ReadReceiptsForHeadResult => ({
      outcome: 'found',
      verification: results.map((result) => ({ receiptId: 'x' as never, result: result as never, exitCode: null, completedAtIso: NOW })),
      review: [],
    });
    expect(deriveVerificationResult([read('pass', 'fail')])).toBe('fail');
    expect(deriveVerificationResult([read('pending', 'pass')])).toBe('pass');
    expect(deriveVerificationResult([read('pending', 'unknown')])).toBe('pending');
    expect(deriveVerificationResult([read('unknown', 'not-applicable')])).toBe('unknown');
    expect(deriveVerificationResult([{ outcome: 'none' }])).toBe('unknown');
    expect(deriveVerificationResult([])).toBe('unknown');
  });

  it('leaves the duration unknown when a bound is missing or unparseable', () => {
    expect(deriveDurationMs([])).toBeNull();
    expect(deriveDurationMs([attempt('a', { createdAtIso: 'not a date' })])).toBeNull();
    expect(deriveDurationMs([attempt('a', { updatedAtIso: undefined as never })])).toBeNull();
    expect(
      deriveDurationMs([attempt('a', { createdAtIso: '2026-11-06T09:00:00.000Z', updatedAtIso: '2026-11-06T08:00:00.000Z' })]),
    ).toBeNull();
    expect(deriveDurationMs([attempt('a')])).toBe(30 * 60 * 1000);
  });
});

describe('keepRunAttempts', () => {
  it('returns null when a run repeats an attempt id', () => {
    expect(keepRunAttempts(run({ attemptIds: ['a1', 'a1'] }), [attempt('a1')])).toBeNull();
    expect(keepRunAttempts(run({ attemptIds: ['a1', 'a2', 'a1'] }), [attempt('a1'), attempt('a2')])).toBeNull();
  });

  it('keeps the attempts in attemptIds order for unique ids', () => {
    const a1 = attempt('a1');
    const a2 = attempt('a2');
    expect(keepRunAttempts(run({ attemptIds: ['a2', 'a1'] }), [a1, a2])).toEqual([a2, a1]);
    expect(keepRunAttempts(run({ attemptIds: [] }), [a1, a2])).toEqual([]);
  });
});
