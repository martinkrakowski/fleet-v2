/**
 * Unit tests for the migration step 2 work-execution use cases. Every
 * dependency is an in-memory fake; no filesystem, subprocess, network or
 * clock-dependent behaviour is exercised.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  CapacityReservationRecord,
  CommandCompletionReceipt,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { DispatchAttemptRequest } from '../../ports/in/DispatchAttemptPort.in-port.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { BriefAuthoringPort } from '../../ports/out/BriefAuthoringPort.out-port.js';
import type { BriefKnowledgePort } from '../../ports/out/BriefKnowledgePort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionObservationPort } from '../../ports/out/ExecutionObservationPort.out-port.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionStatus,
  StartRunnerSessionResult,
  StopRunnerSessionResult,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { CollectCompletedAttemptArtifactsResult } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort, WorktreeInspection } from '../../ports/out/WorkspacePort.out-port.js';
import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { InspectWorkOrderUseCase } from '../InspectWorkOrderUseCase.use-case.js';
import { CollectAttemptArtifactsUseCase } from '../CollectAttemptArtifactsUseCase.use-case.js';
import { PrepareFixAttemptUseCase } from '../PrepareFixAttemptUseCase.use-case.js';
import {
  PrepareBriefPackageUseCase,
  type PrepareBriefPackageUseCaseRequest,
} from '../PrepareBriefPackageUseCase.use-case.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import { ReconcileAttemptUseCase } from '../ReconcileAttemptUseCase.use-case.js';
import { ReserveExecutionCapacityUseCase } from '../ReserveExecutionCapacityUseCase.use-case.js';
import { StopAttemptUseCase } from '../StopAttemptUseCase.use-case.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';

function makeAttemptRepo(): AttemptRepositoryPort & { attempts: Map<string, AttemptRecord> } {
  const attempts = new Map<string, AttemptRecord>();
  return {
    attempts,
    async saveAttempt(record) {
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId) {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId) {
      return [...attempts.values()].filter((attempt) => attempt.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...attempts.values()];
    },
  };
}

function makeJournal(): ExecutionJournalPort & {
  entries: ActionJournalEntryRecord[];
  reservations: Map<string, CapacityReservationRecord>;
  heldFor(attemptId: string): boolean;
} {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  return {
    entries,
    reservations,
    heldFor(attemptId) {
      return [...reservations.values()].some((r) => r.attemptId === attemptId && r.held);
    },
    async appendJournalEntry(entry) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async saveCapacityReservation(reservation) {
      reservations.set(reservation.id, reservation);
    },
    async listActiveReservations(hostId) {
      return [...reservations.values()].filter(
        (reservation) => reservation.held && (hostId === undefined || reservation.hostId === hostId),
      );
    },
    async releaseCapacityReservation(attemptId, releasedAtIso) {
      for (const [id, reservation] of reservations) {
        if (reservation.attemptId === attemptId && reservation.held) {
          reservations.set(id, { ...reservation, held: false, releasedAtIso });
          return true;
        }
      }
      return false;
    },
    // Mirrors the adapter's locked arbitration: the busy-worktree verdict
    // (when the use case supplies one), duplicate, budget, then lowest free
    // slot, in one read-modify-write.
    async reserveCapacityAtomically(
      request: ReserveCapacityAtomicallyRequest,
    ): Promise<ReserveCapacityAtomicallyResult> {
      const held = [...reservations.values()].filter((reservation) => reservation.held);
      if (request.checkBusyWorktree !== undefined) {
        const verdict = await request.checkBusyWorktree(held);
        if (verdict.outcome === 'busy-worktree') {
          return { outcome: 'busy-worktree', blockingAttemptId: verdict.blockingAttemptId };
        }
      }
      const duplicate = held.find((reservation) => reservation.attemptId === request.attemptId);
      if (duplicate !== undefined) {
        return {
          outcome: 'duplicate-attempt',
          attemptId: request.attemptId,
          existingReservationId: duplicate.id,
        };
      }
      const heldOnHost = held.filter((reservation) => reservation.hostId === request.record.hostId);
      if (heldOnHost.length >= request.maxSlots) {
        return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots: request.maxSlots };
      }
      const usedSlots = new Set(heldOnHost.map((reservation) => reservation.slotIndex));
      let slotIndex = 0;
      while (usedSlots.has(slotIndex)) {
        slotIndex += 1;
      }
      const reservation: CapacityReservationRecord = { ...request.record, slotIndex };
      reservations.set(reservation.id, reservation);
      return { outcome: 'reserved', reservation };
    },
  };
}

function storedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    state: 'running',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function storedReservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'attempt-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    reservedAtIso: '2026-10-15T08:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

function makeWorkOrderRepo(): WorkOrderRepositoryPort & { orders: Map<string, WorkOrderRecord> } {
  const orders = new Map<string, WorkOrderRecord>();
  return {
    orders,
    async saveWorkOrder(record) {
      orders.set(record.id, record);
    },
    async findWorkOrderById(workOrderId) {
      return orders.get(workOrderId) ?? null;
    },
    async listWorkOrdersByProject(projectId) {
      return [...orders.values()].filter((order) => projectId === undefined || order.projectId === projectId);
    },
  };
}

function validWorkOrderRequest(overrides: Partial<Parameters<RegisterWorkOrderUseCase['registerWorkOrder']>[0]> = {}) {
  return {
    workOrderId: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/app-a/**'],
    policyRevision: 'policy-7',
    nowIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function storedWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-prior',
    projectId: 'proj-1',
    taskId: 'task-0',
    laneId: 'lane-prior',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/prior/**'],
    policyRevision: 'policy-7',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-14T08:00:00.000Z',
    updatedAtIso: '2026-10-14T08:00:00.000Z',
    ...overrides,
  };
}

describe('RegisterWorkOrderUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new RegisterWorkOrderUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: RegisterWorkOrderUseCase');
    await expect(useCase.execute(validWorkOrderRequest())).rejects.toThrow(
      'Not implemented: RegisterWorkOrderUseCase',
    );
    await expect(useCase.registerWorkOrder(validWorkOrderRequest())).rejects.toThrow(
      'Not implemented: RegisterWorkOrderUseCase',
    );
  });

  it('registers a valid work order as approved revision 1', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result.outcome).toBe('registered');
    if (result.outcome !== 'registered') {
      throw new Error('unreachable');
    }
    expect(result.workOrder).toEqual({
      id: 'wo-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'git@example.org:acme/app.git',
      baseCommit: 'abc123',
      ownedPaths: ['packages/app-a/**'],
      policyRevision: 'policy-7',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T08:00:00.000Z',
      updatedAtIso: '2026-10-15T08:00:00.000Z',
    });
    expect((await repo.findWorkOrderById('wo-1'))?.state).toBe('approved');
  });

  it('rejects a work order with missing required fields or no owned paths', async () => {
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: makeWorkOrderRepo() });

    const missingIds = await useCase.registerWorkOrder(validWorkOrderRequest({ workOrderId: '' }));
    expect(missingIds).toEqual({ outcome: 'rejected', reason: 'Missing required work order fields: workOrderId' });

    const noPaths = await useCase.registerWorkOrder(validWorkOrderRequest({ ownedPaths: [] }));
    expect(noPaths.outcome).toBe('rejected');
  });

  it('rejects a duplicate work order id in the same project', async () => {
    const repo = makeWorkOrderRepo();
    repo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', ownedPaths: ['packages/other/**'] }));
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Work order already registered: wo-1',
    });
  });

  it('rejects owned paths overlapping an active work order (exact and prefix)', async () => {
    const repo = makeWorkOrderRepo();
    repo.orders.set(
      'wo-prior',
      storedWorkOrder({ id: 'wo-prior', ownedPaths: ['packages/app-a'], state: 'implementing' }),
    );
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const exact = await useCase.registerWorkOrder(validWorkOrderRequest({ ownedPaths: ['packages/app-a'] }));
    expect(exact.outcome).toBe('rejected');

    const nested = await useCase.registerWorkOrder(
      validWorkOrderRequest({ ownedPaths: ['packages/app-a/src/deep'] }),
    );
    expect(nested.outcome).toBe('rejected');

    const covering = await useCase.registerWorkOrder(validWorkOrderRequest({ ownedPaths: ['packages'] }));
    expect(covering.outcome).toBe('rejected');
  });

  it('allows overlapping owned paths once the prior work order is merged or stopped', async () => {
    const repo = makeWorkOrderRepo();
    repo.orders.set('wo-merged', storedWorkOrder({ id: 'wo-merged', state: 'merged' }));
    repo.orders.set('wo-stopped', storedWorkOrder({ id: 'wo-stopped', ownedPaths: ['packages/app-b/**'], state: 'stopped' }));
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ ownedPaths: ['packages/app-a/**', 'packages/app-b/**'] }),
    );

    expect(result.outcome).toBe('registered');
  });

  it('rejects a missing prerequisite work order', async () => {
    const repo = makeWorkOrderRepo();
    repo.orders.set('wo-exists', storedWorkOrder({ id: 'wo-exists' }));
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({
        prerequisiteWorkOrderIds: ['wo-exists', 'wo-missing'],
      }),
    );

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Missing prerequisite work order: wo-missing',
    });
  });

  it('registers when all prerequisites exist', async () => {
    const repo = makeWorkOrderRepo();
    repo.orders.set('wo-exists', storedWorkOrder({ id: 'wo-exists' }));
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ prerequisiteWorkOrderIds: ['wo-exists'] }),
    );

    expect(result.outcome).toBe('registered');
    if (result.outcome === 'registered') {
      expect(result.workOrder.prerequisiteWorkOrderIds).toEqual(['wo-exists']);
    }
  });
});

describe('InspectWorkOrderUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new InspectWorkOrderUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: InspectWorkOrderUseCase');
    await expect(useCase.execute({ workOrderId: 'wo-1' })).rejects.toThrow(
      'Not implemented: InspectWorkOrderUseCase',
    );
    await expect(useCase.inspectWorkOrder({ workOrderId: 'wo-1' })).rejects.toThrow(
      'Not implemented: InspectWorkOrderUseCase',
    );
  });

  it('reports not-found for an unknown work order', async () => {
    const useCase = new InspectWorkOrderUseCase({
      workOrderRepo: makeWorkOrderRepo(),
      attemptRepo: makeAttemptRepo(),
      journal: makeJournal(),
    });

    const result = await useCase.inspectWorkOrder({ workOrderId: 'wo-missing' });

    expect(result).toEqual({ outcome: 'not-found', workOrderId: 'wo-missing' });
  });

  it('returns the work order, its attempts and only its active reservations', async () => {
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1' }));
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ id: 'attempt-1', workOrderId: 'wo-1', sessionId: 'session-1' }),
    );
    attemptRepo.attempts.set(
      'attempt-2',
      storedAttempt({ id: 'attempt-2', workOrderId: 'wo-1', state: 'ended', sessionId: 'session-2' }),
    );
    attemptRepo.attempts.set(
      'attempt-other',
      storedAttempt({ id: 'attempt-other', workOrderId: 'wo-other' }),
    );
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    journal.reservations.set('res-2', storedReservation({ id: 'res-2', attemptId: 'attempt-2', slotIndex: 1 }));
    journal.reservations.set(
      'res-released',
      storedReservation({ id: 'res-released', attemptId: 'attempt-1', held: false, releasedAtIso: '2026-10-15T09:00:00.000Z' }),
    );
    journal.reservations.set(
      'res-other',
      storedReservation({ id: 'res-other', attemptId: 'attempt-other', hostId: 'host-2' }),
    );
    const useCase = new InspectWorkOrderUseCase({ workOrderRepo, attemptRepo, journal });

    const result = await useCase.inspectWorkOrder({ workOrderId: 'wo-1' });

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') {
      throw new Error('unreachable');
    }
    expect(result.workOrder.id).toBe('wo-1');
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(['attempt-1', 'attempt-2']);
    expect(result.activeReservations.map((reservation) => reservation.id)).toEqual(['res-1', 'res-2']);
  });
});

function validReservationRequest(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: 'res-9',
    attemptId: 'attempt-9',
    workOrderId: 'wo-1',
    hostId: 'host-1',
    worktreePath: '/lanes/attempt-9',
    maxSlots: 2,
    nowIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

describe('ReserveExecutionCapacityUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new ReserveExecutionCapacityUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow(
      'Not implemented: ReserveExecutionCapacityUseCase',
    );
    await expect(useCase.execute(validReservationRequest())).rejects.toThrow(
      'Not implemented: ReserveExecutionCapacityUseCase',
    );
    await expect(
      useCase.reserveExecutionCapacity(validReservationRequest() as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0]),
    ).rejects.toThrow('Not implemented: ReserveExecutionCapacityUseCase');
  });

  it('refuses invalid reservations', async () => {
    const useCase = new ReserveExecutionCapacityUseCase({ journal: makeJournal(), attemptRepo: makeAttemptRepo() });

    const zeroSlots = await useCase.reserveExecutionCapacity(
      validReservationRequest({ maxSlots: 0 }) as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );
    expect(zeroSlots).toEqual({ outcome: 'refused', reason: 'maxSlots must be a positive number' });

    const missingFields = await useCase.reserveExecutionCapacity(
      validReservationRequest({ hostId: '', worktreePath: '' }) as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );
    expect(missingFields).toEqual({
      outcome: 'refused',
      reason: 'Missing required reservation fields: hostId, worktreePath',
    });
  });

  it('reserves the lowest free slot and persists the reservation', async () => {
    const journal = makeJournal();
    const attemptRepo = makeAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const first = await useCase.reserveExecutionCapacity(
      validReservationRequest() as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );
    const second = await useCase.reserveExecutionCapacity(
      validReservationRequest({
        reservationId: 'res-10',
        attemptId: 'attempt-10',
        worktreePath: '/lanes/attempt-10',
      }) as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );

    expect(first).toEqual({
      outcome: 'reserved',
      reservation: {
        id: 'res-9',
        attemptId: 'attempt-9',
        hostId: 'host-1',
        slotIndex: 0,
        held: true,
        reservedAtIso: '2026-10-15T08:00:00.000Z',
        releasedAtIso: null,
      },
    });
    expect(second.outcome).toBe('reserved');
    if (second.outcome === 'reserved') {
      expect(second.reservation.slotIndex).toBe(1);
    }
    expect(journal.heldFor('attempt-9')).toBe(true);
    expect(journal.heldFor('attempt-10')).toBe(true);
  });

  it('refuses a second reservation for the same attempt without superseding the first', async () => {
    const journal = makeJournal();
    const attemptRepo = makeAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const first = await useCase.reserveExecutionCapacity(
      validReservationRequest() as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );
    const duplicate = await useCase.reserveExecutionCapacity(
      validReservationRequest({ reservationId: 'res-duplicate' }) as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );

    expect(first.outcome).toBe('reserved');
    expect(duplicate).toEqual({
      outcome: 'refused',
      reason: 'Attempt attempt-9 already holds an active capacity reservation',
    });
    // The first claim survives; nothing was superseded or rewritten.
    expect([...journal.reservations.keys()]).toEqual(['res-9']);
    expect(journal.heldFor('attempt-9')).toBe(true);
  });

  it('reports busy-worktree when another active attempt holds the same worktree', async () => {
    const journal = makeJournal();
    journal.reservations.set('res-held', storedReservation({ id: 'res-held', attemptId: 'attempt-2' }));
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-2',
      storedAttempt({ id: 'attempt-2', workOrderId: 'wo-2', state: 'running', worktreePath: '/lanes/shared' }),
    );
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const result = await useCase.reserveExecutionCapacity(
      validReservationRequest({ worktreePath: '/lanes/shared' }) as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );

    expect(result).toEqual({ outcome: 'busy-worktree', blockingAttemptId: 'attempt-2' });
    expect(journal.heldFor('attempt-9')).toBe(false);
  });

  it('reports busy-worktree for an unreserved active attempt on the same worktree', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-3',
      storedAttempt({ id: 'attempt-3', workOrderId: 'wo-2', state: 'intent-recorded', worktreePath: '/lanes/shared' }),
    );
    const useCase = new ReserveExecutionCapacityUseCase({ journal: makeJournal(), attemptRepo });

    const result = await useCase.reserveExecutionCapacity(
      validReservationRequest({ worktreePath: '/lanes/shared' }) as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );

    expect(result).toEqual({ outcome: 'busy-worktree', blockingAttemptId: 'attempt-3' });
  });

  it('decides the busy-worktree check inside the journal lock, not before it (Opus note on #58)', async () => {
    // A real journal adapter wrapped with a lock marker: the marker is true
    // only while the adapter's locked read-modify-write is in flight.
    const inner = new ExecutionJournalAdapter();
    let lockActive = false;
    const journal: ExecutionJournalPort = {
      async appendJournalEntry(entry) {
        await inner.appendJournalEntry(entry);
      },
      async listJournalEntriesForAttempt(attemptId) {
        return inner.listJournalEntriesForAttempt(attemptId);
      },
      async saveCapacityReservation(reservation) {
        await inner.saveCapacityReservation(reservation);
      },
      async listActiveReservations(hostId) {
        return inner.listActiveReservations(hostId);
      },
      async releaseCapacityReservation(attemptId, releasedAtIso) {
        return inner.releaseCapacityReservation(attemptId, releasedAtIso);
      },
      async reserveCapacityAtomically(request) {
        lockActive = true;
        try {
          return await inner.reserveCapacityAtomically(request);
        } finally {
          lockActive = false;
        }
      },
    };
    // The conflicting claim registers only while the lock is held, as a
    // concurrent registration between the request and the append would.
    const conflicting = storedAttempt({
      id: 'attempt-2',
      workOrderId: 'wo-2',
      state: 'intent-recorded',
      worktreePath: '/lanes/attempt-9',
    });
    const baseRepo = makeAttemptRepo();
    const attemptRepo = {
      ...baseRepo,
      async listAllAttempts() {
        return lockActive ? [conflicting] : [];
      },
    } as AttemptRepositoryPort;
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const result = await useCase.reserveExecutionCapacity(
      validReservationRequest() as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );

    expect(result).toEqual({ outcome: 'busy-worktree', blockingAttemptId: 'attempt-2' });
    // Nothing was written: the busy verdict refused the claim under the lock.
    expect(await journal.listActiveReservations()).toHaveLength(0);
  });

  it('allows reusing a worktree whose attempt ended, and reports no-free-slot when the budget is exhausted', async () => {
    const journal = makeJournal();
    journal.reservations.set('res-a', storedReservation({ id: 'res-a', attemptId: 'attempt-a', slotIndex: 0 }));
    journal.reservations.set('res-b', storedReservation({ id: 'res-b', attemptId: 'attempt-b', slotIndex: 1 }));
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-ended',
      storedAttempt({ id: 'attempt-ended', workOrderId: 'wo-2', state: 'ended', worktreePath: '/lanes/attempt-9' }),
    );
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const noFreeSlot = await useCase.reserveExecutionCapacity(
      validReservationRequest({ maxSlots: 2 }) as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );
    expect(noFreeSlot).toEqual({ outcome: 'no-free-slot', heldCount: 2, maxSlots: 2 });

    const withFreeSlot = await useCase.reserveExecutionCapacity(
      validReservationRequest({ maxSlots: 3 }) as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );
    expect(withFreeSlot.outcome).toBe('reserved');
    if (withFreeSlot.outcome === 'reserved') {
      expect(withFreeSlot.reservation.slotIndex).toBe(2);
    }
  });
});

type AuthorBriefCall = Parameters<BriefAuthoringPort['authorBrief']>[0];
type VerifyIgnoredPathsCall = Parameters<AttemptArtifactPort['verifyIgnoredPaths']>[0];
type PlaceFrozenBriefCall = Parameters<AttemptArtifactPort['placeFrozenBrief']>[0];
type CollectArtifactsCall = Parameters<AttemptArtifactPort['collectCompletedAttemptArtifacts']>[0];
type RecordContextSelectionCall = Parameters<BriefKnowledgePort['recordContextSelection']>[0];

function makeBriefAuthoring(options: { proseMarkdown?: string; unavailableReason?: string } = {}) {
  const calls: AuthorBriefCall[] = [];
  const port: BriefAuthoringPort = {
    async authorBrief(request) {
      calls.push(request);
      if (options.unavailableReason) {
        return { outcome: 'unavailable', reason: options.unavailableReason };
      }
      return {
        outcome: 'authored',
        brief: {
          proseMarkdown: options.proseMarkdown ?? '# Frozen brief prose',
          provenance: 'orchestrator',
        },
      };
    },
  };
  return { port, calls };
}

function makeArtifactPort(
  options: {
    offendingPaths?: readonly string[];
    placeRefusedReason?: string;
    prosePath?: string;
    manifestPath?: string;
    collectResult?: CollectCompletedAttemptArtifactsResult;
  } = {},
) {
  const verifiedCalls: VerifyIgnoredPathsCall[] = [];
  const placedCalls: PlaceFrozenBriefCall[] = [];
  const collectCalls: CollectArtifactsCall[] = [];
  const port: AttemptArtifactPort = {
    async verifyIgnoredPaths(request) {
      verifiedCalls.push(request);
      const offendingPaths = request.candidatePaths.filter((path) => options.offendingPaths?.includes(path));
      if (offendingPaths.length > 0) {
        return { outcome: 'not-ignored', offendingPaths };
      }
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief(request) {
      placedCalls.push(request);
      if (options.placeRefusedReason) {
        return { outcome: 'refused', reason: options.placeRefusedReason };
      }
      return {
        outcome: 'placed',
        prosePath: options.prosePath ?? '.lane/brief.md',
        manifestPath: options.manifestPath ?? '.lane/brief-manifest.json',
      };
    },
    async collectCompletedAttemptArtifacts(request) {
      collectCalls.push(request);
      if (options.collectResult) {
        return options.collectResult;
      }
      return {
        outcome: 'collected',
        artifacts: {
          headCommit: 'head456',
          commitsSinceBase: ['commit-1'],
          collectedArtifactPaths: ['dist/report.json'],
          notes: 'present',
        },
      };
    },
  };
  return { port, verifiedCalls, placedCalls, collectCalls };
}

function makeBriefKnowledge() {
  const selectionCalls: RecordContextSelectionCall[] = [];
  const port: BriefKnowledgePort = {
    async requestBriefContextProposals() {
      throw new Error('requestBriefContextProposals is not expected in these tests');
    },
    async recordContextSelection(request) {
      selectionCalls.push(request);
      return { outcome: 'recorded' };
    },
    async forwardCompletedAttemptNotes() {
      throw new Error('forwardCompletedAttemptNotes is not expected in these tests');
    },
  };
  return { port, selectionCalls };
}

function validBriefRequest(overrides: Record<string, unknown> = {}): PrepareBriefPackageUseCaseRequest {
  const base: PrepareBriefPackageUseCaseRequest = {
    workOrderId: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    policyRevision: 'policy-7',
    modelAssignment: { model: 'implementer-model', variant: 'default', fallbackModel: 'fallback-model' },
    independentReviewer: 'reviewer-model',
    ownedPaths: ['packages/app-a/**'],
    permissions: ['filesystem:worktree'],
    acceptanceChecks: ['yarn test'],
    stepLimit: 40,
    timeLimitSeconds: 3600,
    resourceBounds: { cpu: '2' },
    expectedArtifacts: ['dist/report.json'],
    ownerDecisionReferences: ['decision-1'],
    contextDecisions: [
      {
        proposalId: 'p-1',
        knowledgeEntryId: 'ke-1',
        version: 'v1',
        proposedBecause: 'lexical match',
        accepted: true,
        decisionBecause: 'applicable to this lane',
      },
      {
        proposalId: 'p-2',
        knowledgeEntryId: 'ke-2',
        version: 'v2',
        proposedBecause: 'lexical match',
        accepted: false,
        decisionBecause: 'out of scope for this lane',
      },
    ],
  };
  return { ...base, ...overrides } as PrepareBriefPackageUseCaseRequest;
}

describe('PrepareBriefPackageUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new PrepareBriefPackageUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: PrepareBriefPackageUseCase');
    await expect(useCase.execute(validBriefRequest())).rejects.toThrow(
      'Not implemented: PrepareBriefPackageUseCase',
    );
    await expect(useCase.prepareBriefPackage(validBriefRequest())).rejects.toThrow(
      'Not implemented: PrepareBriefPackageUseCase',
    );
  });

  it('rejects a brief whose independent reviewer equals the implementer model', async () => {
    const authoring = makeBriefAuthoring();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: authoring.port,
      artifactPort: makeArtifactPort().port,
    });

    const result = await useCase.prepareBriefPackage(
      validBriefRequest({ independentReviewer: 'implementer-model' }),
    );

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Independent reviewer model must differ from the implementer model',
    });
    expect(authoring.calls).toHaveLength(0);
  });

  it('rejects a brief with an invalid request shape', async () => {
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring().port,
      artifactPort: makeArtifactPort().port,
    });

    const emptyDecision = await useCase.prepareBriefPackage(
      validBriefRequest({
        contextDecisions: [
          {
            proposalId: 'p-1',
            knowledgeEntryId: 'ke-1',
            version: 'v1',
            proposedBecause: 'lexical match',
            accepted: true,
            decisionBecause: '',
          },
        ],
      }),
    );
    expect(emptyDecision).toEqual({
      outcome: 'rejected',
      reason: 'Every context decision must record decisionBecause',
    });

    const noPaths = await useCase.prepareBriefPackage(validBriefRequest({ ownedPaths: [] }));
    expect(noPaths).toEqual({ outcome: 'rejected', reason: 'Brief must own at least one path' });

    const badLimits = await useCase.prepareBriefPackage(validBriefRequest({ stepLimit: 0 }));
    expect(badLimits).toEqual({
      outcome: 'rejected',
      reason: 'stepLimit and timeLimitSeconds must be positive',
    });
  });

  it('rejects when the authoring port cannot produce a brief', async () => {
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring({ unavailableReason: 'orchestrator offline' }).port,
      artifactPort: makeArtifactPort().port,
    });

    const result = await useCase.prepareBriefPackage(validBriefRequest());

    expect(result).toEqual({ outcome: 'rejected', reason: 'orchestrator offline' });
  });

  it('rejects when brief package paths are not gitignored', async () => {
    const artifacts = makeArtifactPort({ offendingPaths: ['dist/report.json'] });
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring().port,
      artifactPort: artifacts.port,
    });

    const result = await useCase.prepareBriefPackage(validBriefRequest());

    expect(result).toEqual({ outcome: 'rejected', reason: 'Paths not ignored: dist/report.json' });
    expect(artifacts.placedCalls).toHaveLength(0);
    expect(artifacts.verifiedCalls[0].candidatePaths).toEqual([
      '.lane/brief.md',
      '.lane/brief-manifest.json',
      'dist/report.json',
    ]);
  });

  it('freezes the brief, records selections and computes a deterministic digest', async () => {
    const authoring = makeBriefAuthoring({ proseMarkdown: '# Prose A' });
    const artifacts = makeArtifactPort();
    const knowledge = makeBriefKnowledge();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: authoring.port,
      artifactPort: artifacts.port,
      briefKnowledge: knowledge.port,
    });

    const first = await useCase.prepareBriefPackage(
      validBriefRequest({ attemptId: 'attempt-1', worktreePath: '/lanes/attempt-1' }),
    );
    const second = await useCase.prepareBriefPackage(
      validBriefRequest({ attemptId: 'attempt-1', worktreePath: '/lanes/attempt-1' }),
    );
    const changedProse = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring({ proseMarkdown: '# Prose B' }).port,
      artifactPort: makeArtifactPort().port,
    });
    const third = await changedProse.prepareBriefPackage(
      validBriefRequest({ attemptId: 'attempt-1', worktreePath: '/lanes/attempt-1' }),
    );

    expect(first.outcome).toBe('prepared');
    if (first.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect(first.prepared.attemptId).toBe('attempt-1');
    expect(first.prepared.prosePath).toBe('.lane/brief.md');
    expect(first.prepared.manifestPath).toBe('.lane/brief-manifest.json');
    expect(first.prepared.selectedKnowledgeVersions).toEqual([
      { knowledgeEntryId: 'ke-1', version: 'v1' },
    ]);
    expect(first.prepared.briefDigest).toMatch(/^[0-9a-f]{64}$/);

    if (second.outcome !== 'prepared' || third.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect(second.prepared.briefDigest).toBe(first.prepared.briefDigest);
    expect(third.prepared.briefDigest).not.toBe(first.prepared.briefDigest);

    const manifest = JSON.parse(artifacts.placedCalls[0].manifestJson) as Record<string, unknown>;
    expect(manifest.attemptId).toBe('attempt-1');
    expect(manifest.workOrderId).toBe('wo-1');
    expect(manifest.baseCommit).toBe('abc123');
    expect(manifest.modelAssignment).toEqual({
      model: 'implementer-model',
      variant: 'default',
      fallbackModel: 'fallback-model',
    });
    expect(manifest.independentReviewer).toBe('reviewer-model');
    expect(manifest.stepLimit).toBe(40);
    expect(manifest.selectedKnowledgeVersions).toEqual([{ knowledgeEntryId: 'ke-1', version: 'v1' }]);

    const expectedSelection = {
      attemptId: 'attempt-1',
      selections: [
        {
          proposalId: 'p-1',
          knowledgeEntryId: 'ke-1',
          version: 'v1',
          accepted: true,
          decisionBecause: 'applicable to this lane',
        },
        {
          proposalId: 'p-2',
          knowledgeEntryId: 'ke-2',
          version: 'v2',
          accepted: false,
          decisionBecause: 'out of scope for this lane',
        },
      ],
    };
    expect(knowledge.selectionCalls).toEqual([expectedSelection, expectedSelection]);
  });

  it('uses injected digest, attempt, worktree and hand-written brief defaults', async () => {
    const authoring = makeBriefAuthoring();
    const artifacts = makeArtifactPort();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: authoring.port,
      artifactPort: artifacts.port,
      computeDigest: (content: string) => `sha-digest:${content.length}`,
      attemptId: 'attempt-from-deps',
      worktreePath: '/lanes/from-deps',
      handWrittenBriefPath: '/briefs/hand-written.md',
    });

    const result = await useCase.prepareBriefPackage(validBriefRequest());

    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect(result.prepared.attemptId).toBe('attempt-from-deps');
    expect(result.prepared.briefDigest).toMatch(/^sha-digest:\d+$/);
    expect(authoring.calls).toEqual([
      {
        workOrderId: 'wo-1',
        laneId: 'lane-1',
        handWrittenBriefPath: '/briefs/hand-written.md',
      },
    ]);
    expect(artifacts.verifiedCalls[0].worktreePath).toBe('/lanes/from-deps');
    expect(artifacts.placedCalls[0].worktreePath).toBe('/lanes/from-deps');
  });
});

type StartSessionCall = Parameters<ExecutionRunnerPort['startSession']>[0];
type InspectSessionCall = Parameters<ExecutionRunnerPort['inspectSession']>[0];
type StopSessionCall = Parameters<ExecutionRunnerPort['stopSession']>[0];
type InspectWorktreeCall = Parameters<WorkspacePort['inspectWorktree']>[0];
type PublishObservationCall = Parameters<ExecutionObservationPort['publishExecutionObservation']>[0];

function makeRunner(
  options: {
    capabilities?: Partial<RunnerIsolationCapabilities>;
    startResult?: StartRunnerSessionResult;
    inspectStatus?: RunnerSessionStatus;
    stopResult?: StopRunnerSessionResult;
    describeRunner?: () => AttemptRunnerRecord | undefined;
    onStart?: () => void;
  } = {},
) {
  const capabilities: RunnerIsolationCapabilities = {
    filesystemScope: 'scoped-worktree',
    networkEgressRestricted: true,
    cpuAndMemoryLimited: true,
    processTreeTermination: true,
    authoritativeCompletion: true,
    artifactPersistence: true,
    ...options.capabilities,
  };
  const startCalls: StartSessionCall[] = [];
  const inspectCalls: InspectSessionCall[] = [];
  const stopCalls: StopSessionCall[] = [];
  const port: ExecutionRunnerPort = {
    describeCapabilities: () => capabilities,
    describeRunner:
      options.describeRunner !== undefined
        ? options.describeRunner
        : () => ({
            kind: 'opencode',
            remotePort: 4166,
            host: null,
            agent: null,
            model: 'nvidia/z-ai/glm-5.3',
            variant: 'default',
          }),
    async startSession(request) {
      startCalls.push(request);
      options.onStart?.();
      return options.startResult ?? { outcome: 'started', sessionId: 'session-1' };
    },
    async inspectSession(session) {
      inspectCalls.push(session);
      return (
        options.inspectStatus ?? {
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'active',
          completionReceipt: null,
          artifactsCollected: false,
        }
      );
    },
    async stopSession(request) {
      stopCalls.push(request);
      return options.stopResult ?? { outcome: 'still-running', reason: 'grace period elapsed' };
    },
  };
  return { port, capabilities, startCalls, inspectCalls, stopCalls };
}

function makeWorkspace(
  options: {
    inspection?: Partial<WorktreeInspection>;
    readWorktreeFile?: (worktreePath: string, relativePath: string) => Promise<string | null>;
  } = {},
) {
  const calls: InspectWorktreeCall[] = [];
  const port: WorkspacePort = {
    async inspectWorktree(request) {
      calls.push(request);
      return {
        worktreePath: request.worktreePath,
        checkedOutCommit: request.baseCommit,
        matchesBaseCommit: true,
        uncommittedPaths: [],
        untrackedPaths: [],
        residueFromEarlierAttempts: [],
        missingExpectedArtifacts: [],
        ...options.inspection,
      };
    },
    readWorktreeFile:
      options.readWorktreeFile ??
      (async () =>
        JSON.stringify({
          modelAssignment: {
            model: 'nvidia/z-ai/glm-5.3',
            agent: 'lane-agent',
            variant: 'default',
          },
          independentReviewer: 'reviewer-model',
        })),
  };
  return { port, calls };
}

function makeObservation() {
  const calls: PublishObservationCall[] = [];
  const port: ExecutionObservationPort = {
    async publishExecutionObservation(request) {
      calls.push(request);
      return { outcome: 'published' };
    },
  };
  return { port, calls };
}

function validDispatchRequest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/lanes/attempt-1',
    briefPackagePath: '.lane/brief.md',
    briefDigest: 'digest-1',
    baseCommit: 'abc123',
    stepLimit: 40,
    timeLimitSeconds: 3600,
    expectedArtifacts: ['dist/report.json'],
    nowIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function makeDispatchSetup(
  options: {
    workOrderState?: WorkOrderRecord['state'];
    withReservation?: boolean;
    runnerOptions?: Parameters<typeof makeRunner>[0];
    workspaceInspection?: Partial<WorktreeInspection>;
    workspaceOptions?: Parameters<typeof makeWorkspace>[0];
  } = {},
) {
  const workOrderRepo = makeWorkOrderRepo();
  workOrderRepo.orders.set(
    'wo-1',
    storedWorkOrder({ id: 'wo-1', state: options.workOrderState ?? 'implementing' }),
  );
  const attemptRepo = makeAttemptRepo();
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const runner = makeRunner(options.runnerOptions);
  const workspace = makeWorkspace({ inspection: options.workspaceInspection, ...options.workspaceOptions });
  const observation = makeObservation();
  const useCase = new DispatchAttemptUseCase({
    workOrderRepo,
    attemptRepo,
    journal,
    workspace: workspace.port,
    runner: runner.port,
    observation: observation.port,
  });
  return { workOrderRepo, attemptRepo, journal, runner, workspace, observation, useCase };
}

describe('DispatchAttemptUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new DispatchAttemptUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: DispatchAttemptUseCase');
    await expect(useCase.execute(validDispatchRequest())).rejects.toThrow(
      'Not implemented: DispatchAttemptUseCase',
    );
    await expect(
      useCase.dispatchAttempt(validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0]),
    ).rejects.toThrow('Not implemented: DispatchAttemptUseCase');
  });

  it('refuses dispatch for a missing or terminal work order', async () => {
    const missing = makeDispatchSetup();
    missing.workOrderRepo.orders.delete('wo-1');
    const missingResult = await missing.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(missingResult).toEqual({ outcome: 'refused', reason: 'Work order not found: wo-1' });

    const merged = makeDispatchSetup({ workOrderState: 'merged' });
    const mergedResult = await merged.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(mergedResult).toEqual({
      outcome: 'refused',
      reason: 'Work order wo-1 is merged and accepts no further dispatch',
    });

    const stopped = makeDispatchSetup({ workOrderState: 'stopped' });
    const stoppedResult = await stopped.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(stoppedResult).toEqual({
      outcome: 'refused',
      reason: 'Work order wo-1 is stopped and accepts no further dispatch',
    });
  });

  it('refuses dispatch without an active capacity reservation', async () => {
    const setup = makeDispatchSetup({ withReservation: false });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'No active capacity reservation for attempt' });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
  });

  it('refuses dispatch when runner capabilities do not satisfy required isolation', async () => {
    const scopedRunner = makeDispatchSetup({
      runnerOptions: { capabilities: { filesystemScope: 'inherited-directory' } },
    });
    const scopedResult = await scopedRunner.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(scopedResult).toEqual({
      outcome: 'refused',
      reason: 'Runner capabilities do not satisfy required isolation',
    });

    const noTermination = makeDispatchSetup({
      runnerOptions: { capabilities: { processTreeTermination: false } },
    });
    const noTerminationResult = await noTermination.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(noTerminationResult).toEqual({
      outcome: 'refused',
      reason: 'Runner capabilities do not satisfy required isolation',
    });
    expect(noTermination.runner.startCalls).toHaveLength(0);
  });

  it('refuses dispatch for an undeclared runner whose filesystem scope is unknown (D4)', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        capabilities: {
          source: 'undeclared',
          filesystemScope: 'unknown',
          networkEgressRestricted: false,
          cpuAndMemoryLimited: false,
          processTreeTermination: false,
        },
      },
    });

    const request = validDispatchRequest();
    const result = await setup.useCase.dispatchAttempt(
      request as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    // The unwaivable capability check refuses the unknown scope; no flag or
    // request field can waive it.
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Runner capabilities do not satisfy required isolation',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
  });

  it('dispatches a declared container profile and sends the brief requirements to the runner', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        capabilities: {
          source: 'declared',
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
        },
      },
    });

    const request = validDispatchRequest();
    const result = await setup.useCase.dispatchAttempt(
      request as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    expect(setup.runner.startCalls).toHaveLength(1);
    // The runner start still receives the brief's requirements, never an
    // operator override.
    expect(setup.runner.startCalls[0].requiredCapabilities).toEqual({
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    });
  });

  it('applies the brief requirements when the request carries none', async () => {
    // A runner that reports today's booleans but a relaxed egress stance is
    // refused by the brief profile, even with no request capabilities.
    const setup = makeDispatchSetup({
      runnerOptions: { capabilities: { networkEgressRestricted: false } },
    });

    const request = validDispatchRequest();
    const result = await setup.useCase.dispatchAttempt(
      request as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Runner capabilities do not satisfy required isolation',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
  });

  it('refuses dispatch for a dirty or mismatched worktree', async () => {
    const mismatch = makeDispatchSetup({
      workspaceInspection: { matchesBaseCommit: false, checkedOutCommit: 'def999' },
    });
    const mismatchResult = await mismatch.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(mismatchResult.outcome).toBe('refused');
    if (mismatchResult.outcome === 'refused') {
      expect(mismatchResult.reason).toContain('does not match the base commit');
    }

    const dirty = makeDispatchSetup({
      workspaceInspection: { uncommittedPaths: ['src/dirty.ts'], untrackedPaths: ['tmp.log'], residueFromEarlierAttempts: ['.lane/old.md'] },
    });
    const dirtyResult = await dirty.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(dirtyResult.outcome).toBe('refused');
    if (dirtyResult.outcome === 'refused') {
      expect(dirtyResult.reason).toContain('uncommitted changes: src/dirty.ts');
    }
    expect(dirty.runner.startCalls).toHaveLength(0);
    expect(dirty.journal.entries).toHaveLength(0);
  });

  it('records the frozen brief manifest owner decision references on the attempt', async () => {
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async () =>
          JSON.stringify({
            modelAssignment: {
              model: 'nvidia/z-ai/glm-5.3',
              agent: 'lane-agent',
              variant: 'default',
            },
            independentReviewer: 'reviewer-model',
            ownerDecisionReferences: ['door-1', 'door-2'],
          }),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') {
      throw new Error('unreachable');
    }
    expect(result.attempt.ownerDecisionReferences).toEqual(['door-1', 'door-2']);
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect(stored?.ownerDecisionReferences).toEqual(['door-1', 'door-2']);
  });

  it('records an empty door list when the frozen manifest names none', async () => {
    const setup = makeDispatchSetup();

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') {
      throw new Error('unreachable');
    }
    expect(result.attempt.ownerDecisionReferences).toEqual([]);
  });

  it('refuses dispatch when the frozen manifest records malformed owner decision references', async () => {
    const malformed: readonly unknown[] = ['not-an-array', [42], [''], [{}]];
    for (const recorded of malformed) {
      const setup = makeDispatchSetup({
        workspaceOptions: {
          readWorktreeFile: async () =>
            JSON.stringify({
              modelAssignment: { model: 'nvidia/z-ai/glm-5.3', agent: 'lane-agent', variant: 'default' },
              independentReviewer: 'reviewer-model',
              ownerDecisionReferences: recorded,
            }),
        },
      });

      const result = await setup.useCase.dispatchAttempt(
        validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
      );

      expect(result).toEqual({
        outcome: 'refused',
        reason:
          "Frozen brief manifest 'ownerDecisionReferences' must be an array of non-empty strings when present",
      });
      expect(setup.runner.startCalls).toHaveLength(0);
      expect(setup.journal.entries).toHaveLength(0);
      expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
    }
  });

  it('records durable intent before start and transitions to running on started', async () => {
    const journalEntryCountsAtStart: number[] = [];
    const setup = makeDispatchSetup({
      runnerOptions: { onStart: () => journalEntryCountsAtStart.push(setupLater.journal.entries.length) },
    });
    const setupLater = setup;

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') {
      throw new Error('unreachable');
    }
    expect(result.sessionId).toBe('session-1');
    expect(result.attempt.state).toBe('running');
    expect(result.attempt.sessionId).toBe('session-1');
    expect(journalEntryCountsAtStart).toEqual([1]);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[0]).toMatchObject({
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      status: 'intent-recorded',
      sessionId: null,
    });
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'dispatch',
      status: 'completed',
      sessionId: 'session-1',
    });
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.observation.calls).toHaveLength(1);
    expect(setup.observation.calls[0].projectId).toBe('proj-1');
    expect(setup.observation.calls[0].entry.status).toBe('completed');
    expect(setup.runner.startCalls[0]).toMatchObject({
      attemptId: 'attempt-1',
      worktreePath: '/lanes/attempt-1',
      briefPackagePath: '.lane/brief.md',
      baseCommit: 'abc123',
      stepLimit: 40,
      timeLimitSeconds: 3600,
    });
  });

  it('transitions to reconciling and keeps capacity on an unknown start', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: { startResult: { outcome: 'unknown', reason: 'start result lost' } },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toMatchObject({ outcome: 'unknown', reason: 'start result lost' });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('reconciling');
    expect(result.attempt.sessionId).toBeNull();
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[1]).toMatchObject({ action: 'dispatch', status: 'ambiguous' });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('reconciling');
  });

  it('cancels the attempt and releases capacity when the runner refuses the start', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: { startResult: { outcome: 'refused', reason: 'runner rejected isolation profile' } },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'runner rejected isolation profile' });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[1]).toMatchObject({ action: 'dispatch', status: 'refused' });
  });

  it('reuses an existing attempt identity when dispatching a prepared fix attempt', async () => {
    const setup = makeDispatchSetup();
    setup.attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ id: 'attempt-1', kind: 'fix', fixNumber: 1, priorAttemptId: 'attempt-0', state: 'intent-recorded' }),
    );

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') {
      throw new Error('unreachable');
    }
    expect(result.attempt.kind).toBe('fix');
    expect(result.attempt.fixNumber).toBe(1);
    expect(result.attempt.priorAttemptId).toBe('attempt-0');
    expect(result.attempt.state).toBe('running');
  });

  it('refuses dispatch when request carries model, agent, variant, modelAssignment, runnerPort, remotePort, runnerHost, or host', async () => {
    const setup = makeDispatchSetup();

    const withModel = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ model: 'gpt-5' }) as unknown as DispatchAttemptRequest,
    );
    expect(withModel).toEqual({
      outcome: 'refused',
      reason: "'model' must not be specified; the seat is determined by the frozen brief manifest",
    });

    const withAgent = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ agent: 'my-agent' }) as unknown as DispatchAttemptRequest,
    );
    expect(withAgent).toEqual({
      outcome: 'refused',
      reason: "'agent' must not be specified; the seat is determined by the frozen brief manifest",
    });

    const withModelAssignment = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ modelAssignment: { model: 'gpt-5' } }) as unknown as DispatchAttemptRequest,
    );
    expect(withModelAssignment).toEqual({
      outcome: 'refused',
      reason: "'modelAssignment' must not be specified; the seat is determined by the frozen brief manifest",
    });

    for (const field of ['runnerPort', 'remotePort', 'runnerHost', 'host'] as const) {
      const result = await setup.useCase.dispatchAttempt(
        validDispatchRequest({ [field]: 'forbidden-val' }) as unknown as DispatchAttemptRequest,
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: `'${field}' must not be specified; the seat is determined by the frozen brief manifest`,
      });
    }
  });

  it('refuses dispatch when no runner port can be described', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: { describeRunner: () => undefined },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as unknown as DispatchAttemptRequest,
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'No runner port can be described for dispatch',
    });
  });

  it('refuses dispatch when frozen brief manifest cannot be read through port', async () => {
    const setup = makeDispatchSetup({
      workspaceOptions: { readWorktreeFile: async () => null },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as unknown as DispatchAttemptRequest,
    );
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('Unable to read frozen brief manifest');
  });
});

function completionReceipt(overrides: Partial<CommandCompletionReceipt> = {}): CommandCompletionReceipt {
  return {
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    endedAtIso: '2026-10-15T09:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
    ...overrides,
  };
}

function makeReconcileSetup(
  options: {
    attempt?: Partial<AttemptRecord>;
    inspectStatus?: RunnerSessionStatus;
    withReservation?: boolean;
  } = {},
) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'reconciling', ...options.attempt }));
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const runner = makeRunner({ inspectStatus: options.inspectStatus });
  const useCase = new ReconcileAttemptUseCase({ attemptRepo, journal, runner: runner.port });
  return { attemptRepo, journal, runner, useCase };
}

describe('ReconcileAttemptUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new ReconcileAttemptUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: ReconcileAttemptUseCase');
    await expect(useCase.execute({ attemptId: 'attempt-1' })).rejects.toThrow(
      'Not implemented: ReconcileAttemptUseCase',
    );
    await expect(useCase.reconcileAttempt({ attemptId: 'attempt-1' })).rejects.toThrow(
      'Not implemented: ReconcileAttemptUseCase',
    );
  });

  it('reports not-found for an unknown attempt', async () => {
    const setup = makeReconcileSetup();
    setup.attemptRepo.attempts.delete('attempt-1');

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({ outcome: 'not-found', attemptId: 'attempt-1' });
  });

  it('delegates execute to reconcileAttempt for object input', async () => {
    const setup = makeReconcileSetup({
      inspectStatus: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: false,
      },
    });

    const result = await setup.useCase.execute({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('active');
  });

  it('stays unknown without a recorded sessionId and keeps the reservation', async () => {
    const setup = makeReconcileSetup({ attempt: { sessionId: null } });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'No sessionId recorded for attempt',
    });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('reconciling');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(1);
    expect(setup.journal.entries[0]).toMatchObject({ action: 'reconcile', status: 'ambiguous' });
    expect(setup.runner.inspectCalls).toHaveLength(0);
  });

  it('stays unknown while the runner is unreachable and keeps the reservation', async () => {
    const setup = makeReconcileSetup({
      inspectStatus: {
        runnerReachable: 'unreachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: completionReceipt(),
        artifactsCollected: false,
      },
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'Runner reachability is unreachable',
    });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('reconciling');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[0]).toMatchObject({ action: 'reconcile', status: 'ambiguous' });
  });

  it('ends the attempt and releases capacity only on a matching authoritative receipt', async () => {
    const receipt = completionReceipt();
    const setup = makeReconcileSetup({
      inspectStatus: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: receipt,
        artifactsCollected: false,
      },
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({ outcome: 'ended', attempt: expect.anything(), receipt });
    if (result.outcome !== 'ended') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('ended');
    expect(result.attempt.completionReceipt).toEqual(receipt);
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.journal.entries[0]).toMatchObject({ action: 'reconcile', status: 'completed' });
  });

  it('reports active for a running session and keeps the reservation', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'reconciling' },
      inspectStatus: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: false,
      },
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('active');
    if (result.outcome !== 'active') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('running');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[0]).toMatchObject({ action: 'reconcile', status: 'completed' });
  });

  it('stays unknown for an ended command without a matching receipt', async () => {
    const mismatchedSession = makeReconcileSetup({
      inspectStatus: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: completionReceipt({ sessionId: 'session-other' }),
        artifactsCollected: false,
      },
    });
    const mismatchedResult = await mismatchedSession.useCase.reconcileAttempt({ attemptId: 'attempt-1' });
    expect(mismatchedResult).toMatchObject({
      outcome: 'unknown',
      reason: 'Ambiguous worker command state or mismatched receipt',
    });
    expect(mismatchedSession.journal.heldFor('attempt-1')).toBe(true);

    const missingReceipt = makeReconcileSetup({
      inspectStatus: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: null,
        artifactsCollected: false,
      },
    });
    const missingResult = await missingReceipt.useCase.reconcileAttempt({ attemptId: 'attempt-1' });
    expect(missingResult.outcome).toBe('unknown');
    expect(missingReceipt.journal.heldFor('attempt-1')).toBe(true);
    expect(missingReceipt.attemptRepo.attempts.get('attempt-1')?.state).toBe('reconciling');
  });
});

function makeStopSetup(
  options: {
    attempt?: Partial<AttemptRecord>;
    stopResult?: StopRunnerSessionResult;
    withReservation?: boolean;
  } = {},
) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'running', ...options.attempt }));
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const runner = makeRunner({ stopResult: options.stopResult });
  const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });
  return { attemptRepo, journal, runner, useCase };
}

describe('StopAttemptUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new StopAttemptUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: StopAttemptUseCase');
    await expect(useCase.execute({ attemptId: 'attempt-1' })).rejects.toThrow(
      'Not implemented: StopAttemptUseCase',
    );
    await expect(useCase.stopAttempt({ attemptId: 'attempt-1' })).rejects.toThrow(
      'Not implemented: StopAttemptUseCase',
    );
  });

  it('refuses to stop an unknown attempt or one without a sessionId', async () => {
    const missing = makeStopSetup();
    missing.attemptRepo.attempts.delete('attempt-1');
    const missingResult = await missing.useCase.stopAttempt({ attemptId: 'attempt-1' });
    expect(missingResult).toEqual({
      outcome: 'refused',
      reason: 'Attempt not found or has no sessionId',
    });

    const noSession = makeStopSetup({ attempt: { sessionId: null } });
    const noSessionResult = await noSession.useCase.stopAttempt({ attemptId: 'attempt-1' });
    expect(noSessionResult).toEqual({
      outcome: 'refused',
      reason: 'Attempt not found or has no sessionId',
    });
    expect(noSession.runner.stopCalls).toHaveLength(0);
    expect(noSession.journal.entries).toHaveLength(0);
  });

  it('records stop intent and requests stop with the configured grace period', async () => {
    const setup = makeStopSetup();

    await setup.useCase.stopAttempt({ attemptId: 'attempt-1', gracePeriodSeconds: 30 });

    expect(setup.journal.entries[0]).toMatchObject({
      action: 'stop',
      status: 'intent-recorded',
      sessionId: 'session-1',
    });
    expect(setup.runner.stopCalls[0]).toEqual({
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      gracePeriodSeconds: 30,
      worktreePath: '/lanes/attempt-1',
      runner: undefined,
    });
  });

  it('releases capacity only on a confirmed termination receipt', async () => {
    const receipt = completionReceipt({ stoppedByRequest: true });
    const setup = makeStopSetup({
      stopResult: { outcome: 'terminated', receipt },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({
      outcome: 'terminated',
      attempt: expect.anything(),
      receipt,
      capacityReleased: true,
    });
    if (result.outcome !== 'terminated') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('cancelled');
    expect(result.attempt.outcome).toBe('stopped');
    expect(result.attempt.completionReceipt).toEqual(receipt);
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[1]).toMatchObject({ action: 'stop', status: 'completed' });
  });

  it('keeps the reservation when the session is still running', async () => {
    const setup = makeStopSetup({
      stopResult: { outcome: 'still-running', reason: 'grace period elapsed' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({ outcome: 'still-running', reason: 'grace period elapsed' });
    if (result.outcome !== 'still-running') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('running');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[1]).toMatchObject({ action: 'stop', status: 'ambiguous' });
  });

  it('keeps the reservation and reconciles when the stop outcome is unknown', async () => {
    const setup = makeStopSetup({
      stopResult: { outcome: 'unknown', reason: 'stop request lost' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({ outcome: 'unknown', reason: 'stop request lost' });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('reconciling');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('reconciling');
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[1]).toMatchObject({ action: 'stop', status: 'ambiguous' });
  });

  it('refuses to stop when runner stopSession returns refused without releasing capacity', async () => {
    const setup = makeStopSetup({
      stopResult: { outcome: 'refused', reason: 'Attempt has no recorded runner port' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt has no recorded runner port',
    });
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[1]).toMatchObject({ action: 'stop', status: 'refused' });
  });

  it('does not save cancelled or release capacity when termination receipt is not authoritative', async () => {
    const receipt = completionReceipt({ stoppedByRequest: true, authoritative: false });
    const setup = makeStopSetup({
      stopResult: { outcome: 'terminated', receipt },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({
      outcome: 'unknown',
    });
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('reconciling');
  });
});

function validCollectRequest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    expectedArtifacts: ['dist/report.json'],
    completionReceipt: completionReceipt(),
    ...overrides,
  };
}

function makeCollectSetup(
  options: {
    attempt?: Partial<AttemptRecord>;
    collectResult?: CollectCompletedAttemptArtifactsResult;
    withReservation?: boolean;
  } = {},
) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set(
    'attempt-1',
    storedAttempt({
      state: 'ended',
      sessionId: 'session-1',
      completionReceipt: completionReceipt(),
      ...options.attempt,
    }),
  );
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const artifacts = makeArtifactPort({ collectResult: options.collectResult });
  const useCase = new CollectAttemptArtifactsUseCase({
    attemptRepo,
    journal,
    artifactPort: artifacts.port,
  });
  return { attemptRepo, journal, artifacts, useCase };
}

describe('CollectAttemptArtifactsUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new CollectAttemptArtifactsUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow(
      'Not implemented: CollectAttemptArtifactsUseCase',
    );
    await expect(useCase.execute(validCollectRequest())).rejects.toThrow(
      'Not implemented: CollectAttemptArtifactsUseCase',
    );
    await expect(
      useCase.collectAttemptArtifacts(
        validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
      ),
    ).rejects.toThrow('Not implemented: CollectAttemptArtifactsUseCase');
  });

  it('refuses collection for an unknown attempt', async () => {
    const setup = makeCollectSetup();
    setup.attemptRepo.attempts.delete('attempt-1');

    const result = await setup.useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'Attempt not found' });
    expect(setup.artifacts.collectCalls).toHaveLength(0);
  });

  it('refuses collection before the attempt ended or with a mismatched receipt', async () => {
    const running = makeCollectSetup({ attempt: { state: 'running' } });
    const runningResult = await running.useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );
    expect(runningResult).toEqual({
      outcome: 'refused',
      reason: 'Attempt has not ended with a matching completion receipt',
    });
    expect(running.artifacts.collectCalls).toHaveLength(0);

    const wrongAttempt = makeCollectSetup();
    const wrongAttemptResult = await wrongAttempt.useCase.collectAttemptArtifacts(
      validCollectRequest({
        completionReceipt: completionReceipt({ attemptId: 'attempt-other' }),
      }) as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );
    expect(wrongAttemptResult.outcome).toBe('refused');

    const wrongSession = makeCollectSetup();
    const wrongSessionResult = await wrongSession.useCase.collectAttemptArtifacts(
      validCollectRequest({
        completionReceipt: completionReceipt({ sessionId: 'session-other' }),
      }) as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );
    expect(wrongSessionResult.outcome).toBe('refused');
    expect(wrongSession.artifacts.collectCalls).toHaveLength(0);
  });

  it('records no-commit when the collected delta has no commits', async () => {
    const setup = makeCollectSetup({
      collectResult: {
        outcome: 'collected',
        artifacts: {
          headCommit: 'abc123',
          commitsSinceBase: [],
          collectedArtifactPaths: [],
          notes: 'missing',
        },
      },
    });

    const result = await setup.useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result).toEqual({
      outcome: 'collected',
      artifacts: {
        headCommit: 'abc123',
        commitsSinceBase: [],
        collectedArtifactPaths: [],
        notes: 'missing',
      },
    });
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.state).toBe('collected');
    expect(saved?.outcome).toBe('no-commit');
    expect(saved?.artifacts?.notes).toBe('missing');
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.journal.entries[0]).toMatchObject({ action: 'collect', status: 'completed' });
  });

  it('records done and releases the reservation when commits exist', async () => {
    const setup = makeCollectSetup();

    const result = await setup.useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result.outcome).toBe('collected');
    if (result.outcome !== 'collected') {
      throw new Error('unreachable');
    }
    expect(result.artifacts.commitsSinceBase).toEqual(['commit-1']);
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.state).toBe('collected');
    expect(saved?.outcome).toBe('done');
    expect(saved?.artifacts?.headCommit).toBe('head456');
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.artifacts.collectCalls[0]).toMatchObject({
      attemptId: 'attempt-1',
      worktreePath: '/lanes/attempt-1',
      baseCommit: 'abc123',
      expectedArtifactPaths: ['dist/report.json'],
    });
  });

  it('passes an artifact-port refusal through unchanged', async () => {
    const setup = makeCollectSetup({
      collectResult: { outcome: 'refused', reason: 'worktree detached unexpectedly' },
    });

    const result = await setup.useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'worktree detached unexpectedly' });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('ended');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(0);
  });
});

function validFixRequest(overrides: Record<string, unknown> = {}) {
  return {
    fixAttemptId: 'attempt-fix-1',
    workOrderId: 'wo-1',
    priorAttemptId: 'attempt-1',
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    numberedFixes: ['1. Address the review finding about error mapping'],
    nowIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeFixSetup(options: { prior?: Partial<AttemptRecord>; existingFix?: AttemptRecord } = {}) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set(
    'attempt-1',
    storedAttempt({ state: 'ended', fixNumber: 0, kind: 'initial', ...options.prior }),
  );
  if (options.existingFix) {
    attemptRepo.attempts.set(options.existingFix.id, options.existingFix);
  }
  const useCase = new PrepareFixAttemptUseCase({ attemptRepo });
  return { attemptRepo, useCase };
}

describe('PrepareFixAttemptUseCase', () => {
  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new PrepareFixAttemptUseCase();

    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: PrepareFixAttemptUseCase');
    await expect(useCase.execute(validFixRequest())).rejects.toThrow(
      'Not implemented: PrepareFixAttemptUseCase',
    );
    await expect(
      useCase.prepareFixAttempt(validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0]),
    ).rejects.toThrow('Not implemented: PrepareFixAttemptUseCase');
  });

  it('refuses an invalid fix request', async () => {
    const setup = makeFixSetup();

    const sameId = await setup.useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-1' }) as Parameters<
        PrepareFixAttemptUseCase['prepareFixAttempt']
      >[0],
    );
    expect(sameId).toEqual({ outcome: 'refused', reason: 'fixAttemptId must differ from priorAttemptId' });

    const noFixes = await setup.useCase.prepareFixAttempt(
      validFixRequest({ numberedFixes: [] }) as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(noFixes).toEqual({ outcome: 'refused', reason: 'numberedFixes must record at least one fix' });

    const missingFields = await setup.useCase.prepareFixAttempt(
      validFixRequest({ workOrderId: '' }) as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(missingFields).toEqual({
      outcome: 'refused',
      reason: 'Missing required fix attempt fields: workOrderId',
    });

    const mismatchedWorktree = await setup.useCase.prepareFixAttempt(
      validFixRequest({ worktreePath: '/lanes/other' }) as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(mismatchedWorktree).toEqual({
      outcome: 'refused',
      reason: 'worktreePath does not match prior attempt: expected /lanes/attempt-1, got /lanes/other',
    });

    const mismatchedBaseCommit = await setup.useCase.prepareFixAttempt(
      validFixRequest({ baseCommit: 'mismatched-commit' }) as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(mismatchedBaseCommit).toEqual({
      outcome: 'refused',
      reason: 'baseCommit does not match prior attempt: expected abc123, got mismatched-commit',
    });
  });

  it('refuses a fix attempt when the prior attempt is missing or belongs to another work order', async () => {
    const missing = makeFixSetup();
    missing.attemptRepo.attempts.delete('attempt-1');
    const missingResult = await missing.useCase.prepareFixAttempt(
      validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(missingResult).toEqual({ outcome: 'refused', reason: 'Prior attempt not found for work order' });

    const otherWorkOrder = makeFixSetup({ prior: { workOrderId: 'wo-other' } });
    const otherResult = await otherWorkOrder.useCase.prepareFixAttempt(
      validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(otherResult).toEqual({ outcome: 'refused', reason: 'Prior attempt not found for work order' });
  });

  it('refuses a fix attempt while the prior attempt is still running', async () => {
    for (const state of ['running', 'reconciling', 'dispatching', 'intent-recorded', 'blocked'] as const) {
      const setup = makeFixSetup({ prior: { state } });
      const result = await setup.useCase.prepareFixAttempt(
        validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'Cannot prepare fix attempt before prior attempt has ended',
      });
    }
  });

  it('refuses a fix attempt when the fix identity already exists', async () => {
    const setup = makeFixSetup({
      existingFix: storedAttempt({ id: 'attempt-fix-1', kind: 'fix', fixNumber: 1, state: 'intent-recorded' }),
    });

    const result = await setup.useCase.prepareFixAttempt(
      validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'Fix attempt id already exists: attempt-fix-1' });
  });

  it('creates a fresh fix attempt with a null sessionId and incremented fix number', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        kind: 'fix',
        fixNumber: 2,
        priorAttemptId: 'attempt-0',
        sessionId: 'session-prior',
        completionReceipt: completionReceipt(),
        worktreePath: '/lanes/attempt-1',
      },
    });

    const result = await setup.useCase.prepareFixAttempt(
      validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );

    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect(result.attempt).toEqual({
      id: 'attempt-fix-1',
      workOrderId: 'wo-1',
      kind: 'fix',
      fixNumber: 3,
      priorAttemptId: 'attempt-1',
      worktreePath: '/lanes/attempt-1',
      baseCommit: 'abc123',
      state: 'intent-recorded',
      outcome: null,
      briefDigest: null,
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    });
    expect(setup.attemptRepo.attempts.get('attempt-fix-1')?.sessionId).toBeNull();
  });
});
