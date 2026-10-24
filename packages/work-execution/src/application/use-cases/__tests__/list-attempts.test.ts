// ListAttemptsUseCase tests — L17a (GET /v1/attempts lists recorded attempts).
/**
 * Covers the read-only list route's use case: ordering (updatedAtIso
 * descending, id ascending), projectId filtering, work-order and held
 * reservation projection, limit normalisation/truncation, input validation,
 * the no-mutation/no-runner guarantee, and the unconfigured "Not implemented"
 * throw.
 */

import { describe, expect, it } from 'vitest';

import { ListAttemptsUseCase } from '../ListAttemptsUseCase.use-case.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';

const BASE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-a',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'acme/repo',
    baseCommit: BASE_COMMIT,
    ownedPaths: [],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-01T08:00:00.000Z',
    updatedAtIso: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/opencode/lanes/attempt-1',
    baseCommit: BASE_COMMIT,
    state: 'running',
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: null,
      variant: null,
    },
    createdAtIso: '2026-10-01T08:00:00.000Z',
    updatedAtIso: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function makeReservation(
  overrides: Partial<CapacityReservationRecord> = {},
): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'attempt-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    hostName: 'here',
    reservedAtIso: '2026-10-01T08:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

class RecordingAttemptRepository implements AttemptRepositoryPort {
  saveAttemptCalls = 0;
  listAttemptsByWorkOrderCalls = 0;
  listAllAttemptsCalls = 0;

  constructor(private readonly attempts: readonly AttemptRecord[]) {}

  async saveAttempt(): Promise<void> {
    this.saveAttemptCalls += 1;
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.attempts.find((attempt) => attempt.id === attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    this.listAttemptsByWorkOrderCalls += 1;
    return this.attempts.filter((attempt) => attempt.workOrderId === workOrderId);
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    this.listAllAttemptsCalls += 1;
    return this.attempts;
  }
}

class RecordingWorkOrderRepository implements WorkOrderRepositoryPort {
  saveWorkOrderCalls = 0;
  listWorkOrdersByProjectCalls = 0;
  lastListWorkOrdersByProjectArg: unknown = Symbol('unset');

  constructor(private readonly workOrders: readonly WorkOrderRecord[]) {}

  async saveWorkOrder(): Promise<void> {
    this.saveWorkOrderCalls += 1;
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.workOrders.find((workOrder) => workOrder.id === workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
    this.listWorkOrdersByProjectCalls += 1;
    this.lastListWorkOrdersByProjectArg = projectId;
    return this.workOrders;
  }
}

class RecordingExecutionJournal implements ExecutionJournalPort {
  appendJournalEntryCalls = 0;
  saveCapacityReservationCalls = 0;
  listActiveReservationsCalls = 0;
  lastListActiveReservationsArg: unknown = Symbol('unset');

  constructor(private readonly reservations: readonly CapacityReservationRecord[]) {}

  async appendJournalEntry(): Promise<void> {
    this.appendJournalEntryCalls += 1;
  }

  async listJournalEntriesForAttempt(_attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    return [];
  }

  async saveCapacityReservation(): Promise<void> {
    this.saveCapacityReservationCalls += 1;
  }

  async listActiveReservations(
    hostId?: string,
  ): Promise<readonly CapacityReservationRecord[]> {
    this.listActiveReservationsCalls += 1;
    this.lastListActiveReservationsArg = hostId;
    return this.reservations;
  }

  async releaseCapacityReservation(_attemptId: string, _releasedAtIso: string): Promise<boolean> {
    return false;
  }

