/**
 * Unit tests for KF-36b-2: the read-only stale work-order listing
 * (`ListStaleWorkOrdersUseCase`). Never writes: the use case's dependencies
 * are `Pick`s of read methods only, and a fake whose save would throw is never
 * called.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { ListStaleWorkOrdersUseCase } from '../ListStaleWorkOrdersUseCase.use-case.js';
import type { ListStaleWorkOrdersResult } from '../../ports/in/ListStaleWorkOrdersPort.in-port.js';

const NOW = '2026-10-31T00:00:00.000Z';
/** Run ids must satisfy the run-id pattern or the journal reads them as `ready`. */
const RUN_1 = 'run-01JB000000000000000000000A';
const RUN_2 = 'run-01JB000000000000000000000B';
const COMMIT = 'a'.repeat(40);
const WORKTREE = '/tmp/worktree-example-1';

function makeWorkOrder(id: string, overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id,
    projectId: 'project-a',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'repo-1',
    baseCommit: COMMIT,
    ownedPaths: ['src/example.ts'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
    ...overrides,
  };
}

function attemptFixture(workOrderId: string, id: string): AttemptRecord {
  return {
    id,
    workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'ended',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

function runRecord(runId: string, workOrderId: string, overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    ...overrides,
  } as LaneRunRecord;
}

function journalEntry(runId: string, state: string): LaneRunJournalEntryRecord {
  return {
    kind: 'conduct',
    runId,
    state,
  } as unknown as LaneRunJournalEntryRecord;
}

type WorkOrderTestRepo = Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'> & {
  workOrders: Map<string, WorkOrderRecord>;
  /** The listing never writes; a fake save throws if it is ever called. */
  saveWorkOrder: (record: WorkOrderRecord) => Promise<void>;
};

function makeWorkOrderRepo(initial: WorkOrderRecord[] = []): WorkOrderTestRepo {
  const workOrders = new Map<string, WorkOrderRecord>(initial.map((record) => [record.id, record]));
  return {
    workOrders,
    async saveWorkOrder() {
      throw new Error('saveWorkOrder must never be called by ListStaleWorkOrdersUseCase');
    },
    async listWorkOrdersByProject(projectId) {
      const all = [...workOrders.values()];
      return projectId === undefined ? all : all.filter((record) => record.projectId === projectId);
    },
  };
}

function makeAttemptRepo(attempts: AttemptRecord[] = []): Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'> {
  return {
    async listAttemptsByWorkOrder(workOrderId) {
      return attempts.filter((attempt) => attempt.workOrderId === workOrderId);
    },
  };
}

function makeRunRepo(runs: LaneRunRecord[] = []): Pick<LaneRunRepositoryPort, 'list'> {
  return {
    async list() {
      return runs;
    },
  };
}

function makeRunJournal(states: Map<string, string>): Pick<LaneRunJournalPort, 'listForRun'> {
  return {
    async listForRun(runId) {
      const state = states.get(runId);
      return state === undefined ? [] : [journalEntry(runId, state)];
    },
  };
}

interface Harness {
  readonly workOrderRepo: WorkOrderTestRepo;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly useCase: ListStaleWorkOrdersUseCase;
}

function harness(options: {
  workOrders?: WorkOrderRecord[];
  attempts?: AttemptRecord[];
  runs?: LaneRunRecord[];
  journalStates?: Map<string, string>;
} = {}): Harness {
  const workOrderRepo = makeWorkOrderRepo(options.workOrders ?? [makeWorkOrder('wo-a')]);
  const attemptRepo = makeAttemptRepo(options.attempts ?? []);
  const runRepo = makeRunRepo(options.runs ?? []);
  const runJournal = makeRunJournal(options.journalStates ?? new Map());
  const useCase = new ListStaleWorkOrdersUseCase({
    workOrderRepo,
    attemptRepo,
    runRepo,
    runJournal,
  });
  return { workOrderRepo, attemptRepo, runRepo, runJournal, useCase };
}

function list(h: Harness, request: { projectId?: string } = {}): Promise<ListStaleWorkOrdersResult> {
  return h.useCase.listStaleWorkOrders(request);
}

