/**
 * Unit tests for KF-36b-1a: the operator close of a stale work order
 * (`CloseWorkOrderUseCase`) and the shared hold-facts helper
 * (`workOrderHoldFacts`). Fail closed: every refusal saves nothing.
 */

import { describe, expect, it } from 'vitest';

import type {
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import {
  CloseWorkOrderUseCase,
} from '../CloseWorkOrderUseCase.use-case.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import { workOrderHoldFacts } from '../work-order-hold-facts.js';
import type {
  CloseWorkOrderResult,
} from '../../ports/in/CloseWorkOrderPort.in-port.js';

const NOW = '2026-10-31T00:00:00.000Z';
/** Run ids must satisfy the run-id pattern or the journal reads them as `ready`. */
const RUN_1 = 'run-01JB000000000000000000000A';
const RUN_2 = 'run-01JB000000000000000000000B';
const RUN_3 = 'run-01JB000000000000000000000C';
const RUN_4 = 'run-01JB000000000000000000000D';
/** Different from the harness clock `NOW` and from any request's `nowIso`. */
const UPDATED_AT = '2026-10-30T00:00:00.000Z';
/** A request `nowIso` different from the harness clock `NOW`. */
const REQUEST_NOW = '2026-10-31T12:00:00.000Z';
const WORK_ORDER_ID = 'wo-example-1';
const PROJECT_ID = 'project-example-1';
const COMMIT = 'a'.repeat(40);
const WORKTREE = '/tmp/worktree-example-1';

/** The other work order registered in the end-to-end test. */
const OVERLAPPING_WORK_ORDER_ID = 'wo-example-2';

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: PROJECT_ID,
    taskId: 'task-example-1',
    laneId: 'lane-example',
    repository: 'repo-example',
    baseCommit: COMMIT,
    ownedPaths: ['src/example.ts'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: UPDATED_AT,
    risk: 'standard',
    ...overrides,
  };
}

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: WORK_ORDER_ID,
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
    ...overrides,
  };
}

