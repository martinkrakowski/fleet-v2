// CompareScorecardUseCase (CO20): a read-only before/after scorecard
// comparison — counts, first-pass completions, fix rounds, review findings by
// severity, escaped defects via supersedesWorkOrderId, and merged-PR CI cost
// from the forge. Anything that cannot be read is named as unknown with ids
// and codes, never as zero or empty; the use case writes nothing and never
// throws on runtime input.

import { describe, expect, it } from 'vitest';

import { CompareScorecardUseCase, type CompareScorecardDependencies } from './CompareScorecardUseCase.use-case.js';
import type { CompareScorecardRequest, CompareScorecardResult } from '../ports/in/CompareScorecardPort.in-port.js';
import type { LaneScorecardReadResult, LaneScorecardRow } from '../ports/out/LaneScorecardPort.out-port.js';

const SPLIT = '2026-01-15T00:00:00.000Z';
const BEFORE_TS = '2026-01-10T12:00:00.000Z';
const AFTER_TS = '2026-01-20T12:00:00.000Z';
const HEAD_SHA = 'a'.repeat(40);
const SECRET_RUN_ID = `lane-${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')}`;

function costOfWorkflows(workflows: readonly { readonly name: string; readonly checkRuns: number; readonly billedMinutes: number }[]) {
  return {
    totalCheckRuns: workflows.reduce((sum, workflow) => sum + workflow.checkRuns, 0),
    totalBilledMinutes: workflows.reduce((sum, workflow) => sum + workflow.billedMinutes, 0),
    workflows: workflows.map((workflow) => ({
      workflowName: workflow.name,
      checkRuns: workflow.checkRuns,
      billedMinutes: workflow.billedMinutes,
    })),
  };
}

function rowOf(overrides: Partial<LaneScorecardRow> = {}): LaneScorecardRow {
  return {
    runId: 'run-1',
    workOrderId: 'wo-1',
    tier: 1,
    finalState: 'merged',
    fixRounds: 0,
    attemptCount: 0,
    parkCount: 0,
    prNumber: 11,
    firstPassCompleted: true,
    reviewFindings: { blocker: 1, major: 0, minor: 0, nit: 0 },
    verificationResult: 'pass',
    durationMs: 1_000,
    ...overrides,
  };
}

interface FakeRun {
  readonly workOrderId: string;
  readonly attemptIds: readonly string[];
}
interface FakeWorkOrder {
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAtIso: string;
  readonly supersedesWorkOrderId?: string;
}
interface FakeJournalEntry {
  readonly kind: string;
  readonly state: string | null;
  readonly recordedAtIso: string;
}

interface Scenario {
  readonly rows: readonly LaneScorecardRow[];
  readonly problems?: readonly { readonly lineNumber: number; readonly reason: 'malformed-line' }[];
  readonly outcome?: LaneScorecardReadResult['outcome'];
  readonly runs: ReadonlyMap<string, FakeRun>;
  readonly workOrders: ReadonlyMap<string, FakeWorkOrder>;
  readonly projects: ReadonlyMap<string, readonly FakeWorkOrder[]>;
  readonly journals: ReadonlyMap<string, readonly FakeJournalEntry[]>;
  readonly attempts?: ReadonlyMap<string, readonly unknown[]>;
  readonly throwingProjects?: ReadonlySet<string>;
  readonly forge?: (request: { readonly pullRequestNumber: number; readonly repository: { readonly owner: string; readonly repo: string } }) =>
    Promise<unknown> | unknown;
}