describe('ListStaleWorkOrdersUseCase', () => {
  it('lists an active work order whose every run is terminal as runs-ended, with suggestedClose merged when any run merged', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      runs: [runRecord(RUN_1, 'wo-a'), runRecord(RUN_2, 'wo-a')],
      journalStates: new Map([[RUN_1, 'merged'], [RUN_2, 'stopped']]),
    });
    const result = await list(h);
    expect(result).toEqual({
      outcome: 'listed',
      entries: [
        {
          kind: 'runs-ended',
          workOrderId: 'wo-a',
          workOrderState: 'approved',
          runs: [
            { runId: RUN_1, state: 'merged' },
            { runId: RUN_2, state: 'stopped' },
          ],
          attemptCount: 0,
          suggestedClose: 'merged',
        },
      ],
    });
  });

  it('suggests stopped for runs-ended when no run ended merged', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      runs: [runRecord(RUN_1, 'wo-a'), runRecord(RUN_2, 'wo-a')],
      journalStates: new Map([[RUN_1, 'stopped'], [RUN_2, 'stopped']]),
    });
    const result = await list(h);
    expect(result.entries[0].suggestedClose).toBe('stopped');
  });

  it('lists an active work order with no run as no-run, with its attempt count', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts: [attemptFixture('wo-a', 'attempt-1'), attemptFixture('wo-a', 'attempt-2')],
    });
    const result = await list(h);
    expect(result.entries).toEqual([
      {
        kind: 'no-run',
        workOrderId: 'wo-a',
        workOrderState: 'approved',
        runs: [],
        attemptCount: 2,
        suggestedClose: null,
      },
    ]);
  });

  it('lists a closed work order with a non-terminal run as run-on-closed-work-order, with only the non-terminal runs', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a', { state: 'stopped' })],
      runs: [runRecord(RUN_1, 'wo-a'), runRecord(RUN_2, 'wo-a')],
      journalStates: new Map([[RUN_1, 'stopped'], [RUN_2, 'running']]),
    });
    const result = await list(h);
    expect(result.entries).toEqual([
      {
        kind: 'run-on-closed-work-order',
        workOrderId: 'wo-a',
        workOrderState: 'stopped',
        runs: [{ runId: RUN_2, state: 'running' }],
        attemptCount: 0,
        suggestedClose: null,
      },
    ]);
  });

  it('does not list an active work order with one terminal and one non-terminal run', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      runs: [runRecord(RUN_1, 'wo-a'), runRecord(RUN_2, 'wo-a')],
      journalStates: new Map([[RUN_1, 'stopped'], [RUN_2, 'running']]),
    });
    const result = await list(h);
    expect(result.entries).toEqual([]);
  });

  it('does not list a closed work order whose runs are all terminal', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a', { state: 'merged' })],
      runs: [runRecord(RUN_1, 'wo-a')],
      journalStates: new Map([[RUN_1, 'merged']]),
    });
    const result = await list(h);
    expect(result.entries).toEqual([]);
  });

  it('narrows to projectId when given', async () => {
    const h = harness({
      workOrders: [
        makeWorkOrder('wo-a', { projectId: 'project-a' }),
        makeWorkOrder('wo-b', { projectId: 'project-b' }),
      ],
    });
    const result = await list(h, { projectId: 'project-b' });
    expect(result.entries.map((entry) => entry.workOrderId)).toEqual(['wo-b']);
  });

  it('sorts entries by workOrderId and runs by runId in code-unit order', async () => {
    const h = harness({
      workOrders: [
        makeWorkOrder('wo-b'),
        makeWorkOrder('wo-a'),
        makeWorkOrder('wo-c'),
      ],
      runs: [
        runRecord(RUN_2, 'wo-a'),
        runRecord(RUN_1, 'wo-a'),
      ],
      journalStates: new Map([[RUN_1, 'stopped'], [RUN_2, 'merged']]),
    });
    const result = await list(h);
    expect(result.entries.map((entry) => entry.workOrderId)).toEqual(['wo-a', 'wo-b', 'wo-c']);
    expect(result.entries[0].runs.map((run) => run.runId)).toEqual([RUN_1, RUN_2]);
  });

  it('ignores runs whose work order does not exist', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      runs: [runRecord(RUN_1, 'wo-a'), runRecord(RUN_2, 'wo-ghost')],
      journalStates: new Map([[RUN_1, 'stopped']]),
    });
    const result = await list(h);
    expect(result.entries).toEqual([
      expect.objectContaining({
        workOrderId: 'wo-a',
        runs: [{ runId: RUN_1, state: 'stopped' }],
      }),
    ]);
  });

  it('never calls saveWorkOrder on the work order repository', async () => {
    const h = harness();
    let saveCalls = 0;
    h.workOrderRepo.saveWorkOrder = async () => {
      saveCalls += 1;
    };
    await list(h);
    expect(saveCalls).toBe(0);
  });

  it('propagates a throw from a read instead of reporting nothing stale', async () => {
    const h = harness();
    h.workOrderRepo.listWorkOrdersByProject = async () => {
      throw new Error('unreadable store');
    };
    await expect(list(h)).rejects.toThrow('unreadable store');
  });
});
