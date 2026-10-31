/**
 * Regression tests for CL-12: `ListStaleWorkOrdersUseCase` must read the work
 * orders once, every lane run once, and each run's journal exactly once —
 * before the per-work-order loop. Reading inside the loop would cost
 * O(work orders × runs) reads on a large state dir; these tests pin the
 * single-read shape with exact call counts per read fake.
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
const RUN_3 = 'run-01JB000000000000000000000C';
const RUN_4 = 'run-01JB000000000000000000000D';
const COMMIT = 'a'.repeat(40);

// Fixture makers, copied from list-stale-work-orders.test.ts (CL-12: the new
// file never imports from the other test file and never edits it).

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

type CountedWorkOrderRepo = Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'> & {
  readonly listWorkOrdersByProjectCalls: number;
  readonly listWorkOrdersByProjectProjects: readonly (string | undefined)[];
};

function makeWorkOrderRepo(initial: WorkOrderRecord[] = []): CountedWorkOrderRepo {
  const workOrders = new Map<string, WorkOrderRecord>(initial.map((record) => [record.id, record]));
  let listWorkOrdersByProjectCalls = 0;
  const listWorkOrdersByProjectProjects: (string | undefined)[] = [];
  return {
    get listWorkOrdersByProjectCalls(): number {
      return listWorkOrdersByProjectCalls;
    },
    get listWorkOrdersByProjectProjects(): readonly (string | undefined)[] {
      return listWorkOrdersByProjectProjects;
    },
    async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
      listWorkOrdersByProjectCalls += 1;
      listWorkOrdersByProjectProjects.push(projectId);
      const all = [...workOrders.values()];
      return projectId === undefined ? all : all.filter((record) => record.projectId === projectId);
    },
  };
}

type CountedAttemptRepo = Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'> & {
  readonly listAttemptsCalls: number;
  readonly listAttemptsArguments: readonly string[];
};

function makeAttemptRepo(attempts: AttemptRecord[] = []): CountedAttemptRepo {
  let listAttemptsCalls = 0;
  const listAttemptsArguments: string[] = [];
  return {
    get listAttemptsCalls(): number {
      return listAttemptsCalls;
    },
    get listAttemptsArguments(): readonly string[] {
      return listAttemptsArguments;
    },
    async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
      listAttemptsCalls += 1;
      listAttemptsArguments.push(workOrderId);
      return attempts.filter((attempt) => attempt.workOrderId === workOrderId);
    },
  };
}

type CountedRunRepo = Pick<LaneRunRepositoryPort, 'list'> & {
  readonly runListCalls: number;
};

function makeRunRepo(runs: LaneRunRecord[] = []): CountedRunRepo {
  let runListCalls = 0;
  return {
    get runListCalls(): number {
      return runListCalls;
    },
    async list(): Promise<readonly LaneRunRecord[]> {
      runListCalls += 1;
      return runs;
    },
  };
}

type CountedRunJournal = Pick<LaneRunJournalPort, 'listForRun'> & {
  readonly listForRunCalls: number;
  readonly listForRunArguments: readonly string[];
};

function makeRunJournal(states: Map<string, string>): CountedRunJournal {
  let listForRunCalls = 0;
  const listForRunArguments: string[] = [];
  return {
    get listForRunCalls(): number {
      return listForRunCalls;
    },
    get listForRunArguments(): readonly string[] {
      return listForRunArguments;
    },
    async listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
      listForRunCalls += 1;
      listForRunArguments.push(runId);
      const state = states.get(runId);
      return state === undefined ? [] : [journalEntry(runId, state)];
    },
  };
}

interface Harness {
  readonly workOrderRepo: CountedWorkOrderRepo;
  readonly attemptRepo: CountedAttemptRepo;
  readonly runRepo: CountedRunRepo;
  readonly runJournal: CountedRunJournal;
  readonly useCase: ListStaleWorkOrdersUseCase;
}

function harness(options: {
  workOrders?: WorkOrderRecord[];
  attempts?: AttemptRecord[];
  runs?: LaneRunRecord[];
  journalStates?: Map<string, string>;
} = {}): Harness {
  const workOrderRepo = makeWorkOrderRepo(options.workOrders ?? []);
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

describe('ListStaleWorkOrdersUseCase read counts', () => {
  it('reads work orders, runs and journals once, and attempts only for listed work orders', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a'), makeWorkOrder('wo-b'), makeWorkOrder('wo-c')],
      runs: [
        runRecord(RUN_1, 'wo-a'),
        runRecord(RUN_2, 'wo-a'),
        runRecord(RUN_3, 'wo-b'),
        // The fourth run belongs to a work order that does not exist: the use
        // case still reads its journal exactly once (before grouping) and
        // never lists it.
        runRecord(RUN_4, 'wo-ghost'),
      ],
      journalStates: new Map([
        [RUN_1, 'merged'],
        [RUN_2, 'stopped'],
        [RUN_3, 'running'],
        [RUN_4, 'running'],
      ]),
    });

    const result = await list(h);

    // The entries, so the read-count assertions below guard real behaviour:
    // A is runs-ended (two terminal runs, one merged), B is not listed (its
    // run is non-terminal), C is no-run.
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
        {
          kind: 'no-run',
          workOrderId: 'wo-c',
          workOrderState: 'approved',
          runs: [],
          attemptCount: 0,
          suggestedClose: null,
        },
      ],
    });

    // Reads happen once: work orders once, runs once, each run's journal
    // exactly once, and attempts only for the listed work orders (A and C;
    // never B).
    expect(h.workOrderRepo.listWorkOrdersByProjectCalls).toBe(1);
    expect(h.runRepo.runListCalls).toBe(1);
    expect(h.runJournal.listForRunCalls).toBe(4);
    expect([...h.runJournal.listForRunArguments].sort()).toEqual([RUN_1, RUN_2, RUN_3, RUN_4].sort());
    expect(h.attemptRepo.listAttemptsCalls).toBe(2);
    expect([...h.attemptRepo.listAttemptsArguments].sort()).toEqual(['wo-a', 'wo-c'].sort());
  });

  it('reads the journal of a run whose work order does not exist exactly once, and never reads its attempts', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      runs: [runRecord(RUN_1, 'wo-a'), runRecord(RUN_2, 'wo-ghost')],
      journalStates: new Map([
        [RUN_1, 'stopped'],
        [RUN_2, 'running'],
      ]),
    });

    const result = await list(h);

    expect(result.entries.map((entry) => entry.workOrderId)).toEqual(['wo-a']);
    expect(h.workOrderRepo.listWorkOrdersByProjectCalls).toBe(1);
    expect(h.runRepo.runListCalls).toBe(1);
    expect(h.runJournal.listForRunCalls).toBe(2);
    expect([...h.runJournal.listForRunArguments].sort()).toEqual([RUN_1, RUN_2].sort());
    expect(h.attemptRepo.listAttemptsCalls).toBe(1);
    expect(h.attemptRepo.listAttemptsArguments).toEqual(['wo-a']);
  });

  it('passes the trimmed projectId to listWorkOrdersByProject exactly once', async () => {
    const h = harness({
      workOrders: [
        makeWorkOrder('wo-a', { projectId: 'project-a' }),
        makeWorkOrder('wo-b', { projectId: 'project-b' }),
      ],
    });

    const result = await list(h, { projectId: '  project-b  ' });

    expect(h.workOrderRepo.listWorkOrdersByProjectCalls).toBe(1);
    expect(h.workOrderRepo.listWorkOrdersByProjectProjects).toEqual(['project-b']);
    expect(result.entries.map((entry) => entry.workOrderId)).toEqual(['wo-b']);
  });
});