function depsOf(scenario: Scenario, options: { readonly forgeCalls?: Map<string, number>; readonly nowMs?: () => number } = {}): CompareScorecardDependencies {
  const { forgeCalls, nowMs } = options;
  return {
    scorecard: {
      read: async (): Promise<LaneScorecardReadResult> => {
        if (scenario.outcome === 'absent') {
          return { outcome: 'absent' };
        }
        if (scenario.outcome === 'unreadable') {
          return { outcome: 'unreadable', reason: 'io-error' };
        }
        return { outcome: 'read', rows: scenario.rows, problems: scenario.problems ?? [] };
      },
    },
    runRepo: {
      get: async (runId: string) => {
        const run = scenario.runs.get(runId);
        return run === undefined ? null : ({ runId, workOrderId: run.workOrderId, attemptIds: run.attemptIds } as never);
      },
    },
    attemptRepo: {
      listAttemptsByWorkOrder: async (workOrderId: string) => (scenario.attempts?.get(workOrderId) ?? []) as never,
    },
    runJournal: {
      listForRun: async (runId: string) => (scenario.journals.get(runId) ?? []) as never,
    },
    workOrderRepo: {
      findWorkOrderById: async (workOrderId: string) => {
        const workOrder = scenario.workOrders.get(workOrderId);
        return workOrder === undefined ? null : (workOrder as never);
      },
      listWorkOrdersByProject: async (projectId?: string) => {
        if (scenario.throwingProjects?.has(projectId ?? '')) {
          throw new Error('store unreadable at /home/someone/state');
        }
        return ((projectId === undefined ? [] : scenario.projects.get(projectId) ?? []) as unknown) as readonly never[];
      },
    },
    forgeRead: {
      readPullRequestCiCost: async (request) => {
        const repository = request.repository ?? { owner: '', repo: '' };
        if (forgeCalls !== undefined) {
          const key = `${repository.owner}/${repository.repo}#${request.pullRequestNumber}`;
          forgeCalls.set(key, (forgeCalls.get(key) ?? 0) + 1);
        }
        const answer = scenario.forge?.({ pullRequestNumber: request.pullRequestNumber, repository });
        return ((await answer) ?? { outcome: 'unavailable', reason: 'ci-cost-unavailable' }) as never;
      },
    },
    ...(nowMs !== undefined ? { nowMs } : {}),
  };
}

function journalsOf(rows: readonly LaneScorecardRow[]): ReadonlyMap<string, readonly FakeJournalEntry[]> {
  const journals = new Map<string, readonly FakeJournalEntry[]>();
  for (const row of rows) {
    journals.set(row.runId, [
      { kind: 'conduct', state: row.finalState, recordedAtIso: row.runId === 'run-1' ? BEFORE_TS : AFTER_TS },
    ]);
  }
  return journals;
}

function forgeAnswer(
  request: { readonly pullRequestNumber: number; readonly repository: { readonly owner: string; readonly repo: string } },
  cost: ReturnType<typeof costOfWorkflows>,
) {
  return {
    outcome: 'found',
    cost: { pullRequestNumber: request.pullRequestNumber, headSha: HEAD_SHA, ...cost },
  };
}

async function compare(deps: CompareScorecardDependencies, request: CompareScorecardRequest): Promise<CompareScorecardResult> {
  return new CompareScorecardUseCase(deps).compareScorecard(request);
}