function runRecord(overrides: Partial<LaneRunRecord> & Pick<LaneRunRecord, 'runId' | 'workOrderId'>): LaneRunRecord {
  return {
    version: 1,
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
    runPolicyRevision: 'policy-example-1',
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
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

function makeWorkOrderRepo(initial: WorkOrderRecord[] = []): WorkOrderRepositoryPort & {
  workOrders: Map<string, WorkOrderRecord>;
} {
  const workOrders = new Map<string, WorkOrderRecord>(initial.map((record) => [record.id, record]));
  return {
    workOrders,
    async saveWorkOrder(record) {
      const stored = workOrders.get(record.id);
      if (stored !== undefined && record.revision <= stored.revision) {
        throw new Error(`stale work order revision for ${record.id}`);
      }
      workOrders.set(record.id, record);
    },
    async findWorkOrderById(id) {
      return workOrders.get(id) ?? null;
    },
    async listWorkOrdersByProject() {
      return [...workOrders.values()];
    },
  };
}

function makeAttemptRepo(attempts: AttemptRecord[] = []): AttemptRepositoryPort & {
  attempts: Map<string, AttemptRecord>;
} {
  const map = new Map<string, AttemptRecord>(attempts.map((record) => [record.id, record]));
  return {
    attempts: map,
    async saveAttempt(record) {
      map.set(record.id, record);
    },
    async findAttemptById(id) {
      return map.get(id) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId) {
      return [...map.values()].filter((attempt) => attempt.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...map.values()];
    },
  };
}

function makeRunRepo(runs: LaneRunRecord[] = []): Pick<LaneRunRepositoryPort, 'list'> & {
  runs: LaneRunRecord[];
} {
  const list = [...runs];
  return {
    runs: list,
    async list() {
      return list;
    },
  };
}

function makeRunJournal(states: Map<string, string>): Pick<LaneRunJournalPort, 'listForRun'> & {
  states: Map<string, string>;
} {
  return {
    states,
    async listForRun(runId) {
      const state = states.get(runId);
      return state === undefined ? [] : [journalEntry(runId, state)];
    },
  };
}

function makeExecutionJournal(reservations: CapacityReservationRecord[] = []):
  Pick<ExecutionJournalPort, 'listActiveReservations'> & {
    reservations: CapacityReservationRecord[];
  } {
  const list = [...reservations];
  return {
    reservations: list,
    async listActiveReservations() {
      return list;
    },
  };
}

interface Harness {
  readonly workOrderRepo: ReturnType<typeof makeWorkOrderRepo>;
  readonly attemptRepo: ReturnType<typeof makeAttemptRepo>;
  readonly runRepo: ReturnType<typeof makeRunRepo>;
  readonly runJournal: ReturnType<typeof makeRunJournal>;
  readonly executionJournal: ReturnType<typeof makeExecutionJournal>;
  readonly useCase: CloseWorkOrderUseCase;
}

function harness(options: {
  workOrders?: WorkOrderRecord[];
  attempts?: AttemptRecord[];
  runs?: LaneRunRecord[];
  journalStates?: Map<string, string>;
  reservations?: CapacityReservationRecord[];
} = {}): Harness {
  const workOrderRepo = makeWorkOrderRepo(options.workOrders ?? [makeWorkOrder()]);
  const attemptRepo = makeAttemptRepo(options.attempts ?? []);
  const runRepo = makeRunRepo(options.runs ?? []);
  const runJournal = makeRunJournal(options.journalStates ?? new Map());
  const executionJournal = makeExecutionJournal(options.reservations ?? []);
  const useCase = new CloseWorkOrderUseCase({
    workOrderRepo,
    attemptRepo,
    runRepo,
    runJournal,
    executionJournal,
    now: () => NOW,
  });
  return { workOrderRepo, attemptRepo, runRepo, runJournal, executionJournal, useCase };
}

function close(h: Harness, state: 'merged' | 'stopped', overrides: Record<string, unknown> = {}):
  Promise<CloseWorkOrderResult> {
  return h.useCase.execute({
    workOrderId: WORK_ORDER_ID,
    state,
    nowIso: NOW,
    ...overrides,
  }) as Promise<CloseWorkOrderResult>;
}

function reservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'reservation-example-1',
    attemptId: 'attempt-example-1',
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: null,
    ...overrides,
  } as CapacityReservationRecord;
}