  async reserveCapacityAtomically(
    _request: ReserveCapacityAtomicallyRequest,
  ): Promise<ReserveCapacityAtomicallyResult> {
    return { outcome: 'no-capacity' };
  }
}

function makeUseCase(options: {
  attempts?: readonly AttemptRecord[];
  workOrders?: readonly WorkOrderRecord[];
  reservations?: readonly CapacityReservationRecord[];
} = {}) {
  const attemptRepo = new RecordingAttemptRepository(options.attempts ?? []);
  const workOrderRepo = new RecordingWorkOrderRepository(options.workOrders ?? []);
  const journal = new RecordingExecutionJournal(options.reservations ?? []);
  const useCase = new ListAttemptsUseCase({
    attemptRepo,
    workOrderRepo,
    journal,
  });
  return { useCase, attemptRepo, workOrderRepo, journal };
}

describe('ListAttemptsUseCase', () => {
  it('lists attempts newest first, ties broken by id, with mapped work orders', async () => {
    const { useCase } = makeUseCase({
      workOrders: [
        makeWorkOrder(),
        makeWorkOrder({
          id: 'wo-2',
          projectId: 'proj-b',
          taskId: 'task-2',
          laneId: 'lane-2',
        }),
      ],
      attempts: [
        makeAttempt({
          id: 'att-1',
          workOrderId: 'wo-1',
          updatedAtIso: '2026-10-01T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-2',
          workOrderId: 'wo-1',
          updatedAtIso: '2026-10-03T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-3',
          workOrderId: 'wo-2',
          updatedAtIso: '2026-10-02T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-4',
          workOrderId: 'wo-2',
          updatedAtIso: '2026-10-03T00:00:00.000Z',
        }),
      ],
    });

    const result = await useCase.execute({});
    expect(result).toMatchObject({ outcome: 'listed', total: 4, truncated: false });
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    expect(result.attempts.map((row) => row.attempt.id)).toEqual([
      'att-2',
      'att-4',
      'att-3',
      'att-1',
    ]);
    expect(result.attempts[0]?.workOrder).toEqual({
      id: 'wo-1',
      projectId: 'proj-a',
      taskId: 'task-1',
      laneId: 'lane-1',
    });
    expect(result.attempts[2]?.workOrder).toEqual({
      id: 'wo-2',
      projectId: 'proj-b',
      taskId: 'task-2',
      laneId: 'lane-2',
    });
  });

  it('filters by projectId and drops attempts whose work order is missing when filtered', async () => {
    const { useCase } = makeUseCase({
      workOrders: [
        makeWorkOrder(),
        makeWorkOrder({
          id: 'wo-2',
          projectId: 'proj-b',
          taskId: 'task-2',
          laneId: 'lane-2',
        }),
      ],
      attempts: [
        makeAttempt({ id: 'att-1', workOrderId: 'wo-1' }),
        makeAttempt({ id: 'att-2', workOrderId: 'wo-2' }),
        makeAttempt({ id: 'att-missing', workOrderId: 'wo-absent' }),
      ],
    });

    const unfiltered = await useCase.execute({});
    if (unfiltered.outcome !== 'listed') {
      throw new Error(`expected listed, got ${unfiltered.outcome}`);
    }
    expect(unfiltered.total).toBe(3);
    const missing = unfiltered.attempts.find((row) => row.attempt.id === 'att-missing');
    expect(missing?.workOrder).toBeNull();

    const filtered = await useCase.execute({ projectId: 'proj-a' });
    if (filtered.outcome !== 'listed') {
      throw new Error(`expected listed, got ${filtered.outcome}`);
    }
    expect(filtered.attempts.map((row) => row.attempt.id)).toEqual(['att-1']);
    expect(filtered.total).toBe(1);
  });

  it('includes a held reservation and excludes a released one', async () => {
    const { useCase } = makeUseCase({
      attempts: [
        makeAttempt({ id: 'att-1' }),
        makeAttempt({ id: 'att-2' }),
      ],
      reservations: [
        makeReservation({
          id: 'res-held',
          attemptId: 'att-1',
          hostId: 'host-1',
          hostName: 'runner-host',
          slotIndex: 2,
        }),
        makeReservation({
          id: 'res-released',
          attemptId: 'att-2',
          hostId: 'host-2',
          slotIndex: 0,
          held: false,
        }),
      ],
    });

    const result = await useCase.execute({});
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    const heldRow = result.attempts.find((row) => row.attempt.id === 'att-1');
    expect(heldRow?.reservation).toEqual({
      hostId: 'host-1',
      hostName: 'runner-host',
      slotIndex: 2,
    });
    const releasedRow = result.attempts.find((row) => row.attempt.id === 'att-2');
    expect(releasedRow?.reservation).toBeNull();
  });

  it('truncates with limit and reports total and truncated', async () => {
    const { useCase } = makeUseCase({
      attempts: [
        makeAttempt({
          id: 'att-1',
          updatedAtIso: '2026-10-01T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-2',
          updatedAtIso: '2026-10-02T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-3',
          updatedAtIso: '2026-10-03T00:00:00.000Z',
        }),
      ],
    });

    const result = await useCase.listAttempts({ limit: 2 });
    expect(result).toMatchObject({
      outcome: 'listed',
      total: 3,
      truncated: true,
    });
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map((row) => row.attempt.id)).toEqual([
      'att-3',
      'att-2',
    ]);
  });

  it('execute accepts a decimal-digit string limit', async () => {
    const { useCase } = makeUseCase({
      attempts: [
        makeAttempt({
          id: 'att-1',
          updatedAtIso: '2026-10-01T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-2',
          updatedAtIso: '2026-10-02T00:00:00.000Z',
        }),
        makeAttempt({
          id: 'att-3',
          updatedAtIso: '2026-10-03T00:00:00.000Z',
        }),
      ],
    });

    const result = await useCase.execute({ limit: '2' });
    expect(result).toMatchObject({
      outcome: 'listed',
      total: 3,
      truncated: true,
    });
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    expect(result.attempts).toHaveLength(2);
  });

  it.each([
    [{ limit: '0' }, 'limit must be an integer from 1 to 500'],
    [{ limit: '501' }, 'limit must be an integer from 1 to 500'],
    [{ limit: '2.5' }, 'limit must be an integer from 1 to 500'],
    [{ limit: 'abc' }, 'limit must be an integer from 1 to 500'],
    [{ projectId: 7 }, 'projectId must be a string'],
  ])('execute rejects %j with %s', async (input, reason) => {
    const { useCase } = makeUseCase();
    await expect(useCase.execute(input as Record<string, unknown>)).resolves.toEqual({
      outcome: 'rejected',
      reason,
    });
  });

  it('execute rejects a non-object input', async () => {
    const { useCase } = makeUseCase();
    await expect(useCase.execute('x')).resolves.toEqual({
      outcome: 'rejected',
      reason: 'list request must be an object',
    });
  });

  it('reads only, exactly one call each to the three list methods, and never mutates', async () => {
    const { useCase, attemptRepo, workOrderRepo, journal } = makeUseCase({
      workOrders: [makeWorkOrder()],
      attempts: [makeAttempt()],
      reservations: [makeReservation()],
    });

    const result = await useCase.execute({});
    expect(result.outcome).toBe('listed');

    expect(attemptRepo.saveAttemptCalls).toBe(0);
    expect(journal.appendJournalEntryCalls).toBe(0);
    expect(journal.saveCapacityReservationCalls).toBe(0);
    expect(workOrderRepo.saveWorkOrderCalls).toBe(0);

    expect(attemptRepo.listAllAttemptsCalls).toBe(1);
    expect(workOrderRepo.listWorkOrdersByProjectCalls).toBe(1);
    expect(workOrderRepo.lastListWorkOrdersByProjectArg).toBeUndefined();
    expect(journal.listActiveReservationsCalls).toBe(1);
    expect(journal.lastListActiveReservationsArg).toBeUndefined();
  });

  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new ListAttemptsUseCase();
    await expect(useCase.execute({})).rejects.toThrow(/^Not implemented/);
  });
});