describe('CompareScorecardUseCase', () => {
  it('compares before and after periods for zoned ISO datetimes, summing counts, findings, escaped defects and merged-PR CI costs', async () => {
    const rows = [
      rowOf({ runId: 'run-1', workOrderId: 'wo-1', prNumber: 11, firstPassCompleted: true, fixRounds: 1, reviewFindings: { blocker: 1, major: 0, minor: 2, nit: 0 } }),
      rowOf({ runId: 'run-2', workOrderId: 'wo-2', finalState: 'stopped', prNumber: null, firstPassCompleted: false, fixRounds: 2, reviewFindings: { blocker: 0, major: 1, minor: 0, nit: 3 } }),
      rowOf({ runId: 'run-3', workOrderId: 'wo-3', finalState: 'merged', prNumber: 12, verificationResult: 'pass', firstPassCompleted: false, reviewFindings: { blocker: 0, major: 0, minor: 0, nit: 0 } }),
    ];
    const scenario: Scenario = {
      rows,
      runs: new Map([
        ['run-1', { workOrderId: 'wo-1', attemptIds: [] }],
        ['run-2', { workOrderId: 'wo-2', attemptIds: [] }],
        ['run-3', { workOrderId: 'wo-3', attemptIds: [] }],
      ]),
      workOrders: new Map([
        ['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
        ['wo-2', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS }],
        ['wo-3', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS }],
      ]),
      projects: new Map([['p1', [
        { id: 'wo-10', projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS, supersedesWorkOrderId: 'wo-3' },
        { id: 'wo-11', projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS, supersedesWorkOrderId: 'wo-1' },
        { id: 'wo-12', projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS, supersedesWorkOrderId: 'wo-9' },
      ]]]),
      journals: journalsOf(rows),
      forge: (request) => forgeAnswer(request, request.pullRequestNumber === 11
        ? costOfWorkflows([{ name: 'build', checkRuns: 3, billedMinutes: 7 }])
        : costOfWorkflows([{ name: 'build', checkRuns: 1, billedMinutes: 1 }, { name: 'test', checkRuns: 2, billedMinutes: 4 }])),
    };
    const result = await compare(depsOf(scenario), { split: SPLIT });
    expect(result.outcome).toBe('compared');
    if (result.outcome !== 'compared' || result.scorecardAbsent) {
      throw new Error('expected a compared result');
    }
    expect(result.unknownRowCount).toBe(0);
    expect(result.fromIso).toBeNull();
    expect(result.toIso).toBeNull();
    expect(result.before).toEqual({
      runCount: 1,
      mergedRunCount: 1,
      stoppedRunCount: 0,
      firstPassCompletions: 1,
      fixRounds: 1,
      reviewFindings: { blocker: 1, major: 0, minor: 2, nit: 0 },
      escapedDefects: 1,
      ciCost: {
        knownPullRequestCount: 1,
        unknownPullRequestCount: 0,
        totalCheckRuns: 3,
        totalBilledMinutes: 7,
        pullRequests: [{ runId: 'run-1', prNumber: 11, checkRuns: 3, billedMinutes: 7, workflows: [{ workflowName: 'build', checkRuns: 3, billedMinutes: 7 }] }],
        unknownPullRequests: [],
      },
    });
    expect(result.after).toEqual({
      runCount: 2,
      mergedRunCount: 1,
      stoppedRunCount: 1,
      firstPassCompletions: 0,
      fixRounds: 2,
      reviewFindings: { blocker: 0, major: 1, minor: 0, nit: 3 },
      escapedDefects: 1,
      ciCost: {
        knownPullRequestCount: 1,
        unknownPullRequestCount: 0,
        totalCheckRuns: 3,
        totalBilledMinutes: 5,
        pullRequests: [{ runId: 'run-3', prNumber: 12, checkRuns: 3, billedMinutes: 5, workflows: [
          { workflowName: 'build', checkRuns: 1, billedMinutes: 1 },
          { workflowName: 'test', checkRuns: 2, billedMinutes: 4 },
        ] }],
        unknownPullRequests: [],
      },
    });
  });

  it('accepts YYYY-MM-DD boundaries, excludes rows outside [from, to], and normalizes the day to UTC start and end', async () => {
    const rows = [
      rowOf({ runId: 'run-1', workOrderId: 'wo-1' }),
      rowOf({ runId: 'run-2', workOrderId: 'wo-2', finalState: 'stopped', prNumber: null }),
      rowOf({ runId: 'run-3', workOrderId: 'wo-3' }),
    ];
    const scenario: Scenario = {
      rows,
      runs: new Map([
        ['run-1', { workOrderId: 'wo-1', attemptIds: [] }],
        ['run-2', { workOrderId: 'wo-2', attemptIds: [] }],
        ['run-3', { workOrderId: 'wo-3', attemptIds: [] }],
      ]),
      workOrders: new Map([
        ['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
        ['wo-2', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS }],
        ['wo-3', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS }],
      ]),
      projects: new Map(),
      // run-1 is before `from` 2026-01-05; run-2 and run-3 are after the split.
      journals: new Map([
        ['run-1', [{ kind: 'conduct', state: 'merged', recordedAtIso: '2026-01-02T00:00:00.000Z' }]],
        ['run-2', [{ kind: 'conduct', state: 'stopped', recordedAtIso: '2026-01-31T23:59:59.000Z' }]],
        ['run-3', [{ kind: 'conduct', state: 'merged', recordedAtIso: '2026-01-16T00:00:00.000Z' }]],
      ]),
    };
    const result = await compare(depsOf(scenario), { from: '2026-01-05', split: '2026-01-15', to: '2026-01-31' });
    expect(result.outcome === 'compared' && !result.scorecardAbsent).toBe(true);
    if (result.outcome !== 'compared') {
      throw new Error('expected a compared result');
    }
    expect(result.fromIso).toBe('2026-01-05T00:00:00.000Z');
    expect(result.toIso).toBe('2026-01-31T23:59:59.999Z');
    expect(result.before.runCount).toBe(0);
    expect(result.after.runCount).toBe(2);
    expect(result.after.mergedRunCount).toBe(1);
    expect(result.after.stoppedRunCount).toBe(1);
  });

  it('handles an absent scorecard as zeroed periods and refuses an unreadable scorecard or inverted ranges', async () => {
    const empty: Scenario = {
      rows: [],
      runs: new Map(),
      workOrders: new Map(),
      projects: new Map(),
      journals: new Map(),
    };
    const absent = await compare(depsOf({ ...empty, outcome: 'absent' }), { split: SPLIT });
    expect(absent).toEqual({
      outcome: 'compared',
      fromIso: null,
      splitIso: SPLIT,
      toIso: null,
      scorecardAbsent: true,
      before: {
        runCount: 0, mergedRunCount: 0, stoppedRunCount: 0, firstPassCompletions: 0, fixRounds: 0,
        reviewFindings: { blocker: 0, major: 0, minor: 0, nit: 0 }, escapedDefects: 0,
        ciCost: { knownPullRequestCount: 0, unknownPullRequestCount: 0, totalCheckRuns: 0, totalBilledMinutes: 0, pullRequests: [], unknownPullRequests: [] },
      },
      after: absent.outcome === 'compared' ? absent.after : null,
      unknownRowCount: 0,
      unknownRows: [],
    });
    const unreadable: Scenario = { ...empty, outcome: 'unreadable' };
    expect(await compare(depsOf(unreadable), { split: SPLIT })).toEqual({ outcome: 'refused', reason: 'scorecard-unreadable' });
    expect(await compare(depsOf(empty), { split: '2026-01-15', from: '2026-01-20' })).toEqual({ outcome: 'refused', reason: 'invalid-range' });
    expect(await compare(depsOf(empty), { split: '2026-01-15', to: '2026-01-10' })).toEqual({ outcome: 'refused', reason: 'invalid-range' });
    expect(await compare(depsOf(empty), { split: '2026-02-30' })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await compare(depsOf(empty), { split: 'not-a-date' })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await compare(depsOf(empty), { split: SPLIT, budgetMs: 0 })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await compare(depsOf(empty), { split: SPLIT, budgetMs: 300_001 })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await new CompareScorecardUseCase().compareScorecard({ split: SPLIT })).toEqual({ outcome: 'refused', reason: 'scorecard-unreadable' });
  });

  it('returns refusal or unknown row without throwing on null, non-object, bad prototype, wrong-typed fields, unknown enums, sparse store arrays, and throwing getters', async () => {
    const useCase = new CompareScorecardUseCase(depsOf({
      rows: [],
      runs: new Map(),
      workOrders: new Map(),
      projects: new Map(),
      journals: new Map(),
    }));
    for (const request of [null, undefined, 7, 'split', [], new Date(), Object.create(null)] as readonly unknown[]) {
      const result = await useCase.compareScorecard(request as never);
      expect(result.outcome).toBe('refused');
    }
    const throwing = {};
    Object.defineProperty(throwing, 'split', { get() { throw new Error('boom'); } });
    const thrownResult = await useCase.compareScorecard(throwing as never);
    expect(thrownResult.outcome).toBe('refused');
    const corrupted: Scenario = {
      rows: [
        { runId: 'run-1', workOrderId: 'wo-1', tier: 7 as never, finalState: 'abandoned' as never, fixRounds: 0, attemptCount: 0, parkCount: 0, prNumber: 0, firstPassCompleted: true, reviewFindings: { blocker: 0, major: 0, minor: 0, nit: 0 }, verificationResult: 'pass', durationMs: null },
        rowOf({ runId: 'run-2', workOrderId: 'wo-2', prNumber: -3 as never }),
        rowOf({ runId: 'run-3', workOrderId: 'wo-3', fixRounds: -1 as never }),
        rowOf({ runId: 'run-4', workOrderId: 'wo-4', durationMs: -5 as never }),
      ],
      runs: new Map(),
      workOrders: new Map(),
      projects: new Map(),
      journals: new Map(),
    };
    const badRows = await compare(depsOf(corrupted), { split: SPLIT });
    expect(badRows.outcome).toBe('compared');
    if (badRows.outcome === 'compared' && !badRows.scorecardAbsent) {
      expect(badRows.unknownRowCount).toBe(4);
      expect(badRows.unknownRows.every((unknownRow) => unknownRow.reason === 'malformed-row')).toBe(true);
    }
    // A sparse journal listing is a store that cannot be read, never a timestamp.
    const sparseJournalRows = [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })];
    const sparseJournals = new Map<string, readonly FakeJournalEntry[]>();
    const sparseEntries = new Array(2) as FakeJournalEntry[];
    sparseEntries[0] = { kind: 'conduct', state: 'merged', recordedAtIso: BEFORE_TS };
    sparseJournals.set('run-1', sparseEntries);
    const sparseScenario: Scenario = {
      rows: sparseJournalRows,
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map(),
      journals: sparseJournals,
    };
    const sparseResult = await compare(depsOf(sparseScenario), { split: SPLIT });
    expect(sparseResult.outcome === 'compared' && !sparseResult.scorecardAbsent && sparseResult.unknownRows[0]).toMatchObject({ kind: 'row', runId: 'run-1', reason: 'stores-unreadable' });
  });

  it('counts malformed scorecard lines, unreadable store rows, unreadable escaped-defect listings, and unavailable or not-found CI costs as unknown with ids and codes, never as zero', async () => {
    const rows = [
      rowOf({ runId: 'run-1', workOrderId: 'wo-1' }),
      rowOf({ runId: 'run-2', workOrderId: 'wo-2', prNumber: 12 }),
    ];
    const scenario: Scenario = {
      rows,
      problems: [{ lineNumber: 5, reason: 'malformed-line' }, { lineNumber: 9, reason: 'malformed-line' }],
      runs: new Map([
        ['run-1', { workOrderId: 'wo-1', attemptIds: [] }],
        ['run-2', { workOrderId: 'wo-2', attemptIds: [] }],
      ]),
      workOrders: new Map([
        ['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
        ['wo-2', { projectId: 'p2', repository: 'acme/widget', updatedAtIso: AFTER_TS }],
      ]),
      projects: new Map([['p2', []]]),
      throwingProjects: new Set(['p1']), // p1's listing throws -> run-1's escaped-defect listing is unknown
      journals: journalsOf(rows),
      forge: (request) => (request.pullRequestNumber === 11
        ? { outcome: 'not-found' }
        : { outcome: 'unavailable', reason: 'ci-cost-failed' }),
    };
    const result = await compare(depsOf(scenario), { split: SPLIT });
    expect(result.outcome).toBe('compared');
    if (result.outcome !== 'compared' || result.scorecardAbsent) {
      throw new Error('expected a compared result');
    }
    expect(result.unknownRowCount).toBe(3);
    expect(result.unknownRows).toEqual([
      { kind: 'line', lineNumber: 5, reason: 'malformed-line' },
      { kind: 'line', lineNumber: 9, reason: 'malformed-line' },
      { kind: 'row', runId: 'run-1', reason: 'stores-unreadable' },
    ]);
    // The unreadable project listing excludes the merged row from the counts,
    // and the unreadable CI cost of the other period's merged PR is named.
    expect(result.before.runCount).toBe(0);
    expect(result.after.ciCost.unknownPullRequestCount).toBe(1);
    expect(result.after.ciCost.unknownPullRequests[0]).toMatchObject({ runId: 'run-2', prNumber: 12, reason: 'ci-cost-unavailable' });
    const missingRun: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map(),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map(),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
    };
    const runNotFound = await compare(depsOf(missingRun), { split: SPLIT });
    expect(runNotFound.outcome === 'compared' && runNotFound.unknownRows[0]).toMatchObject({ runId: 'run-1', reason: 'run-not-found' });
    const missingWorkOrder: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map(),
      projects: new Map(),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
    };
    const workOrderNotFound = await compare(depsOf(missingWorkOrder), { split: SPLIT });
    expect(workOrderNotFound.outcome === 'compared' && workOrderNotFound.unknownRows[0]).toMatchObject({ runId: 'run-1', reason: 'work-order-not-found' });
    const unreadableListing: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map([['p1', []]]),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
      forge: () => ({ outcome: 'not-found' }),
    };
    const listingUnknown = await compare(depsOf(unreadableListing), { split: SPLIT });
    expect(listingUnknown.outcome === 'compared' && listingUnknown.before.ciCost.unknownPullRequests[0]).toMatchObject({ runId: 'run-1', prNumber: 11, reason: 'pr-not-found' });
  });

  it('writes nothing, queries each merged repository#prNumber at most once, and reports duplicate runId rows as unknown instead of double-counting', async () => {
    const rows = [
      rowOf({ runId: 'run-1', workOrderId: 'wo-1', prNumber: 11 }),
      rowOf({ runId: 'run-1', workOrderId: 'wo-1', prNumber: 11 }),
      rowOf({ runId: 'run-2', workOrderId: 'wo-2', prNumber: 11 }),
    ];
    const forgeCalls = new Map<string, number>();
    const scenario: Scenario = {
      rows,
      runs: new Map([
        ['run-1', { workOrderId: 'wo-1', attemptIds: [] }],
        ['run-2', { workOrderId: 'wo-2', attemptIds: [] }],
      ]),
      workOrders: new Map([
        ['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
        ['wo-2', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
      ]),
      projects: new Map([['p1', []]]),
      journals: journalsOf([rows[0] as LaneScorecardRow, rows[2] as LaneScorecardRow]),
      forge: (request) => forgeAnswer(request, costOfWorkflows([{ name: 'build', checkRuns: 2, billedMinutes: 2 }])),
    };
    const result = await compare(depsOf(scenario, { forgeCalls }), { split: SPLIT });
    expect(result.outcome === 'compared' && !result.scorecardAbsent).toBe(true);
    if (result.outcome !== 'compared') {
      throw new Error('expected a compared result');
    }
    expect(forgeCalls.get('acme/widget#11')).toBe(1);
    expect(result.unknownRows).toEqual([{ kind: 'row', runId: 'run-1', reason: 'duplicate-run-id' }]);
    expect(result.before.ciCost.knownPullRequestCount).toBe(1);
    expect(result.before.ciCost.totalCheckRuns).toBe(2);
  });

  it('guards outbound store and forge calls with budgetMs, passes remaining timeoutMs to forgeRead, mutates nothing, and marks unreached PR CI costs as budget-exhausted', async () => {
    const rows = [
      rowOf({ runId: 'run-1', workOrderId: 'wo-1', prNumber: 11 }),
      rowOf({ runId: 'run-2', workOrderId: 'wo-2', prNumber: 12 }),
    ];
    let call = 0;
    // The first ten clock reads (request, scorecard, three store reads per row, the project listing and the first PR) answer at the base instant; the eleventh is far past the deadline.
    const nowMs = () => {
      call += 1;
      return call > 10 ? 1_000_000_000_000 : 1_000_000;
    };
    const seenTimeouts: number[] = [];
    const scenario: Scenario = {
      rows,
      runs: new Map([
        ['run-1', { workOrderId: 'wo-1', attemptIds: [] }],
        ['run-2', { workOrderId: 'wo-2', attemptIds: [] }],
      ]),
      workOrders: new Map([
        ['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
        ['wo-2', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }],
      ]),
      projects: new Map([['p1', []]]),
      journals: journalsOf(rows),
      forge: (request) => {
        void request;
        return { outcome: 'not-found' };
      },
    };
    // A first pass without a tight budget answers everything normally.
    const normal = await compare(depsOf(scenario, { forgeCalls: new Map(), nowMs: () => 1_000_000 }), { split: SPLIT });
    expect(normal.outcome).toBe('compared');
    expect(seenTimeouts).toHaveLength(0);
    // A tight budget: the deadline runs out between the first and second PR.
    call = 0;
    const tightDeps = depsOf({
      ...scenario,
      forge: (request) => {
        const answer = scenario.forge?.(request);
        return answer;
      },
    }, { nowMs });
    const wrapped = tightDeps;
    const originalForge = wrapped.forgeRead.readPullRequestCiCost;
    wrapped.forgeRead.readPullRequestCiCost = async (request) => {
      seenTimeouts.push(request.timeoutMs ?? -1);
      return originalForge(request);
    };
    const tight = await compare(wrapped, { split: SPLIT, budgetMs: 2_000 });
    expect(seenTimeouts.length).toBeGreaterThanOrEqual(1);
    expect(seenTimeouts[0]).toBeGreaterThan(0);
    expect(seenTimeouts[0]).toBeLessThanOrEqual(2_000);
    expect(tight.outcome).toBe('compared');
    if (tight.outcome === 'compared' && !tight.scorecardAbsent) {
      const budgeted = tight.after.ciCost.unknownPullRequests.filter((unknown) => unknown.reason === 'budget-exhausted');
      expect(budgeted.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('never echoes secret-shaped text or filesystem paths from requests, store errors, or corrupted scorecard rows', async () => {
    const secretRows = [rowOf({ runId: SECRET_RUN_ID as never })];
    const scenario: Scenario = {
      rows: secretRows,
      runs: new Map(),
      workOrders: new Map(),
      projects: new Map(),
      journals: new Map(),
    };
    const result = await compare(depsOf(scenario), { split: SPLIT });
    expect(result.outcome === 'compared' && !result.scorecardAbsent).toBe(true);
    if (result.outcome !== 'compared') {
      throw new Error('expected a compared result');
    }
    expect(result.unknownRowCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET_RUN_ID);
    expect(result.unknownRows[0]).toEqual({ kind: 'row-index', rowIndex: 0, reason: 'invalid-row-id' });
    const throwingForge: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map([['p1', []]]),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
      forge: () => {
        throw new Error('connection refused to /home/someone/credentials.json');
      },
    };
    const thrown = await compare(depsOf(throwingForge), { split: SPLIT });
    expect(JSON.stringify(thrown)).not.toContain('/home/someone');
    expect(thrown.outcome === 'compared' && thrown.before.ciCost.unknownPullRequests[0]).toMatchObject({ runId: 'run-1', reason: 'ci-cost-unavailable' });
  });

  it('refuses oversized scorecard or problem arrays above COMPARE_SCORECARD_MAX_ROWS and bounds per-run and per-project store reads', async () => {
    const oversized = rowOf({ runId: 'run-1' });
    const bigRows: LaneScorecardRow[] = Array.from({ length: 5_001 }, (_, index) => rowOf({ runId: `run-${index + 1}` as never }));
    void oversized;
    const scenario: Scenario = {
      rows: bigRows,
      runs: new Map(),
      workOrders: new Map(),
      projects: new Map(),
      journals: new Map(),
    };
    expect(await compare(depsOf(scenario), { split: SPLIT })).toEqual({ outcome: 'refused', reason: 'scorecard-too-large' });
    const bigProblems: Scenario = {
      ...scenario,
      rows: [],
      problems: Array.from({ length: 5_001 }, (_, index) => ({ lineNumber: index + 1, reason: 'malformed-line' as const })),
    };
    expect(await compare(depsOf(bigProblems), { split: SPLIT })).toEqual({ outcome: 'refused', reason: 'scorecard-too-large' });
    // A run whose journal listing exceeds the bound is a store that cannot be read.
    const hugeJournal = new Map<string, readonly FakeJournalEntry[]>();
    const hugeEntries: FakeJournalEntry[] = Array.from({ length: 1_025 }, () => ({ kind: 'conduct', state: 'merged', recordedAtIso: BEFORE_TS }));
    hugeJournal.set('run-1', hugeEntries);
    const hugeScenario: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map(),
      journals: hugeJournal,
    };
    const bounded = await compare(depsOf(hugeScenario), { split: SPLIT });
    expect(bounded.outcome === 'compared' && bounded.unknownRows[0]).toMatchObject({ runId: 'run-1', reason: 'stores-unreadable' });
    // A project listing above the cap excludes that project's merged rows as unknown.
    const hugeProjects: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map([['p1', Array.from({ length: 20_001 }, (_, index) => ({ projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS, supersedesWorkOrderId: `wo-${index}` as string }))]]),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
      forge: () => ({ outcome: 'not-found' }),
    };
    const hugeProjectResult = await compare(depsOf(hugeProjects), { split: SPLIT });
    expect(hugeProjectResult.outcome === 'compared' && hugeProjectResult.unknownRows[0]).toMatchObject({ runId: 'run-1', reason: 'stores-unreadable' });
    // A merged row without a work-order repository or a PR number is unknown, never zero.
    const missingPr: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1', prNumber: null })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map([['p1', []]]),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
    };
    const missingPrResult = await compare(depsOf(missingPr), { split: SPLIT });
    expect(missingPrResult.outcome === 'compared' && missingPrResult.before.ciCost.unknownPullRequests[0]).toMatchObject({ runId: 'run-1', prNumber: null, reason: 'missing-pr-number' });
    const invalidRepo: Scenario = {
      rows: [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })],
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: [] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/../widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map([['p1', []]]),
      journals: journalsOf([rowOf({ runId: 'run-1' })]),
      forge: () => ({ outcome: 'not-found' }),
    };
    const invalidRepoResult = await compare(depsOf(invalidRepo), { split: SPLIT });
    expect(invalidRepoResult.outcome === 'compared' && invalidRepoResult.before.ciCost.unknownPullRequests[0]).toMatchObject({ runId: 'run-1', prNumber: 11, reason: 'invalid-repository' });
  });

  it('resolves a row timestamp from attempts when the journal has no terminal conduct entry, and marks an unreadable one', async () => {
    const rows = [rowOf({ runId: 'run-1', workOrderId: 'wo-1' })];
    const attempts: Scenario = {
      rows,
      runs: new Map([['run-1', { workOrderId: 'wo-1', attemptIds: ['a1'] }]]),
      workOrders: new Map([['wo-1', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: BEFORE_TS }]]),
      projects: new Map(),
      journals: new Map([['run-1', []]]),
      attempts: new Map([['wo-1', [{ id: 'a1', completionReceipt: { endedAtIso: BEFORE_TS }, updatedAtIso: BEFORE_TS }]]]),
    };
    const result = await compare(depsOf(attempts), { split: SPLIT });
    expect(result.outcome === 'compared' && !result.scorecardAbsent).toBe(true);
    if (result.outcome !== 'compared') {
      throw new Error('expected a compared result');
    }
    expect(result.unknownRowCount).toBe(0);
    expect(result.before.runCount).toBe(1);
    const unreadableAttempts: Scenario = {
      ...attempts,
      attempts: new Map([['wo-1', [{ id: 'a1', completionReceipt: { endedAtIso: 'not-a-date' }, updatedAtIso: BEFORE_TS }]]]),
    };
    const unreadable = await compare(depsOf(unreadableAttempts), { split: SPLIT });
    expect(unreadable.outcome === 'compared' && unreadable.unknownRows[0]).toMatchObject({ runId: 'run-1', reason: 'timestamp-unreadable' });
  });

  describe('Luna pre-merge round 1 (robustness)', () => {
    function scenarioOf(rows: readonly LaneScorecardRow[], workOrders: ReadonlyMap<string, unknown>): Scenario {
      return {
        rows,
        runs: new Map(rows.map((row) => [row.runId, { workOrderId: row.workOrderId, attemptIds: [] }])),
        workOrders: workOrders as never,
        projects: new Map([['', []]]),
        journals: journalsOf(rows),
      };
    }

    it('marks a merged row whose work order has no string projectId unknown instead of counting it with zero escaped defects', async () => {
      const rows = [rowOf({ runId: 'run-3', workOrderId: 'wo-3', prNumber: null })];
      const result = await compare(depsOf(scenarioOf(rows, new Map([['wo-3', { repository: 'acme/widget', updatedAtIso: AFTER_TS }]]))), { split: SPLIT });
      if (result.outcome !== 'compared' || result.scorecardAbsent) {
        throw new Error('expected a compared result');
      }
      expect(result.after.runCount).toBe(0);
      expect(result.unknownRows).toEqual([{ kind: 'row', runId: 'run-3', reason: 'stores-unreadable' }]);
    });

    it('checks the deadline before every store read of a row and issues no further reads once the budget is spent', async () => {
      const rows = [rowOf({ runId: 'run-3', workOrderId: 'wo-3', prNumber: null })];
      const scenario = scenarioOf(rows, new Map([['wo-3', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS }]]));
      let spent = false;
      const later: string[] = [];
      const deps = depsOf(scenario, { nowMs: () => (spent ? 1_000_000_000_000 : 1_000_000) });
      const runGet = deps.runRepo.get.bind(deps.runRepo);
      deps.runRepo.get = async (runId) => {
        spent = true;
        return runGet(runId);
      };
      const findWorkOrder = deps.workOrderRepo.findWorkOrderById.bind(deps.workOrderRepo);
      deps.workOrderRepo.findWorkOrderById = async (id) => {
        later.push('workOrder');
        return findWorkOrder(id);
      };
      deps.runJournal.listForRun = async () => {
        later.push('journal');
        return [] as never;
      };
      deps.attemptRepo.listAttemptsByWorkOrder = async () => {
        later.push('attempts');
        return [] as never;
      };
      const result = await compare(deps, { split: SPLIT, budgetMs: 5_000 });
      if (result.outcome !== 'compared' || result.scorecardAbsent) {
        throw new Error('expected a compared result');
      }
      expect(later).toEqual([]);
      expect(result.after.runCount).toBe(0);
      expect(result.unknownRows).toEqual([{ kind: 'row', runId: 'run-3', reason: 'budget-exhausted' }]);
    });

    it('turns a forge result with a throwing getter into an unknown CI cost, never a throw', async () => {
      const rows = [rowOf({ runId: 'run-3', workOrderId: 'wo-3', prNumber: 12 })];
      const scenario: Scenario = {
        ...scenarioOf(rows, new Map([['wo-3', { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS }]])),
        projects: new Map([['p1', []]]),
        forge: () => {
          const answer = {};
          Object.defineProperty(answer, 'outcome', { get() { throw new Error('getter boom'); } });
          return answer;
        },
      };
      const result = await compare(depsOf(scenario), { split: SPLIT });
      if (result.outcome !== 'compared' || result.scorecardAbsent) {
        throw new Error('expected a compared result');
      }
      expect(result.after.ciCost.unknownPullRequests).toEqual([{ runId: 'run-3', prNumber: 12, reason: 'ci-cost-unavailable' }]);
    });

    it('rejects a row whose fixRounds would overflow a safe integer without counting any part of it', async () => {
      const rows = [
        rowOf({ runId: 'run-2', workOrderId: 'wo-2', finalState: 'stopped', prNumber: null, fixRounds: Number.MAX_SAFE_INTEGER }),
        rowOf({ runId: 'run-3', workOrderId: 'wo-3', finalState: 'stopped', prNumber: null, fixRounds: Number.MAX_SAFE_INTEGER, reviewFindings: { blocker: 5, major: 0, minor: 0, nit: 0 } }),
      ];
      const workOrder = { projectId: 'p1', repository: 'acme/widget', updatedAtIso: AFTER_TS };
      const result = await compare(depsOf(scenarioOf(rows, new Map([['wo-2', workOrder], ['wo-3', workOrder]]))), { split: SPLIT });
      if (result.outcome !== 'compared' || result.scorecardAbsent) {
        throw new Error('expected a compared result');
      }
      expect(result.after.runCount).toBe(1);
      expect(result.after.stoppedRunCount).toBe(1);
      expect(result.after.fixRounds).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.after.reviewFindings.blocker).toBe(1);
      expect(result.unknownRows).toEqual([{ kind: 'row', runId: 'run-3', reason: 'stores-unreadable' }]);
    });
  });
});