describe('CloseWorkOrderUseCase', () => {
  describe('closes', () => {
    it('closes an approved work order whose only run is stopped as stopped', async () => {
      const h = harness({
        runs: [runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID })],
        journalStates: new Map([[RUN_1, 'stopped']]),
      });
      const result = await close(h, 'stopped', { nowIso: REQUEST_NOW });
      expect(result).toEqual({
        outcome: 'closed',
        workOrderId: WORK_ORDER_ID,
        state: 'stopped',
        revision: 2,
      });
      const saved = h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!;
      expect(saved.state).toBe('stopped');
      expect(saved.revision).toBe(2);
      // The request's `nowIso` is stored, not the fixture's `updatedAtIso`
      // (which differs) and not the harness clock.
      expect(saved.updatedAtIso).toBe(REQUEST_NOW);
    });

    it('closes an approved work order whose run is merged as merged', async () => {
      const h = harness({
        runs: [runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID })],
        journalStates: new Map([[RUN_1, 'merged']]),
      });
      const result = await h.useCase.execute({ workOrderId: WORK_ORDER_ID, state: 'merged' }) as CloseWorkOrderResult;
      expect(result).toEqual({
        outcome: 'closed',
        workOrderId: WORK_ORDER_ID,
        state: 'merged',
        revision: 2,
      });
      // With no `nowIso` the clock value is stored, not the fixture's
      // `updatedAtIso` (which differs).
      const saved = h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!;
      expect(saved.state).toBe('merged');
      expect(saved.updatedAtIso).toBe(NOW);
    });
  });

  describe('refusals (each saves nothing)', () => {
    it('refuses merged with no merged run (runs all stopped)', async () => {
      const h = harness({
        runs: [runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID })],
        journalStates: new Map([[RUN_1, 'stopped']]),
      });
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'merged')).toEqual({
        outcome: 'refused',
        workOrderId: WORK_ORDER_ID,
        reason: 'no-merged-run',
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!.revision).toBe(1);
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses merged with no run at all (a hand-carried work order)', async () => {
      const h = harness({});
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'merged')).toMatchObject({ outcome: 'refused', reason: 'no-merged-run' });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses while a non-terminal run names the work order, with its id', async () => {
      const h = harness({
        runs: [runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID })],
        journalStates: new Map([[RUN_1, 'dispatching']]),
      });
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'stopped')).toEqual({
        outcome: 'refused',
        workOrderId: WORK_ORDER_ID,
        reason: 'run-not-terminal',
        runIds: [RUN_1],
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!.revision).toBe(1);
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses a running attempt with no run as attempt-not-ended', async () => {
      const h = harness({
        attempts: [attemptFixture({ id: 'attempt-running', state: 'running' })],
      });
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'stopped')).toEqual({
        outcome: 'refused',
        workOrderId: WORK_ORDER_ID,
        reason: 'attempt-not-ended',
        attemptIds: ['attempt-running'],
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses a blocked attempt as attempt-not-ended', async () => {
      const h = harness({
        attempts: [attemptFixture({ id: 'attempt-blocked', state: 'blocked' })],
      });
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'stopped')).toMatchObject({
        outcome: 'refused',
        reason: 'attempt-not-ended',
        attemptIds: ['attempt-blocked'],
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses a held reservation on an ended attempt as slot-held, for stopped', async () => {
      const h = harness({
        attempts: [attemptFixture({ state: 'ended' })],
        reservations: [reservation()],
      });
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'stopped')).toEqual({
        outcome: 'refused',
        workOrderId: WORK_ORDER_ID,
        reason: 'slot-held',
        attemptIds: ['attempt-example-1'],
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!.revision).toBe(1);
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses a held reservation on an ended attempt as slot-held, for merged too', async () => {
      const h = harness({
        runs: [runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID })],
        journalStates: new Map([[RUN_1, 'merged']]),
        attempts: [attemptFixture({ state: 'collected' })],
        reservations: [reservation()],
      });
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'merged')).toMatchObject({
        outcome: 'refused',
        reason: 'slot-held',
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses an already merged work order asked stopped', async () => {
      const h = harness({ workOrders: [makeWorkOrder({ state: 'merged' })] });
      let attemptCalls = 0;
      let reservationCalls = 0;
      const listAttempts = h.attemptRepo.listAttemptsByWorkOrder.bind(h.attemptRepo);
      h.attemptRepo.listAttemptsByWorkOrder = async (workOrderId) => {
        attemptCalls += 1;
        return listAttempts(workOrderId);
      };
      const listReservations = h.executionJournal.listActiveReservations.bind(h.executionJournal);
      h.executionJournal.listActiveReservations = async () => {
        reservationCalls += 1;
        return listReservations();
      };
      expect(await close(h, 'stopped')).toEqual({
        outcome: 'refused',
        workOrderId: WORK_ORDER_ID,
        reason: 'already-terminal',
      });
      // The early terminal check answers before any hold-facts read.
      expect(attemptCalls).toBe(0);
      expect(reservationCalls).toBe(0);
    });

    it('refuses an already stopped work order asked merged', async () => {
      const h = harness({ workOrders: [makeWorkOrder({ state: 'stopped' })] });
      let attemptCalls = 0;
      let reservationCalls = 0;
      const listAttempts = h.attemptRepo.listAttemptsByWorkOrder.bind(h.attemptRepo);
      h.attemptRepo.listAttemptsByWorkOrder = async (workOrderId) => {
        attemptCalls += 1;
        return listAttempts(workOrderId);
      };
      const listReservations = h.executionJournal.listActiveReservations.bind(h.executionJournal);
      h.executionJournal.listActiveReservations = async () => {
        reservationCalls += 1;
        return listReservations();
      };
      expect(await close(h, 'merged')).toEqual({
        outcome: 'refused',
        workOrderId: WORK_ORDER_ID,
        reason: 'already-terminal',
      });
      expect(attemptCalls).toBe(0);
      expect(reservationCalls).toBe(0);
    });

    it('answers not-found for an unknown id', async () => {
      const h = harness({ workOrders: [] });
      expect(await close(h, 'stopped')).toEqual({
        outcome: 'not-found',
        workOrderId: WORK_ORDER_ID,
      });
    });

    it('refuses a blank id as invalid-request', async () => {
      const h = harness({});
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'stopped', { workOrderId: '   ' })).toMatchObject({
        outcome: 'refused',
        reason: 'invalid-request',
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it('refuses a state outside the close states as invalid-request', async () => {
      const h = harness({});
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      expect(await close(h, 'ready-to-merge' as 'merged')).toMatchObject({
        outcome: 'refused',
        reason: 'invalid-request',
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });

    it.each([['a blank string', '   '], ['a non-date string', 'not-a-date'], ['a number', 42]])(
      'refuses a nowIso that is %s as invalid-request and saves nothing',
      async (_label, nowIso) => {
        const h = harness({});
        const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
        await expect(
          h.useCase.execute({ workOrderId: WORK_ORDER_ID, state: 'stopped', nowIso }),
        ).resolves.toMatchObject({ outcome: 'refused', reason: 'invalid-request' });
        expect(await h.workOrderRepo.findWorkOrderById(WORK_ORDER_ID)).toEqual(before);
      },
    );

    it('refuses a non-object execute input as invalid-request', async () => {
      const h = harness({});
      const before = structuredClone(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)!);
      await expect(h.useCase.execute('not-an-object')).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'invalid-request',
      });
      await expect(h.useCase.execute(null)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'invalid-request',
      });
      expect(h.workOrderRepo.workOrders.get(WORK_ORDER_ID)).toEqual(before);
    });
  });

  describe('save failures', () => {
    it('answers stale-revision when a concurrent writer bumps the revision first', async () => {
      const h = harness();
      const original = h.workOrderRepo.saveWorkOrder.bind(h.workOrderRepo);
      h.workOrderRepo.saveWorkOrder = async (record) => {
        // Simulate a concurrent writer bumping the stored revision just before
        // this save lands.
        const stored = h.workOrderRepo.workOrders.get(record.id);
        if (stored !== undefined) {
          h.workOrderRepo.workOrders.set(record.id, { ...stored, revision: stored.revision + 1 });
        }
        await original(record);
      };
      await expect(close(h, 'stopped')).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'stale-revision',
      });
    });

    it('answers stale-revision when the save deletes the record and throws', async () => {
      const h = harness();
      h.workOrderRepo.saveWorkOrder = async (record) => {
        // Simulate the write destroying the stored record before failing.
        h.workOrderRepo.workOrders.delete(record.id);
        throw new Error('disk on fire');
      };
      // The re-read finds nothing: the write failed, it was not a race.
      await expect(close(h, 'stopped')).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'stale-revision',
      });
    });

    it('rethrows the save error when the re-read shows the same revision', async () => {
      const h = harness();
      h.workOrderRepo.saveWorkOrder = async () => {
        throw new Error('disk on fire');
      };
      await expect(close(h, 'stopped')).rejects.toThrow('disk on fire');
    });
  });

  describe('end to end', () => {
    it('lets a new overlapping work order register after a close', async () => {
      const workOrderRepo = makeWorkOrderRepo([makeWorkOrder()]);
      const attemptRepo = makeAttemptRepo();
      const runRepo = makeRunRepo([runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID })]);
      const runJournal = makeRunJournal(new Map([[RUN_1, 'stopped']]));
      const executionJournal = makeExecutionJournal();
      const closeUseCase = new CloseWorkOrderUseCase({
        workOrderRepo,
        attemptRepo,
        runRepo,
        runJournal,
        executionJournal,
        now: () => NOW,
      });
      const closed = await closeUseCase.execute({
        workOrderId: WORK_ORDER_ID,
        state: 'stopped',
        nowIso: NOW,
      });
      expect(closed).toMatchObject({ outcome: 'closed' });

      const registerUseCase = new RegisterWorkOrderUseCase({ workOrderRepo });
      const registered = await registerUseCase.registerWorkOrder({
        workOrderId: OVERLAPPING_WORK_ORDER_ID,
        projectId: PROJECT_ID,
        taskId: 'task-example-2',
        laneId: 'lane-example',
        repository: 'repo-example',
        baseCommit: COMMIT,
        policyRevision: 'policy-example-1',
        ownedPaths: ['src/example.ts'],
        risk: 'standard',
      });
      expect(registered).toMatchObject({ outcome: 'registered' });
    });
  });
});

describe('workOrderHoldFacts', () => {
  it('sorts every list in code-unit order', async () => {
    // All ids satisfy `LANE_RUN_ID_PATTERN`; they are given in reverse order.
    const h = harness({
      runs: [
        runRecord({ runId: RUN_4, workOrderId: WORK_ORDER_ID }),
        runRecord({ runId: RUN_3, workOrderId: WORK_ORDER_ID }),
        runRecord({ runId: RUN_2, workOrderId: WORK_ORDER_ID }),
        runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID }),
      ],
      journalStates: new Map([
        [RUN_4, 'merged'],
        [RUN_3, 'merged'],
        [RUN_2, 'dispatching'],
        [RUN_1, 'ready'],
      ]),
      reservations: [
        reservation({ id: 'res-2', attemptId: 'attempt-b' }),
        reservation({ id: 'res-1', attemptId: 'attempt-a' }),
      ],
    });
    const facts = await workOrderHoldFacts(h, WORK_ORDER_ID, ['attempt-b', 'attempt-a'], null);
    expect(facts.heldAttemptIds).toEqual(['attempt-a', 'attempt-b']);
    expect(facts.nonTerminalRunIds).toEqual([RUN_1, RUN_2]);
    expect(facts.mergedRunIds).toEqual([RUN_3, RUN_4]);
  });

  it('excludes exceptRunId from all three lists', async () => {
    const h = harness({
      runs: [
        runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID, attemptIds: ['attempt-example-1'] }),
        runRecord({ runId: RUN_2, workOrderId: WORK_ORDER_ID }),
      ],
      journalStates: new Map([[RUN_1, 'merged'], [RUN_2, 'stopped']]),
      reservations: [reservation()],
    });
    const facts = await workOrderHoldFacts(h, WORK_ORDER_ID, ['attempt-example-1'], RUN_1);
    // `heldAttemptIds` follows the attempt list, not runs; only the run lists
    // drop `exceptRunId` — even when it is the merged one.
    expect(facts.heldAttemptIds).toEqual(['attempt-example-1']);
    expect(facts.nonTerminalRunIds).toEqual([]);
    expect(facts.mergedRunIds).toEqual([]);
    expect(facts.mergedRunIds).not.toContain(RUN_1);
  });

  it('lists a run whose journal state is merged in mergedRunIds', async () => {
    const h = harness({
      runs: [
        runRecord({ runId: RUN_1, workOrderId: WORK_ORDER_ID }),
        runRecord({ runId: RUN_2, workOrderId: WORK_ORDER_ID }),
      ],
      journalStates: new Map([[RUN_1, 'merged'], [RUN_2, 'stopped']]),
    });
    const facts = await workOrderHoldFacts(h, WORK_ORDER_ID, [], null);
    expect(facts.mergedRunIds).toEqual([RUN_1]);
    expect(facts.nonTerminalRunIds).toEqual([]);
  });
});
