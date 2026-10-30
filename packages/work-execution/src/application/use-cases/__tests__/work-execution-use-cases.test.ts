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
  AttemptUsageRecord,
  CapacityReservationRecord,
  CommandCompletionReceipt,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { DispatchAttemptRequest } from '../../ports/in/DispatchAttemptPort.in-port.js';
import type {
  AllowedSeatCatalogueSeat,
  AllowedSeatPort,
} from '../../ports/out/AllowedSeatPort.out-port.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import {
  AttemptRevisionConflictError,
  canOverwriteAfterConflict,
} from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { BriefAuthoringPort } from '../../ports/out/BriefAuthoringPort.out-port.js';
import type { BriefKnowledgePort } from '../../ports/out/BriefKnowledgePort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionObservationPort } from '../../ports/out/ExecutionObservationPort.out-port.js';
import type {
  AbortWorktreeRunRequest,
  AbortWorktreeRunResult,
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionStatus,
  StartRunnerSessionResult,
  StopRunnerSessionResult,
  WorktreeRunRef,
  WorktreeRunState,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { CollectCompletedAttemptArtifactsResult } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type {
  ProjectProfileReadPort,
  ProjectProfileView,
} from '../../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort, WorktreeInspection } from '../../ports/out/WorkspacePort.out-port.js';
import type { ReadUsageResult, UsagePort } from '../../ports/out/UsagePort.out-port.js';
import type {
  ProcessTreeTerminationPort,
  TerminateWorktreeProcessesResult,
} from '../../ports/out/ProcessTreeTerminationPort.out-port.js';
import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { InspectWorkOrderUseCase } from '../InspectWorkOrderUseCase.use-case.js';
import { CollectAttemptArtifactsUseCase } from '../CollectAttemptArtifactsUseCase.use-case.js';
import { PrepareFixAttemptUseCase } from '../PrepareFixAttemptUseCase.use-case.js';
import {
  PrepareBriefPackageUseCase,
  simpleDeterministicHexDigest,
  type PrepareBriefPackageUseCaseRequest,
} from '../PrepareBriefPackageUseCase.use-case.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import { ReconcileAttemptUseCase } from '../ReconcileAttemptUseCase.use-case.js';
import { ReserveExecutionCapacityUseCase } from '../ReserveExecutionCapacityUseCase.use-case.js';
import { StopAttemptUseCase } from '../StopAttemptUseCase.use-case.js';
import { AllowedSeatAdapter } from '../../../infrastructure/adapters/AllowedSeatAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';

/**
 * The fake workspace serves both the frozen prose (`.lane/brief.md`) and the
 * frozen manifest (`.lane/brief-manifest.json`), and every default dispatch
 * request carries the digest those two files really produce.
 */
const FAKE_BRIEF_PROSE = '# Frozen brief prose';

const FAKE_BRIEF_FILE = JSON.stringify({
  modelAssignment: {
    model: 'nvidia/z-ai/glm-5.3',
    agent: 'lane-agent',
    variant: 'default',
  },
  independentReviewer: 'reviewer-model',
});

/** The digest `dispatchAttempt` recomputes for the default fake brief. */
const FAKE_BRIEF_DIGEST = simpleDeterministicHexDigest(FAKE_BRIEF_PROSE + '\n' + FAKE_BRIEF_FILE);

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
  releaseCount: number;
  heldFor(attemptId: string): boolean;
} {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  const journalState: ExecutionJournalPort & {
    entries: ActionJournalEntryRecord[];
    reservations: Map<string, CapacityReservationRecord>;
    releaseCount: number;
    heldFor(attemptId: string): boolean;
  } = {
    entries,
    reservations,
    releaseCount: 0,
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
      journalState.releaseCount += 1;
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
      const heldOnHost = held.filter((reservation) => reservation.hostId === request.record?.hostId);
      const maxSlots = request.maxSlots ?? 0;
      if (heldOnHost.length >= maxSlots) {
        return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots };
      }
      const usedSlots = new Set(heldOnHost.map((reservation) => reservation.slotIndex));
      let slotIndex = 0;
      while (usedSlots.has(slotIndex)) {
        slotIndex += 1;
      }
      const reservation: CapacityReservationRecord = { ...request.record!, slotIndex };
      reservations.set(reservation.id, reservation);
      return { outcome: 'reserved', reservation };
    },
  };
  return journalState;
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
    seatTool: 'opencode',
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

function makeProfile(overrides: Partial<ProjectProfileView> = {}): ProjectProfileView {
  return {
    projectId: 'proj-1',
    status: 'active',
    repository: 'git@example.org:acme/app.git',
    clones: {},
    gateProcedures: [],
    revision: 1,
    ...overrides,
  };
}

class FakeProfileRead implements ProjectProfileReadPort {
  calls: string[] = [];

  constructor(
    private readonly profile: ProjectProfileView | null,
    private readonly error?: Error,
  ) {}

  async readProjectProfile(projectId: string): Promise<ProjectProfileView | null> {
    this.calls.push(projectId);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.profile;
  }
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
      risk: 'high',
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

  it('rejects a work order whose project has no profile and saves nothing', async () => {
    const repo = makeWorkOrderRepo();
    const profileRead = new FakeProfileRead(null);
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason:
        "project proj-1 has no profile; register it with 'fleet-v2 projects add', or 'fleet-v2 projects adopt' when it already has work orders",
    });
    expect(repo.orders.size).toBe(0);
    expect(profileRead.calls).toEqual(['proj-1']);
  });

  it('rejects a work order for a retired project and saves nothing', async () => {
    const repo = makeWorkOrderRepo();
    const profileRead = new FakeProfileRead(makeProfile({ status: 'retired' }));
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason:
        'project proj-1 is retired; it accepts no new work orders — register the work under a new project id',
    });
    expect(repo.orders.size).toBe(0);
    expect(profileRead.calls).toEqual(['proj-1']);
  });

  it('refuses a status other than active, so a future status fails closed', async () => {
    const repo = makeWorkOrderRepo();
    const profileRead = new FakeProfileRead(
      makeProfile({ status: 'suspended' as unknown as 'active' }),
    );
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result.outcome).toBe('rejected');
    expect(repo.orders.size).toBe(0);
  });

  it('lists conflicts under the trimmed project id', async () => {
    const repo = makeWorkOrderRepo();
    const profileRead = new FakeProfileRead(makeProfile());
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    const first = await useCase.registerWorkOrder(validWorkOrderRequest());
    expect(first.outcome).toBe('registered');
    const second = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-overlap', projectId: '  proj-1  ' }),
    );

    expect(second.outcome).toBe('rejected');
    expect(second.outcome === 'rejected' && second.reason).toContain('Owned path conflicts with active work order');
  });

  it('applies the profile guard before the duplicate-id check', async () => {
    const repo = makeWorkOrderRepo();
    const registrar = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    await registrar.registerWorkOrder(validWorkOrderRequest());
    const profileRead = new FakeProfileRead(null);
    const guarded = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    const result = await guarded.registerWorkOrder(validWorkOrderRequest());

    expect(result.outcome === 'rejected' && result.reason).toContain('has no profile');
    expect(repo.orders.size).toBe(1);
  });

  it('registers as before when the project profile is active', async () => {
    const repo = makeWorkOrderRepo();
    const profileRead = new FakeProfileRead(makeProfile());
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result.outcome).toBe('registered');
    expect(profileRead.calls).toEqual(['proj-1']);
    if (result.outcome === 'registered') {
      expect(result.workOrder.projectId).toBe('proj-1');
    }
    expect((await repo.findWorkOrderById('wo-1'))?.state).toBe('approved');
  });

  it('calls the profile port once with the trimmed project id', async () => {
    const profileRead = new FakeProfileRead(makeProfile());
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: makeWorkOrderRepo(), profileRead });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest({ projectId: '  proj-1  ' }));

    expect(profileRead.calls).toEqual(['proj-1']);
    // The id that was checked is the id that is stored.
    expect(result.outcome === 'registered' && result.workOrder.projectId).toBe('proj-1');
  });

  it('propagates an error thrown by the profile port and saves nothing', async () => {
    const repo = makeWorkOrderRepo();
    const profileRead = new FakeProfileRead(null, new Error('adapter exploded'));
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo, profileRead });

    await expect(useCase.registerWorkOrder(validWorkOrderRequest())).rejects.toThrow('adapter exploded');
    expect(repo.orders.size).toBe(0);
  });

  it('registers an unknown project when no profileRead is configured', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest());

    expect(result.outcome).toBe('registered');
    expect((await repo.findWorkOrderById('wo-1'))?.state).toBe('approved');
  });

  it('rejects missing fields without calling the profile port', async () => {
    const profileRead = new FakeProfileRead(makeProfile());
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo: makeWorkOrderRepo(),
      profileRead,
    });

    const result = await useCase.registerWorkOrder(validWorkOrderRequest({ workOrderId: '' }));

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Missing required work order fields: workOrderId',
    });
    expect(profileRead.calls).toEqual([]);
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
    seatTool: 'opencode',
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

  it('refuses a blank or unknown seatTool and never defaults it (H8)', async () => {
    const useCase = new ReserveExecutionCapacityUseCase({ journal: makeJournal(), attemptRepo: makeAttemptRepo() });

    for (const seatTool of ['', '   ', 'claude', 'OpenCode']) {
      const result = await useCase.reserveExecutionCapacity(
        validReservationRequest({ seatTool }) as Parameters<
          ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
        >[0],
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'seatTool must be a declared runner kind (opencode or agy)',
      });
    }
  });

  it('records a valid seat tool on the reservation', async () => {
    const journal = makeJournal();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo: makeAttemptRepo() });

    const result = await useCase.reserveExecutionCapacity(
      validReservationRequest({ seatTool: 'agy' }) as Parameters<
        ReserveExecutionCapacityUseCase['reserveExecutionCapacity']
      >[0],
    );

    expect(result.outcome).toBe('reserved');
    if (result.outcome === 'reserved') {
      expect(result.reservation.seatTool).toBe('agy');
    }
    expect(journal.reservations.get('res-9')?.seatTool).toBe('agy');
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
        seatTool: 'opencode',
        hostName: null,
        hostKind: null,
        transport: null,
        sshAlias: null,
        port: null,
        worktreePath: '/lanes/attempt-9',
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
    modelAssignment: {
      model: 'implementer-model',
      variant: 'default',
      fallbackModel: 'fallback-model',
      seatTool: 'opencode',
    },
    independentReviewer: 'reviewer-model',
    ownedPaths: ['packages/app-a/**'],
    permissions: ['filesystem:worktree'],
    acceptanceChecks: ['yarn test'],
    acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
    allowedPathPrefixes: ['packages/app-a'],
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
      validBriefRequest({ independentReviewer: 'implementer-model', worktreePath: '/wt' }),
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
        worktreePath: '/wt',
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

  it('rejects a brief whose model assignment carries no declared seat tool (H8)', async () => {
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring().port,
      artifactPort: makeArtifactPort().port,
    });

    for (const seatTool of ['', '   ', 'claude', 'OpenCode', 1, undefined]) {
      const result = await useCase.prepareBriefPackage(
        validBriefRequest({
          modelAssignment: {
            model: 'implementer-model',
            variant: 'default',
            fallbackModel: 'fallback-model',
            seatTool: seatTool as never,
          },
        }),
      );
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'Model assignment requires a declared seat tool (opencode or agy)',
      });
    }
  });

  it('requires allowedPathPrefixes for an agy seat and rejects invalid prefixes (O14d1)', async () => {
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring().port,
      artifactPort: makeArtifactPort().port,
    });

    const agyMissing = await useCase.prepareBriefPackage(
      validBriefRequest({
        modelAssignment: {
          model: 'implementer-model',
          variant: 'default',
          fallbackModel: 'fallback-model',
          seatTool: 'agy',
        },
        allowedPathPrefixes: undefined,
      }),
    );
    expect(agyMissing).toEqual({
      outcome: 'rejected',
      reason: 'allowedPathPrefixes is required when the seat tool is agy',
    });

    const agyEmpty = await useCase.prepareBriefPackage(
      validBriefRequest({
        modelAssignment: {
          model: 'implementer-model',
          variant: 'default',
          fallbackModel: 'fallback-model',
          seatTool: 'agy',
        },
        allowedPathPrefixes: [],
      }),
    );
    expect(agyEmpty.outcome).toBe('rejected');

    for (const prefix of ['/etc/passwd', '../escape', 'packages/../..', '.git', '.lane', '']) {
      const invalid = await useCase.prepareBriefPackage(
        validBriefRequest({ allowedPathPrefixes: [prefix as string] }),
      );
      expect(invalid.outcome).toBe('rejected');
      expect((invalid as { reason: string }).reason).toContain('allowedPathPrefixes');
    }

    // Untyped input from the CLI or the API (review of #129).
    for (const notAnArray of ['x', { 0: 'x' }, ['x', 7]]) {
      const shaped = await useCase.prepareBriefPackage(
        validBriefRequest({ allowedPathPrefixes: notAnArray as unknown as string[] }),
      );
      expect(shaped).toEqual({
        outcome: 'rejected',
        reason: 'allowedPathPrefixes must be an array of strings',
      });
    }
  });

  it('freezes allowedPathPrefixes into the manifest and refuses a package without them (O14d1, S2a)', async () => {
    const authoring = makeBriefAuthoring();
    const artifacts = makeArtifactPort();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: authoring.port,
      artifactPort: artifacts.port,
    });

    const withPrefixes = await useCase.prepareBriefPackage(
      validBriefRequest({
        attemptId: 'attempt-prefix-1',
        worktreePath: '/lanes/attempt-prefix-1',
        allowedPathPrefixes: ['packages/x/src', 'docs/plans'],
      }),
    );
    expect(withPrefixes.outcome).toBe('prepared');

    // An opencode seat without prefixes is now refused: the spec's diff
    // check needs them (S2a).
    const withoutPrefixes = await useCase.prepareBriefPackage(
      validBriefRequest({
        attemptId: 'attempt-prefix-2',
        worktreePath: '/lanes/attempt-prefix-2',
        allowedPathPrefixes: undefined,
      }),
    );
    expect(withoutPrefixes).toEqual({
      outcome: 'rejected',
      reason: 'allowedPathPrefixes is required: the acceptance spec diff check refuses every changed path outside them',
    });

    const manifests = artifacts.placedCalls.map((call) =>
      JSON.parse(call.manifestJson) as { allowedPathPrefixes?: unknown },
    );
    expect(artifacts.placedCalls).toHaveLength(1);
    expect(manifests[0].allowedPathPrefixes).toEqual(['packages/x/src', 'docs/plans']);
  });

  it('freezes the seat tool into the manifest, where the digest covers it (H8)', async () => {
    const authoring = makeBriefAuthoring({ proseMarkdown: '# Prose A' });
    const artifacts = makeArtifactPort();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: authoring.port,
      artifactPort: artifacts.port,
    });

    const opencode = await useCase.prepareBriefPackage(
      validBriefRequest({
        attemptId: 'attempt-seat-1',
        worktreePath: '/lanes/attempt-seat-1',
        modelAssignment: {
          model: 'implementer-model',
          variant: 'default',
          fallbackModel: 'fallback-model',
          seatTool: 'opencode',
        },
      }),
    );
    const agy = await useCase.prepareBriefPackage(
      validBriefRequest({
        attemptId: 'attempt-seat-1',
        worktreePath: '/lanes/attempt-seat-1',
        modelAssignment: {
          model: 'implementer-model',
          variant: 'default',
          fallbackModel: 'fallback-model',
          seatTool: 'agy',
        },
        allowedPathPrefixes: ['packages/x'],
      }),
    );

    expect(opencode.outcome).toBe('prepared');
    expect(agy.outcome).toBe('prepared');
    if (opencode.outcome !== 'prepared' || agy.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    const firstManifest = JSON.parse(artifacts.placedCalls[0].manifestJson) as {
      modelAssignment: { seatTool?: unknown };
    };
    const secondManifest = JSON.parse(artifacts.placedCalls[1].manifestJson) as {
      modelAssignment: { seatTool?: unknown };
    };
    expect(firstManifest.modelAssignment.seatTool).toBe('opencode');
    expect(secondManifest.modelAssignment.seatTool).toBe('agy');
    // The seat tool is part of the frozen manifest, so changing it changes
    // the digest even when every other byte is identical.
    expect(agy.prepared.briefDigest).not.toBe(opencode.prepared.briefDigest);
  });

  it('rejects when the authoring port cannot produce a brief', async () => {
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring({ unavailableReason: 'orchestrator offline' }).port,
      artifactPort: makeArtifactPort().port,
    });

    const result = await useCase.prepareBriefPackage(validBriefRequest({ worktreePath: '/wt' }));

    expect(result).toEqual({ outcome: 'rejected', reason: 'orchestrator offline' });
  });

  it('rejects when brief package paths are not gitignored', async () => {
    const artifacts = makeArtifactPort({ offendingPaths: ['dist/report.json'] });
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring().port,
      artifactPort: artifacts.port,
    });

    const result = await useCase.prepareBriefPackage(validBriefRequest({ worktreePath: '/wt' }));

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
      seatTool: 'opencode',
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
    worktreeState?: WorktreeRunState;
    abortResult?: AbortWorktreeRunResult;
    withoutWorktreeMethods?: boolean;
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
  const inspectWorktreeCalls: WorktreeRunRef[] = [];
  const abortWorktreeCalls: AbortWorktreeRunRequest[] = [];
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
  if (!options.withoutWorktreeMethods) {
    port.inspectWorktreeRun = async (ref) => {
      inspectWorktreeCalls.push(ref);
      return options.worktreeState ?? { state: 'idle' };
    };
    port.abortWorktreeRun = async (request) => {
      abortWorktreeCalls.push(request);
      return options.abortResult ?? { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' };
    };
  }
  return {
    port,
    capabilities,
    startCalls,
    inspectCalls,
    stopCalls,
    inspectWorktreeCalls,
    abortWorktreeCalls,
  };
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
      (async (_worktreePath, relativePath) =>
        relativePath === '.lane/brief-manifest.json' ? FAKE_BRIEF_FILE : FAKE_BRIEF_PROSE),
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
    briefDigest: FAKE_BRIEF_DIGEST,
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
    allowedSeats?: AllowedSeatPort;
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
    ...(options.allowedSeats !== undefined ? { allowedSeats: options.allowedSeats } : {}),
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

  it('refuses a reservation held on another host before any start call (H9a fix)', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        describeRunner: () => ({
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          hostName: 'host-a',
          agent: null,
          model: null,
          variant: null,
        }),
      },
    });
    setup.journal.reservations.set(
      'res-1',
      storedReservation({ id: 'res-1', attemptId: 'attempt-1', hostName: 'host-b' }),
    );

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Reservation host host-b is not the configured runner host host-a; several lane-runner hosts need H9b/H10',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
  });

  it('refuses a worktree path other than the one the reservation allocated (review of #125)', async () => {
    const setup = makeDispatchSetup();
    setup.journal.reservations.set(
      'res-1',
      storedReservation({ id: 'res-1', attemptId: 'attempt-1', worktreePath: '/srv/wt/allocated-digest' }),
    );

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Worktree path does not match the path allocated by the capacity reservation',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
  });

  it('dispatches a reservation held on the configured runner host', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        describeRunner: () => ({
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          hostName: 'host-a',
          agent: null,
          model: null,
          variant: null,
        }),
      },
    });
    setup.journal.reservations.set(
      'res-1',
      storedReservation({ id: 'res-1', attemptId: 'attempt-1', hostName: 'host-a' }),
    );

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    expect(setup.runner.startCalls).toHaveLength(1);
  });

  it('dispatches a legacy reservation with a null host name as before', async () => {
    const setup = makeDispatchSetup();

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    expect(setup.runner.startCalls).toHaveLength(1);
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
    const manifestJson = JSON.stringify({
      modelAssignment: {
        model: 'nvidia/z-ai/glm-5.3',
        agent: 'lane-agent',
        variant: 'default',
      },
      independentReviewer: 'reviewer-model',
      ownerDecisionReferences: ['door-1', 'door-2'],
    });
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) =>
          relativePath === '.lane/brief-manifest.json' ? manifestJson : FAKE_BRIEF_PROSE,
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefDigest: simpleDeterministicHexDigest(FAKE_BRIEF_PROSE + '\n' + manifestJson),
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
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
      const manifestJson = JSON.stringify({
        modelAssignment: { model: 'nvidia/z-ai/glm-5.3', agent: 'lane-agent', variant: 'default' },
        independentReviewer: 'reviewer-model',
        ownerDecisionReferences: recorded,
      });
      const setup = makeDispatchSetup({
        workspaceOptions: {
          readWorktreeFile: async (_worktreePath, relativePath) =>
            relativePath === '.lane/brief-manifest.json' ? manifestJson : FAKE_BRIEF_PROSE,
        },
      });

      const result = await setup.useCase.dispatchAttempt(
        validDispatchRequest({
          briefDigest: simpleDeterministicHexDigest(FAKE_BRIEF_PROSE + '\n' + manifestJson),
        }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
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
    setup.attemptRepo.attempts.set(
      'attempt-0',
      storedAttempt({
        id: 'attempt-0',
        state: 'collected',
        sessionId: 'session-0',
        artifacts: { headCommit: 'abc123', commitsSinceBase: ['abc123'], collectedArtifactPaths: [], notes: 'present' },
      }),
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

  it('saves blocked on a blocked start, keeps the reservation and journals before saving', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        startResult: {
          outcome: 'blocked',
          reason: 'Worktree already has an active session (exit 75)',
          runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
        },
      },
    });
    const callOrder: string[] = [];
    const innerAppend = setup.journal.appendJournalEntry.bind(setup.journal);
    setup.journal.appendJournalEntry = async (entry) => {
      callOrder.push('journal.appendJournalEntry');
      await innerAppend(entry);
    };
    const innerSave = setup.attemptRepo.saveAttempt.bind(setup.attemptRepo);
    setup.attemptRepo.saveAttempt = async (record) => {
      callOrder.push('attemptRepo.saveAttempt');
      await innerSave(record);
    };

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toMatchObject({
      outcome: 'blocked',
      reason: 'Worktree already has an active session (exit 75)',
    });
    if (result.outcome !== 'blocked') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(result.attempt.sessionId).toBeNull();
    expect(result.attempt.runner).toEqual({
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'glm-5',
      variant: null,
    });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('blocked');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'dispatch',
      status: 'ambiguous',
      detail: `Blocked: Worktree already has an active session (exit 75); reservation kept until 'attempt reconcile' or 'attempt stop' resolves the worktree`,
    });
    expect(callOrder).toHaveLength(4);
    expect(callOrder.slice(-2)).toEqual(['journal.appendJournalEntry', 'attemptRepo.saveAttempt']);
  });

  // brief-fix2 item 2a: the blocked dispatch entry records what ran at block
  // time; the ids stay out of the entry's detail.
  it('records observedSessionIds on the blocked dispatch entry and keeps them out of the detail', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        startResult: {
          outcome: 'blocked',
          reason: 'Worktree already has an active session (exit 75)',
        },
        worktreeState: { state: 'running', sessionId: 'ses_observed_1' },
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('blocked');
    expect(setup.runner.inspectWorktreeCalls).toHaveLength(1);
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'dispatch',
      status: 'ambiguous',
      observedSessionIds: ['ses_observed_1'],
    });
    expect(setup.journal.entries[1]?.detail ?? '').not.toContain('ses_observed_1');
  });

  it('records an empty observedSessionIds on the blocked dispatch entry when the worktree is idle', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        startResult: {
          outcome: 'blocked',
          reason: 'Worktree already has an active session (exit 75)',
        },
        worktreeState: { state: 'idle' },
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('blocked');
    expect(setup.journal.entries[1]?.observedSessionIds).toEqual([]);
  });

  it('omits observedSessionIds from the blocked dispatch entry when the worktree state is unknown', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        startResult: {
          outcome: 'blocked',
          reason: 'Worktree already has an active session (exit 75)',
        },
        worktreeState: { state: 'unknown', reason: 'status lookup failed' },
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('blocked');
    expect(setup.journal.entries[1]?.observedSessionIds).toBeUndefined();
  });

  it('omits observedSessionIds from the blocked dispatch entry when the runner cannot inspect a worktree', async () => {
    const setup = makeDispatchSetup({
      runnerOptions: {
        startResult: {
          outcome: 'blocked',
          reason: 'Worktree already has an active session (exit 75)',
        },
        withoutWorktreeMethods: true,
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('blocked');
    expect(setup.journal.entries[1]?.observedSessionIds).toBeUndefined();
  });

  it.each(['dispatching', 'running', 'reconciling', 'blocked'] as const)(
    'refuses dispatch on an existing attempt in the $state claiming state without starting or journalling',
    async (state) => {
      const setup = makeDispatchSetup();
      setup.attemptRepo.attempts.set('attempt-1', storedAttempt({ state }));

      const result = await setup.useCase.dispatchAttempt(
        validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
      );

      expect(result).toEqual({
        outcome: 'refused',
        reason: `Attempt attempt-1 is ${state}; run 'attempt reconcile' (it resolves an attempt with no recorded session by inspecting its worktree) or 'attempt stop' before dispatching again`,
      });
      expect(setup.runner.startCalls).toHaveLength(0);
      expect(setup.journal.entries).toHaveLength(0);
    },
  );

  it('still dispatches an intent-recorded prepared attempt', async () => {
    const setup = makeDispatchSetup();
    setup.attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'intent-recorded' }));

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    expect(setup.runner.startCalls).toHaveLength(1);
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

  it('refuses dispatch when briefDigest is missing or blank (D3)', async () => {
    const setup = makeDispatchSetup();

    const blank = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: '' }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(blank).toEqual({
      outcome: 'refused',
      reason: "briefDigest is required: dispatch only a brief prepared by 'brief prepare'",
    });

    const missing = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: undefined }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(missing).toEqual({
      outcome: 'refused',
      reason: "briefDigest is required: dispatch only a brief prepared by 'brief prepare'",
    });

    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });

  it('refuses a fix-kind attempt whose request carries no digest until brief prepare runs again (D3)', async () => {
    const setup = makeDispatchSetup();
    setup.attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ id: 'attempt-1', kind: 'fix', fixNumber: 1, priorAttemptId: 'attempt-0', state: 'intent-recorded', briefDigest: null }),
    );

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: '' }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: "briefDigest is required: dispatch only a brief prepared by 'brief prepare'",
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect((await setup.attemptRepo.findAttemptById('attempt-1'))?.state).toBe('intent-recorded');
  });

  it('refuses dispatch when the frozen prose was edited after prepare (D3)', async () => {
    const preparedProse = 'ORIGINAL PROSE';
    const editedProse = 'EDITED PROSE AFTER PREPARE';
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) =>
          relativePath === '.lane/brief-manifest.json' ? FAKE_BRIEF_FILE : editedProse,
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefDigest: simpleDeterministicHexDigest(preparedProse + '\n' + FAKE_BRIEF_FILE),
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason:
        'Frozen brief digest mismatch for attempt attempt-1: the brief or its manifest changed after it was prepared; run \'brief prepare\' again',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });

  it('refuses dispatch when the frozen manifest was edited after prepare (D3)', async () => {
    const prose = 'PROSE (unchanged)';
    const editedManifest = FAKE_BRIEF_FILE.replace('nvidia/z-ai/glm-5.3', 'nvidia/z-ai/glm-5.4');
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) =>
          relativePath === '.lane/brief-manifest.json' ? editedManifest : prose,
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefDigest: simpleDeterministicHexDigest(prose + '\n' + FAKE_BRIEF_FILE),
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason:
        'Frozen brief digest mismatch for attempt attempt-1: the brief or its manifest changed after it was prepared; run \'brief prepare\' again',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });

  it('refuses dispatch when the frozen prose read returns null (D3)', async () => {
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) =>
          relativePath === '.lane/brief-manifest.json' ? FAKE_BRIEF_FILE : null,
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Unable to read the frozen brief at .lane/brief.md to check its digest',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });

  it('refuses dispatch when the frozen prose read throws (D3)', async () => {
    let manifestRead = false;
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) => {
          if (relativePath === '.lane/brief-manifest.json') {
            manifestRead = true;
            return FAKE_BRIEF_FILE;
          }
          if (!manifestRead) {
            return null;
          }
          throw new Error('permission denied');
        },
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Failed to read the frozen brief: Error: permission denied',
    });
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });

  it('refuses a .json briefPackagePath before any read (D3)', async () => {
    const setup = makeDispatchSetup();

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefPackagePath: '.lane/brief-manifest.json',
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'briefPackagePath must name the frozen prose (.md), got .lane/brief-manifest.json',
    });
    expect(setup.workspace.calls).toHaveLength(0);
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.journal.entries).toHaveLength(0);
    expect(await setup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });

  it('does not replace the manifest when .lane/brief.md is valid JSON; reads its twin and refuses when the twin changes (D3)', async () => {
    const jsonProse = JSON.stringify({
      modelAssignment: {
        model: 'forged/model',
        agent: 'forged-agent',
        variant: 'default',
      },
      independentReviewer: 'reviewer-model',
    });
    const preparedDigest = simpleDeterministicHexDigest(jsonProse + '\n' + FAKE_BRIEF_FILE);

    const unchangedSetup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) =>
          relativePath === '.lane/brief-manifest.json' ? FAKE_BRIEF_FILE : jsonProse,
      },
    });
    const started = await unchangedSetup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefDigest: preparedDigest,
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(started.outcome).toBe('started');
    expect(unchangedSetup.runner.startCalls[0]?.model).toBe('nvidia/z-ai/glm-5.3');

    const editedTwin = FAKE_BRIEF_FILE.replace('nvidia/z-ai/glm-5.3', 'nvidia/z-ai/glm-5.4');
    const changedTwinSetup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_worktreePath, relativePath) =>
          relativePath === '.lane/brief-manifest.json' ? editedTwin : jsonProse,
      },
    });
    const refused = await changedTwinSetup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefDigest: preparedDigest,
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(refused).toEqual({
      outcome: 'refused',
      reason:
        "Frozen brief digest mismatch for attempt attempt-1: the brief or its manifest changed after it was prepared; run 'brief prepare' again",
    });
    expect(changedTwinSetup.runner.startCalls).toHaveLength(0);
    expect(changedTwinSetup.journal.entries).toHaveLength(0);
    expect(changedTwinSetup.journal.heldFor('attempt-1')).toBe(true);
    expect(await changedTwinSetup.attemptRepo.findAttemptById('attempt-1')).toBeNull();
  });
});

describe('DispatchAttemptUseCase free-seat check (F3, F4, F7)', () => {
  // The same catalogue the AllowedSeatAdapter tests use (free-seat plan
  // FS3a-B). The default fake manifest freezes nvidia/z-ai/glm-5.3 variant
  // default and no seat tool, so the checked triple is (opencode,
  // nvidia/z-ai/glm-5.3, default).
  const seats: readonly AllowedSeatCatalogueSeat[] = [
    { id: 'paid', tool: 'opencode', model: 'b/paid-model', variant: 'default', costClass: 'paid' },
    { id: 'glm-free', tool: 'opencode', model: 'nvidia/z-ai/glm-5.3', variant: 'default', costClass: 'free' },
    { id: 'xy-paid', tool: 'opencode', model: 'x/y', costClass: 'paid' },
    { id: 'xy-free', tool: 'opencode', model: 'x/y', variant: 'free', costClass: 'free' },
    { id: 'twin-free', tool: 'opencode', model: 't/twin', costClass: 'free' },
    { id: 'twin-paid', tool: 'opencode', model: 't/twin', costClass: 'paid' },
  ];

  it('refuses a brief frozen with the free model and records the refusal durably', async () => {
    const setup = makeDispatchSetup({
      allowedSeats: new AllowedSeatAdapter({ seats, policy: { useFreeSeats: false } }),
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' && result.reason).toContain('is a free seat');
    expect(setup.runner.startCalls).toHaveLength(0);
    expect(setup.attemptRepo.attempts.size).toBe(0);
    expect(setup.journal.entries).toHaveLength(1);
    const entry = setup.journal.entries[0];
    expect(entry.action).toBe('dispatch');
    expect(entry.status).toBe('refused');
    expect(entry.detail).toContain('nvidia/z-ai/glm-5.3');
    expect(entry.detail).toContain('useFreeSeats false');
    // The reservation is still held, as every pre-intent refusal keeps it.
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatches the same brief through a seat override to a paid seat and records the flag', async () => {
    const setup = makeDispatchSetup({
      allowedSeats: new AllowedSeatAdapter({ seats, policy: { useFreeSeats: false } }),
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        seatOverride: {
          model: 'b/paid-model',
          reason: 'flag off',
          setBy: 'operator',
          expiresAtIso: '2026-10-16T08:00:00.000Z',
        },
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    expect(setup.runner.startCalls[0].model).toBe('b/paid-model');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.runner?.useFreeSeats).toBe(false);
  });

  it('refuses a seat override to the free x/y variant through the variant', async () => {
    const setup = makeDispatchSetup({
      allowedSeats: new AllowedSeatAdapter({ seats, policy: { useFreeSeats: false } }),
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        seatOverride: {
          model: 'x/y',
          variant: 'free',
          reason: 'flag off',
          setBy: 'operator',
          expiresAtIso: '2026-10-16T08:00:00.000Z',
        },
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' && result.reason).toContain('is a free seat (xy-free)');
    expect(setup.runner.startCalls).toHaveLength(0);
  });

  it('refuses a triple that is not in the catalogue at all', async () => {
    const setup = makeDispatchSetup({
      allowedSeats: new AllowedSeatAdapter({
        seats: seats.filter((seat) => seat.model !== 'nvidia/z-ai/glm-5.3'),
        policy: { useFreeSeats: false },
      }),
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' && result.reason).toContain(
      "is not in the installation's seat catalogue",
    );
    expect(setup.runner.startCalls).toHaveLength(0);
  });

  it('refuses a triple matched by seats of mixed cost class (F3)', async () => {
    // Seats that differ only in agent collapse to the same triple; one free
    // and one paid match is ambiguous and refused.
    const mixed: readonly AllowedSeatCatalogueSeat[] = [
      ...seats.filter((seat) => seat.id !== 'glm-free'),
      { id: 'brief-free', tool: 'opencode', model: 'nvidia/z-ai/glm-5.3', variant: 'default', costClass: 'free' },
      { id: 'brief-paid', tool: 'opencode', model: 'nvidia/z-ai/glm-5.3', variant: 'default', costClass: 'paid' },
    ];
    const setup = makeDispatchSetup({
      allowedSeats: new AllowedSeatAdapter({ seats: mixed, policy: { useFreeSeats: false } }),
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' && result.reason).toContain('mixed cost class');
    expect(result.outcome === 'refused' && result.reason).toContain('brief-free');
    expect(result.outcome === 'refused' && result.reason).toContain('brief-paid');
    expect(setup.runner.startCalls).toHaveLength(0);
  });

  it('dispatches the free brief when no flag is set and records the flag it saw', async () => {
    const setup = makeDispatchSetup({
      allowedSeats: new AllowedSeatAdapter({ seats }),
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.runner?.useFreeSeats).toBe(true);
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
    worktreeState?: WorktreeRunState;
    withoutWorktreeMethods?: boolean;
    withReservation?: boolean;
  } = {},
) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'reconciling', ...options.attempt }));
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const runner = makeRunner({
    inspectStatus: options.inspectStatus,
    worktreeState: options.worktreeState,
    withoutWorktreeMethods: options.withoutWorktreeMethods,
  });
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
    // A session-less `intent-recorded` attempt keeps the fallback behaviour:
    // re-saved `reconciling`, answered `unknown` (brief-fix2 item 1a).
    const setup = makeReconcileSetup({ attempt: { state: 'intent-recorded', sessionId: null } });

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

  it.each(['cancelled', 'collected', 'ended'] as const)(
    'refuses to reconcile a terminal $state attempt without contacting the runner or saving',
    async (state) => {
      const setup = makeReconcileSetup({
        attempt: {
          state,
          sessionId: null,
          completionReceipt: state === 'ended' ? completionReceipt() : null,
        },
        withReservation: false,
      });

      const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

      expect(result).toEqual({
        outcome: 'refused',
        reason: `Attempt attempt-1 is in terminal state '${state}' and cannot be reconciled`,
      });
      expect(setup.runner.inspectCalls).toHaveLength(0);
      expect(setup.runner.inspectWorktreeCalls).toHaveLength(0);
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe(state);
      expect(setup.journal.entries).toHaveLength(0);
    },
  );

  it.each(['cancelled', 'collected', 'ended'] as const)(
    'releases a reservation still held by a terminal $state attempt, refuses, and saves nothing',
    async (state) => {
      const setup = makeReconcileSetup({
        attempt: {
          state,
          sessionId: null,
          completionReceipt: state === 'ended' ? completionReceipt() : null,
        },
      });
      expect(setup.journal.heldFor('attempt-1')).toBe(true);

      const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

      expect(result).toEqual({
        outcome: 'refused',
        reason: `Attempt attempt-1 is in terminal state '${state}' and cannot be reconciled; a reservation it still held was released`,
      });
      expect(setup.runner.inspectCalls).toHaveLength(0);
      expect(setup.runner.inspectWorktreeCalls).toHaveLength(0);
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe(state);
      expect(setup.journal.heldFor('attempt-1')).toBe(false);
      expect(setup.journal.releaseCount).toBe(1);
      expect(setup.journal.entries).toHaveLength(1);
      expect(setup.journal.entries[0]).toMatchObject({
        action: 'reconcile',
        status: 'completed',
        sessionId: null,
        detail: `Released a capacity reservation still held by terminal attempt (${state})`,
      });
    },
  );

  it.each([
    ['no receipt', null],
    ['a non-authoritative receipt', completionReceipt({ authoritative: false })],
  ] as const)(
    'refuses an ended attempt with %s without releasing capacity, contacting the runner, or saving',
    async (_label, receipt) => {
      const setup = makeReconcileSetup({
        attempt: { state: 'ended', sessionId: null, completionReceipt: receipt },
      });
      expect(setup.journal.heldFor('attempt-1')).toBe(true);

      const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

      expect(result).toEqual({
        outcome: 'refused',
        reason:
          'Attempt attempt-1 ended without an authoritative completion receipt and cannot be reconciled; its reservation stays held',
      });
      expect(setup.journal.heldFor('attempt-1')).toBe(true);
      expect(setup.journal.releaseCount).toBe(0);
      expect(setup.journal.entries).toHaveLength(0);
      expect(setup.runner.inspectCalls).toHaveLength(0);
      expect(setup.runner.inspectWorktreeCalls).toHaveLength(0);
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('ended');
    },
  );

  it('cancels a session-less blocked attempt and releases the reservation when the worktree is idle', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'idle' },
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({
      outcome: 'cancelled',
      reason: "Nothing runs in the blocked attempt's worktree; cancelled and capacity released",
    });
    if (result.outcome !== 'cancelled') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('cancelled');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'reconcile',
      status: 'completed',
      detail: "Nothing runs in the blocked attempt's worktree; cancelled and capacity released",
    });
    expect(setup.runner.inspectWorktreeCalls).toHaveLength(1);
    expect(setup.runner.inspectCalls).toHaveLength(0);
  });

  it('adopts the running session in a session-less blocked attempt worktree when the history names it', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_adopted_1' },
    });
    setup.journal.entries.push({
      id: 'je-dispatch-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'completed',
      sessionId: 'ses_adopted_1',
      detail: 'Session started: ses_adopted_1',
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('active');
    if (result.outcome !== 'active') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('running');
    expect(result.attempt.sessionId).toBe('ses_adopted_1');
    expect(result.status).toEqual({
      runnerReachable: 'reachable',
      workspacePreparation: 'prepared',
      workerCommand: 'active',
      completionReceipt: null,
      artifactsCollected: false,
    });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('running');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'reconcile',
      status: 'completed',
      sessionId: 'ses_adopted_1',
      detail: 'Blocked attempt adopted the session running in its worktree: ses_adopted_1',
    });
  });

  it('keeps a session-less blocked attempt unchanged when the worktree state is unknown', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'unknown', reason: 'status lookup failed' },
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({ outcome: 'unknown', reason: 'status lookup failed' });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('blocked');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'reconcile',
      status: 'ambiguous',
      detail: 'status lookup failed',
    });
  });

  it('stays unknown for a session-less blocked attempt when the runner cannot inspect a worktree', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      withoutWorktreeMethods: true,
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'Runner cannot inspect a worktree without a session',
    });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('blocked');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(0);
  });

  // brief-fix2 item 1: the directory-scoped path applies to every session-less
  // attempt in dispatching, reconciling or blocked; journal details and result
  // reasons name the actual state.
  it.each(['reconciling', 'blocked'] as const)(
    'cancels a session-less $state attempt and releases the reservation when the worktree is idle',
    async (state) => {
      const setup = makeReconcileSetup({
        attempt: { state, sessionId: null },
        worktreeState: { state: 'idle' },
      });

      const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

      expect(result).toMatchObject({
        outcome: 'cancelled',
        reason: `Nothing runs in the ${state} attempt's worktree; cancelled and capacity released`,
      });
      if (result.outcome !== 'cancelled') {
        throw new Error('unreachable');
      }
      expect(result.attempt.state).toBe('cancelled');
      expect(result.attempt.outcome).toBe('stopped');
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
      expect(setup.journal.releaseCount).toBe(1);
      expect(setup.journal.heldFor('attempt-1')).toBe(false);
      expect(setup.journal.entries[0]).toMatchObject({
        action: 'reconcile',
        status: 'completed',
        detail: `Nothing runs in the ${state} attempt's worktree; cancelled and capacity released`,
      });
    },
  );

  it('returns unknown and keeps the reservation when a session-less dispatching worktree is still idle', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'dispatching', sessionId: null },
      worktreeState: { state: 'idle' },
    });
    const expectedReason =
      "Nothing runs in the dispatching attempt's worktree yet; a start may still be in progress. Run 'attempt reconcile' again later, or 'attempt stop' to cancel it";

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: expectedReason,
    });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('dispatching');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('dispatching');
    expect(setup.journal.releaseCount).toBe(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(1);
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'reconcile',
      status: 'ambiguous',
      sessionId: null,
      detail: expectedReason,
    });
  });

  it.each(['dispatching', 'reconciling', 'blocked'] as const)(
    'stops a session-less $state attempt by worktree abort and releases the reservation exactly once',
    async (state) => {
      const setup = makeStopSetup({
        attempt: { state, sessionId: null },
        abortResult: { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' },
      });

      const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

      expect(result).toMatchObject({ outcome: 'cancelled', capacityReleased: true });
      if (result.outcome !== 'cancelled') {
        throw new Error('unreachable');
      }
      expect(result.attempt.state).toBe('cancelled');
      expect(result.attempt.outcome).toBe('stopped');
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
      expect(setup.journal.releaseCount).toBe(1);
      expect(setup.journal.heldFor('attempt-1')).toBe(false);
      expect(setup.runner.abortWorktreeCalls).toHaveLength(1);
      expect(setup.runner.stopCalls).toHaveLength(0);
    },
  );

  it.each(['dispatching', 'reconciling', 'blocked'] as const)(
    'keeps a session-less $state attempt unchanged and held when the worktree state is unknown',
    async (state) => {
      const setup = makeReconcileSetup({
        attempt: { state, sessionId: null },
        worktreeState: { state: 'unknown', reason: 'status lookup failed' },
      });

      const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

      expect(result).toMatchObject({ outcome: 'unknown', reason: 'status lookup failed' });
      if (result.outcome !== 'unknown') {
        throw new Error('unreachable');
      }
      expect(result.attempt.state).toBe(state);
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe(state);
      expect(setup.attemptRepo.attempts.get('attempt-1')?.revision).toBe(
        storedAttempt({ state, sessionId: null }).revision,
      );
      expect(setup.journal.releaseCount).toBe(0);
      expect(setup.journal.heldFor('attempt-1')).toBe(true);
      expect(setup.journal.entries[0]).toMatchObject({
        action: 'reconcile',
        status: 'ambiguous',
        detail: 'status lookup failed',
      });
    },
  );

  // brief-fix2 item 2: adoption has an ownership check — the id is adopted
  // only when the attempt's own history named it.
  it('refuses to adopt a foreign session id the attempt never started, without saving', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_foreign_1' },
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    const reason =
      "Worktree runs session ses_foreign_1, which attempt attempt-1 never started; run 'attempt stop' to abort it";
    expect(result).toEqual({ outcome: 'unknown', attempt: expect.anything(), reason });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(result.attempt.sessionId).toBeNull();
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('blocked');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.sessionId).toBeNull();
    expect(setup.journal.releaseCount).toBe(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'reconcile',
      status: 'ambiguous',
      detail: reason,
    });
  });

  it('adopts a session id named by the attempt\u2019s own earlier completed dispatch entry', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_adopted_2' },
    });
    setup.journal.entries.push({
      id: 'je-dispatch-2',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'completed',
      sessionId: 'ses_adopted_2',
      detail: 'Session started: ses_adopted_2',
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('active');
    if (result.outcome !== 'active') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('running');
    expect(result.attempt.sessionId).toBe('ses_adopted_2');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('running');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.sessionId).toBe('ses_adopted_2');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
  });

  it('refuses an id that appears only in a blocked entry\u2019s observedSessionIds', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_observed_only' },
    });
    // The blocked dispatch entry recorded the id as evidence; it named the
    // session nowhere else (no sessionId on any entry, detail without the id).
    setup.journal.entries.push({
      id: 'je-blocked-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'ambiguous',
      sessionId: null,
      detail: "Blocked: Worktree already has an active session (exit 75); reservation kept until 'attempt reconcile' or 'attempt stop' resolves the worktree",
      observedSessionIds: ['ses_observed_only'],
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('unknown');
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(result.attempt.sessionId).toBeNull();
    expect(setup.journal.releaseCount).toBe(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'reconcile',
      status: 'ambiguous',
      detail: "Worktree runs session ses_observed_only, which attempt attempt-1 never started; run 'attempt stop' to abort it",
    });
  });

  it('refuses the agy synthetic session id even when the journal names it', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'agy-attempt-1' },
    });
    // agy-run --status reports only that a lane runs; the synthetic id is
    // derived from the attempt id, so a history match proves nothing.
    setup.journal.entries.push({
      id: 'je-agy-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'completed',
      sessionId: 'agy-attempt-1',
      detail: null,
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('unknown');
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(result.attempt.sessionId).toBeNull();
    expect(setup.journal.releaseCount).toBe(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
  });

  it('adopts a session id named only in an ambiguous detail', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_from_amb' },
    });
    // L5b's unknown start records the session in the ambiguous detail.
    setup.journal.entries.push({
      id: 'je-amb-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'ambiguous',
      sessionId: null,
      detail: 'start was ambiguous: worktree runs ses_from_amb',
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('active');
    if (result.outcome !== 'active') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('running');
    expect(result.attempt.sessionId).toBe('ses_from_amb');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.sessionId).toBe('ses_from_amb');
  });

  // A refusal journals the foreign id in its own detail; that entry must not
  // count as the attempt's history naming it on the next reconcile.
  it.each([
    ['a foreign id with no history', null],
    ['an id seen only in observedSessionIds', 'observed'],
  ] as const)('keeps refusing %s on a second reconcile', async (_label, evidence) => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_foreign_2' },
    });
    if (evidence === 'observed') {
      setup.journal.entries.push({
        id: 'je-blocked-2',
        attemptId: 'attempt-1',
        workOrderId: 'wo-1',
        action: 'dispatch',
        baseCommit: 'abc123',
        recordedAtIso: '2026-10-15T08:01:00.000Z',
        status: 'ambiguous',
        sessionId: null,
        detail: "Blocked: Worktree already has an active session (exit 75); reservation kept until 'attempt reconcile' or 'attempt stop' resolves the worktree",
        observedSessionIds: ['ses_foreign_2'],
      });
    }

    const first = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });
    const second = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(first.outcome).toBe('unknown');
    expect(second.outcome).toBe('unknown');
    const stored = setup.attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('blocked');
    expect(stored?.sessionId).toBeNull();
    expect(stored?.revision ?? 0).toBe(0);
    expect(setup.journal.releaseCount).toBe(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
  });

  it('does not adopt an id named only in a reconcile entry’s ambiguous detail', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_from_reconcile' },
    });
    setup.journal.entries.push({
      id: 'je-reconcile-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'reconcile',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'ambiguous',
      sessionId: null,
      detail: 'status exit 3 listed 2 sessions (ses_from_reconcile, ses_other)',
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('unknown');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.sessionId).toBeNull();
  });

  it('does not adopt an id that a dispatch detail names only as a prefix of a longer id', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: 'ses_a' },
    });
    setup.journal.entries.push({
      id: 'je-amb-2',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'ambiguous',
      sessionId: null,
      detail: 'start was ambiguous: worktree runs ses_ab',
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('unknown');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.sessionId).toBeNull();
  });

  it('refuses to adopt an empty session id when the worktree reports a running lane without a session id', async () => {
    const setup = makeReconcileSetup({
      attempt: { state: 'blocked', sessionId: null },
      worktreeState: { state: 'running', sessionId: '' },
    });
    setup.journal.entries.push({
      id: 'je-amb-empty',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'abc123',
      recordedAtIso: '2026-10-15T08:01:00.000Z',
      status: 'ambiguous',
      sessionId: null,
      detail: 'ses_ab',
    });

    const result = await setup.useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    const reason =
      "Worktree runs a lane that reports no session id, which attempt attempt-1 cannot adopt; run 'attempt stop' to abort it";
    expect(result).toEqual({ outcome: 'unknown', attempt: expect.anything(), reason });
    if (result.outcome !== 'unknown') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(result.attempt.sessionId).toBeNull();
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('blocked');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.sessionId).toBeNull();
    expect(setup.journal.releaseCount).toBe(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'reconcile',
      status: 'ambiguous',
      detail: reason,
    });
  });
});

function makeStopSetup(
  options: {
    attempt?: Partial<AttemptRecord>;
    stopResult?: StopRunnerSessionResult;
    worktreeState?: WorktreeRunState;
    abortResult?: AbortWorktreeRunResult;
    withoutWorktreeMethods?: boolean;
    withReservation?: boolean;
  } = {},
) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'running', ...options.attempt }));
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const runner = makeRunner({
    stopResult: options.stopResult,
    worktreeState: options.worktreeState,
    abortResult: options.abortResult,
    withoutWorktreeMethods: options.withoutWorktreeMethods,
  });
  const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });
  return { attemptRepo, journal, runner, useCase };
}

/**
 * Recording fake for the PK-1b process-tree termination port: it records
 * every request and answers with the configured outcome, or throws when
 * configured to.
 */
function makeProcessTreePort(result: TerminateWorktreeProcessesResult | 'throw') {
  const calls: {
    attemptId: string;
    worktreePath: string;
    runner: AttemptRunnerRecord | null | undefined;
    gracePeriodSeconds: number;
  }[] = [];
  const port: ProcessTreeTerminationPort = {
    async terminateWorktreeProcesses(request) {
      calls.push(request);
      if (result === 'throw') {
        throw new Error('boom');
      }
      return result;
    },
  };
  return { port, calls };
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

  it('cancels a session-less blocked attempt by worktree abort and releases the reservation', async () => {
    const setup = makeStopSetup({
      attempt: { state: 'blocked', sessionId: null },
      abortResult: { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1', gracePeriodSeconds: 20 });

    expect(result).toMatchObject({ outcome: 'cancelled', capacityReleased: true });
    if (result.outcome !== 'cancelled') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('cancelled');
    expect(result.attempt.outcome).toBe('stopped');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
    expect(setup.runner.abortWorktreeCalls).toEqual([
      {
        attemptId: 'attempt-1',
        worktreePath: '/lanes/attempt-1',
        runner: undefined,
        gracePeriodSeconds: 20,
      },
    ]);
    expect(setup.runner.stopCalls).toHaveLength(0);
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'stop',
      status: 'intent-recorded',
      sessionId: null,
    });
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'stop',
      status: 'completed',
      sessionId: null,
      detail: 'Worktree aborted and attempt cancelled',
    });
  });

  it('reports unknown without releasing when the aborted save loses to a concurrent session adopt', async () => {
    const seed = storedAttempt({ state: 'blocked', sessionId: null });
    const fresh = storedAttempt({
      state: 'running',
      sessionId: 'ses_adopted_elsewhere',
      revision: 3,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: fresh,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({
      abortResult: { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' },
    });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    const reason = `Worktree aborted, but attempt attempt-1 changed concurrently to running (session ses_adopted_elsewhere); run 'attempt reconcile'`;
    expect(result).toEqual({ outcome: 'unknown', attempt: fresh, reason });
    expect(attemptRepo.attempts.get('attempt-1')?.state).toBe('running');
    expect(journal.heldFor('attempt-1')).toBe(true);
    expect(journal.releaseCount).toBe(0);
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[1]).toMatchObject({
      action: 'stop',
      status: 'ambiguous',
      sessionId: null,
      detail: reason,
    });
  });

  it('keeps a session-less blocked attempt unchanged when the worktree is still running', async () => {
    const setup = makeStopSetup({
      attempt: { state: 'blocked', sessionId: null },
      abortResult: { outcome: 'still-running', reason: 'grace period elapsed' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({ outcome: 'still-running', reason: 'grace period elapsed' });
    if (result.outcome !== 'still-running') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('blocked');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('blocked');
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'stop',
      status: 'ambiguous',
      detail: 'grace period elapsed',
    });
  });

  it('refuses to stop a session-less non-blocked attempt and leaves the reservation held', async () => {
    const setup = makeStopSetup({
      attempt: { state: 'running', sessionId: null },
      abortResult: { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt not found or has no sessionId',
    });
    expect(setup.runner.abortWorktreeCalls).toHaveLength(0);
    expect(setup.runner.stopCalls).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('running');
  });

  it('refuses to stop a session-less intent-recorded attempt and leaves the reservation held', async () => {
    // brief-fix2 item 1b: only dispatching, reconciling and blocked resolve
    // by worktree abort; any other session-less state still refuses.
    const setup = makeStopSetup({
      attempt: { state: 'intent-recorded', sessionId: null },
      abortResult: { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' },
    });

    const result = await setup.useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt not found or has no sessionId',
    });
    expect(setup.runner.abortWorktreeCalls).toHaveLength(0);
    expect(setup.runner.stopCalls).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('intent-recorded');
  });

  it('terminates the process tree with the request grace after a worktree abort and journals the count first', async () => {
    const setup = makeStopSetup({
      attempt: { state: 'blocked', sessionId: null, runner: { kind: 'opencode', remotePort: 4166, host: 'example-lane', hostName: 'lane-host', agent: null, model: 'glm-5', variant: null } },
      abortResult: { outcome: 'aborted', endedAtIso: '2026-10-22T12:00:00.000Z' },
    });
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 3 });
    const useCase = new StopAttemptUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      runner: setup.runner.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1', gracePeriodSeconds: 20 });

    expect(result).toMatchObject({ outcome: 'cancelled', capacityReleased: true });
    expect(result.outcome === 'cancelled' && result.attempt.state === 'cancelled').toBe(true);
    expect(tree.calls).toEqual([
      {
        attemptId: 'attempt-1',
        worktreePath: '/lanes/attempt-1',
        runner: { kind: 'opencode', remotePort: 4166, host: 'example-lane', hostName: 'lane-host', agent: null, model: 'glm-5', variant: null },
        gracePeriodSeconds: 20,
      },
    ]);
    const completed = setup.journal.entries.filter((entry) => entry.status === 'completed');
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({
      action: 'stop',
      status: 'completed',
      sessionId: null,
      detail: 'Process tree terminated: killed=3',
    });
    expect(completed[1]).toMatchObject({
      action: 'stop',
      status: 'completed',
      sessionId: null,
      detail: 'Worktree aborted and attempt cancelled',
    });
  });

  it('terminates the process tree with the default grace after an authoritative terminated stop and journals the count first', async () => {
    const receipt = completionReceipt({ stoppedByRequest: true });
    const setup = makeStopSetup({
      stopResult: { outcome: 'terminated', receipt },
    });
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 1 });
    const useCase = new StopAttemptUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      runner: setup.runner.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({ outcome: 'terminated' });
    if (result.outcome !== 'terminated') {
      throw new Error('unreachable');
    }
    expect(result.attempt.state).toBe('cancelled');
    expect(tree.calls).toEqual([
      {
        attemptId: 'attempt-1',
        worktreePath: '/lanes/attempt-1',
        runner: null,
        gracePeriodSeconds: 10,
      },
    ]);
    const completed = setup.journal.entries.filter((entry) => entry.status === 'completed');
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({
      action: 'stop',
      status: 'completed',
      sessionId: 'session-1',
      detail: 'Process tree terminated: killed=1',
    });
    expect(completed[1]).toMatchObject({
      action: 'stop',
      status: 'completed',
      sessionId: 'session-1',
      detail: 'Session terminated and termination receipt recorded',
    });
  });

  it('journals ambiguous process-tree entries for refused, unavailable and a throwing port while the stop stays cancelled', async () => {
    const receipt = completionReceipt({ stoppedByRequest: true });
    for (const treeResult of [
      { outcome: 'refused', reason: 'no processes found' },
      { outcome: 'unavailable', reason: 'host unreachable' },
    ] as const) {
      const setup = makeStopSetup({
        stopResult: { outcome: 'terminated', receipt },
      });
      const tree = makeProcessTreePort(treeResult);
      const useCase = new StopAttemptUseCase({
        attemptRepo: setup.attemptRepo,
        journal: setup.journal,
        runner: setup.runner.port,
        processTreeTermination: tree.port,
      });

      const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

      expect(result).toMatchObject({ outcome: 'terminated' });
      if (result.outcome !== 'terminated') {
        throw new Error('unreachable');
      }
      expect(result.attempt.state).toBe('cancelled');
      expect(result.attempt.outcome).toBe('stopped');
      const ambiguous = setup.journal.entries.filter((entry) => entry.status === 'ambiguous');
      expect(ambiguous).toHaveLength(1);
      expect(ambiguous[0]).toMatchObject({
        action: 'stop',
        status: 'ambiguous',
        sessionId: 'session-1',
        detail: `Process tree termination ${treeResult.outcome}: ${treeResult.reason}`,
      });
    }

    const setup = makeStopSetup({
      stopResult: { outcome: 'terminated', receipt },
    });
    const tree = makeProcessTreePort('throw');
    const useCase = new StopAttemptUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      runner: setup.runner.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toMatchObject({ outcome: 'terminated' });
    const ambiguous = setup.journal.entries.filter((entry) => entry.status === 'ambiguous');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toMatchObject({
      action: 'stop',
      status: 'ambiguous',
      sessionId: 'session-1',
      detail: 'Process tree termination unavailable: port threw',
    });
  });

  it('makes no process-tree call or entry on a refused stop', async () => {
    const setup = makeStopSetup({
      stopResult: { outcome: 'refused', reason: 'Attempt has no recorded runner port' },
    });
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 2 });
    const useCase = new StopAttemptUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      runner: setup.runner.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt has no recorded runner port',
    });
    expect(tree.calls).toHaveLength(0);
    expect(
      setup.journal.entries.some((entry) => (entry.detail ?? '').includes('Process tree')),
    ).toBe(false);
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

function makeUsagePort(
  options: {
    readResult?: (request: { attempt: AttemptRecord }) => ReadUsageResult;
  } = {},
) {
  const calls: { attempt: AttemptRecord }[] = [];
  const port: UsagePort = {
    async readUsage(request) {
      calls.push(request);
      if (options.readResult) {
        return options.readResult(request);
      }
      const usage: AttemptUsageRecord = {
        source: 'opencode-db',
        readAtIso: '2026-10-23T12:00:00.000Z',
        sessionId: request.attempt.sessionId,
        steps: 3,
        wallSeconds: 12.5,
        tokensInput: 100,
        tokensOutput: 50,
        tokensReasoning: 10,
        tokensCacheRead: 20,
        tokensCacheWrite: 5,
        costUsd: 0.02,
        model: 'inception/mercury-3',
        agent: 'opencode',
        reason: null,
      };
      return { outcome: 'read', usage };
    },
  };
  return { port, calls };
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

  it('stores usage on the collected record when the usage port reads', async () => {
    const setup = makeCollectSetup();
    const usage = makeUsagePort();
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      artifactPort: setup.artifacts.port,
      usage: usage.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result.outcome).toBe('collected');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.usage?.source).toBe('opencode-db');
    expect(saved?.usage?.steps).toBe(3);
    expect(saved?.usage?.sessionId).toBe('session-1');
    expect(usage.calls).toHaveLength(1);
    expect(setup.journal.entries[0]?.detail).toBe('usage read');
  });

  it('terminates the process tree with the default grace after the collected save and journals the count before the collect entry', async () => {
    const setup = makeCollectSetup();
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 5 });
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      artifactPort: setup.artifacts.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result).toMatchObject({ outcome: 'collected' });
    expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('collected');
    expect(setup.attemptRepo.attempts.get('attempt-1')?.outcome).toBe('done');
    expect(tree.calls).toEqual([
      {
        attemptId: 'attempt-1',
        worktreePath: '/lanes/attempt-1',
        runner: null,
        gracePeriodSeconds: 10,
      },
    ]);
    expect(setup.journal.entries).toHaveLength(2);
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'collect',
      status: 'completed',
      sessionId: 'session-1',
      detail: 'Process tree terminated: killed=5',
    });
    expect(setup.journal.entries[1]).toMatchObject({
      action: 'collect',
      status: 'completed',
      detail: 'Artifacts collected with outcome done',
    });
  });

  it('still collects with ambiguous process-tree entries for refused, unavailable and a throwing port', async () => {
    for (const treeResult of [
      { outcome: 'refused', reason: 'kill refused by host' },
      { outcome: 'unavailable', reason: 'runner did not answer' },
    ] as const) {
      const setup = makeCollectSetup();
      const tree = makeProcessTreePort(treeResult);
      const useCase = new CollectAttemptArtifactsUseCase({
        attemptRepo: setup.attemptRepo,
        journal: setup.journal,
        artifactPort: setup.artifacts.port,
        processTreeTermination: tree.port,
      });

      const result = await useCase.collectAttemptArtifacts(
        validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
      );

      expect(result).toMatchObject({ outcome: 'collected' });
      expect(setup.attemptRepo.attempts.get('attempt-1')?.state).toBe('collected');
      expect(setup.journal.entries[0]).toMatchObject({
        action: 'collect',
        status: 'ambiguous',
        sessionId: 'session-1',
        detail: `Process tree termination ${treeResult.outcome}: ${treeResult.reason}`,
      });
      expect(setup.journal.entries[1]).toMatchObject({
        action: 'collect',
        status: 'completed',
        detail: 'Artifacts collected with outcome done',
      });
    }

    const setup = makeCollectSetup();
    const tree = makeProcessTreePort('throw');
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      artifactPort: setup.artifacts.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result).toMatchObject({ outcome: 'collected' });
    expect(setup.journal.entries[0]).toMatchObject({
      action: 'collect',
      status: 'ambiguous',
      sessionId: 'session-1',
      detail: 'Process tree termination unavailable: port threw',
    });
  });

  it('still collects and stores unavailable usage when the usage port is unavailable', async () => {
    const setup = makeCollectSetup();
    const usage = makeUsagePort({
      readResult: () => ({
        outcome: 'unavailable',
        usage: {
          source: 'unavailable',
          readAtIso: '2026-10-23T12:00:00.000Z',
          sessionId: 'session-1',
          steps: null,
          wallSeconds: null,
          tokensInput: null,
          tokensOutput: null,
          tokensReasoning: null,
          tokensCacheRead: null,
          tokensCacheWrite: null,
          costUsd: null,
          model: null,
          agent: null,
          reason: 'schema mismatch',
        },
      }),
    });
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      artifactPort: setup.artifacts.port,
      usage: usage.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result.outcome).toBe('collected');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.usage?.source).toBe('unavailable');
    expect(saved?.usage?.reason).toBe('schema mismatch');
    expect(setup.journal.entries[0]?.detail).toBe('usage unavailable: schema mismatch');
  });

  it('stores the port-provided no-session-id reason when the attempt has no sessionId', async () => {
    const setup = makeCollectSetup({ attempt: { sessionId: null } });
    const usage = makeUsagePort({
      readResult: () => ({
        outcome: 'unavailable',
        usage: {
          source: 'unavailable',
          readAtIso: '2026-10-23T12:00:00.000Z',
          sessionId: null,
          steps: null,
          wallSeconds: null,
          tokensInput: null,
          tokensOutput: null,
          tokensReasoning: null,
          tokensCacheRead: null,
          tokensCacheWrite: null,
          costUsd: null,
          model: null,
          agent: null,
          reason: 'no session id',
        },
      }),
    });
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: setup.attemptRepo,
      journal: setup.journal,
      artifactPort: setup.artifacts.port,
      usage: usage.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result.outcome).toBe('collected');
    // The port, not the use case, decides "no session id": the use case must
    // still have called it exactly once, with the null-session attempt.
    expect(usage.calls).toHaveLength(1);
    expect(usage.calls[0]?.attempt.id).toBe('attempt-1');
    expect(usage.calls[0]?.attempt.sessionId).toBeNull();
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.usage?.source).toBe('unavailable');
    expect(saved?.usage?.reason).toBe('no session id');
    expect(setup.journal.entries[0]?.detail).toBe('usage unavailable: no session id');
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
    storedAttempt({ state: 'collected', fixNumber: 0, kind: 'initial', ...options.prior }),
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

  it.each(['running', 'reconciling', 'dispatching', 'intent-recorded', 'blocked', 'ended'] as const)(
    'refuses a fix attempt while the prior attempt is still $state',
    async (state) => {
      const setup = makeFixSetup({ prior: { state } });
      const result = await setup.useCase.prepareFixAttempt(
        validFixRequest() as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: `Prior attempt attempt-1 is ${state}; a fix attempt starts only after it is collected or cancelled`,
      });
    },
  );

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

function makeFailingSaveAttemptRepo(
  options: {
    conflictOnSave?: number;
    conflictOnSaves?: readonly number[];
    freshAfterConflict?: AttemptRecord;
    /** Fresh record installed on the n-th conflict (0-based); overrides freshAfterConflict. */
    freshAfterConflicts?: readonly AttemptRecord[];
    seed?: AttemptRecord;
  } = {},
): AttemptRepositoryPort & { attempts: Map<string, AttemptRecord>; saveCalls: number } {
  const attempts = new Map<string, AttemptRecord>();
  if (options.seed) {
    attempts.set(options.seed.id, options.seed);
  }
  const conflictSaves =
    options.conflictOnSaves ?? (options.conflictOnSave !== undefined ? [options.conflictOnSave] : []);
  const repo = {
    attempts,
    saveCalls: 0,
    async saveAttempt(record: AttemptRecord): Promise<void> {
      repo.saveCalls += 1;
      if (conflictSaves.includes(repo.saveCalls)) {
        const nth = conflictSaves.indexOf(repo.saveCalls);
        const fresh = options.freshAfterConflicts?.[nth] ?? options.freshAfterConflict;
        if (fresh) {
          attempts.set(fresh.id, fresh);
        }
        throw new AttemptRevisionConflictError(record.id, 0, record.revision ?? 0);
      }
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId: string) {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId: string) {
      return [...attempts.values()].filter((a) => a.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...attempts.values()];
    },
  };
  return repo;
}

describe('attempt revision compare-and-swap retry', () => {
  it('reconcile retries once and refuses on a fresh cancelled record without saving', async () => {
    const seed = storedAttempt({ state: 'running' });
    const freshCancelled = storedAttempt({
      id: 'attempt-1',
      state: 'cancelled',
      updatedAtIso: '2026-10-15T08:05:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: freshCancelled,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner(); // default inspectStatus: active
    const useCase = new ReconcileAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.reconcileAttempt({ attemptId: 'attempt-1' });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt attempt-1 changed to cancelled while reconciling',
    });
    expect(attemptRepo.saveCalls).toBe(1);
    expect(attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
    expect(journal.entries).toHaveLength(0);
  });

  it('stop conflicts after a terminated stop: stopSession runs once, cancelled is saved on the fresh record, release runs once', async () => {
    const seed = storedAttempt({ state: 'running' });
    const fresh = storedAttempt({
      state: 'running',
      revision: 3,
      updatedAtIso: '2026-10-15T08:04:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: fresh,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('terminated');
    expect(runner.stopCalls).toHaveLength(1);
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('cancelled');
    expect(stored?.revision).toBe((fresh.revision ?? 0) + 1);
    expect(stored?.completionReceipt).toEqual(receipt);
    expect(journal.releaseCount).toBe(1);
    expect(journal.heldFor('attempt-1')).toBe(false);
  });

  it('stop conflicts and the fresh record is already cancelled: no second save, release runs once, stopSession once', async () => {
    const seed = storedAttempt({ state: 'running' });
    const fresh = storedAttempt({
      state: 'cancelled',
      outcome: 'stopped',
      revision: 2,
      updatedAtIso: '2026-10-15T08:04:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: fresh,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('terminated');
    expect(runner.stopCalls).toHaveLength(1);
    expect(attemptRepo.saveCalls).toBe(1);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(fresh);
    expect(journal.releaseCount).toBe(1);
    expect(journal.heldFor('attempt-1')).toBe(false);
  });

  it('stop conflicts and the fresh record holds a different session: no cancelled write, no release, stopSession once', async () => {
    const seed = storedAttempt({ state: 'running', sessionId: 'session-1' });
    const fresh = storedAttempt({
      state: 'running',
      sessionId: 'session-redispatch',
      revision: 4,
      updatedAtIso: '2026-10-15T08:04:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: fresh,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('terminated');
    if (result.outcome === 'terminated') {
      expect(result.capacityReleased).toBe(false);
    }
    expect(runner.stopCalls).toHaveLength(1);
    expect(runner.stopCalls[0]?.sessionId).toBe('session-1');
    expect(attemptRepo.saveCalls).toBe(1);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(fresh);
    expect(journal.releaseCount).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch with an unknown start whose reconciling save conflicts still journals the ambiguous start', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2 });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({ startResult: { outcome: 'unknown', reason: 'start was ambiguous' } });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('unknown');
    const ambiguous = journal.entries.filter(
      (entry) => entry.status === 'ambiguous' && entry.detail === 'start was ambiguous',
    );
    expect(ambiguous).toHaveLength(1);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch conflicts on the running save: the fresh record carries the sessionId, startSession runs once', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2 });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner(); // default start: started with session-1
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('started');
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('running');
    expect(stored?.sessionId).toBe('session-1');
  });

  it('dispatch conflicts on the running save with a terminal fresh record: unknown naming the session, journal entry carries the sessionId', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSave: 2,
      freshAfterConflict: storedAttempt({ state: 'cancelled', revision: 5 }),
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner(); // default start: started with session-1
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('session-1');
    }
    const sessionEntries = journal.entries.filter((entry) => entry.sessionId === 'session-1');
    expect(sessionEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatch refused start whose cancelled save conflicts still releases capacity once', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2 });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({
      startResult: { outcome: 'refused', reason: 'no seat available' },
    });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    expect(runner.startCalls).toHaveLength(1);
    expect(attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
    expect(journal.releaseCount).toBe(1);
    expect(journal.heldFor('attempt-1')).toBe(false);
  });

  it('dispatch refused start whose cancelled save conflicts keeps the stop reason on the rebuilt save (S1b)', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2 });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({
      startResult: { outcome: 'refused', reason: 'HTTP 429 Too Many Requests' },
    });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('cancelled');
    expect(stored?.stopReason).toBe('rate-limited');
  });

  it('dispatch with running and rebuilt saves both conflicting stops the started session once and journals completed then ambiguous', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSaves: [2, 3],
      freshAfterConflict: storedAttempt({ state: 'reconciling', sessionId: null, revision: 5 }),
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('second revision conflict');
    }
    expect(runner.stopCalls).toHaveLength(1);
    expect(runner.stopCalls[0]?.sessionId).toBe('session-1');
    const completed = journal.entries.filter((entry) => entry.status === 'completed');
    expect(completed).toHaveLength(1);
    const ambiguous = journal.entries.filter(
      (entry) =>
        entry.status === 'ambiguous' &&
        entry.sessionId === 'session-1' &&
        (entry.detail ?? '').includes('second revision conflict') &&
        (entry.detail ?? '').includes('session-1'),
    );
    expect(ambiguous).toHaveLength(1);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch with running and preserved saves both conflicting stops the started session once and journals completed then ambiguous', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSaves: [2, 3],
      freshAfterConflict: storedAttempt({ state: 'running', sessionId: null, revision: 5 }),
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('second revision conflict');
    }
    expect(runner.stopCalls).toHaveLength(1);
    expect(runner.stopCalls[0]?.sessionId).toBe('session-1');
    const completed = journal.entries.filter((entry) => entry.status === 'completed');
    expect(completed).toHaveLength(1);
    const ambiguous = journal.entries.filter(
      (entry) =>
        entry.status === 'ambiguous' &&
        entry.sessionId === 'session-1' &&
        (entry.detail ?? '').includes('second revision conflict') &&
        (entry.detail ?? '').includes('session-1'),
    );
    expect(ambiguous).toHaveLength(1);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch with both saves conflicting terminates the process tree of the stopped session and journals it before the ambiguous entry', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSaves: [2, 3],
      freshAfterConflict: storedAttempt({ state: 'reconciling', sessionId: null, revision: 5 }),
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 4 });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('second revision conflict');
    }
    expect(runner.stopCalls).toHaveLength(1);
    expect(tree.calls).toHaveLength(1);
    expect(tree.calls[0]).toMatchObject({
      attemptId: 'attempt-1',
      worktreePath: '/lanes/attempt-1',
      runner: expect.objectContaining({ kind: 'opencode' }),
      gracePeriodSeconds: 10,
    });
    const termination = journal.entries.find((entry) =>
      (entry.detail ?? '').startsWith('Process tree terminated'),
    );
    const ambiguous = journal.entries.find(
      (entry) =>
        entry.status === 'ambiguous' &&
        (entry.detail ?? '').includes('second revision conflict'),
    );
    expect(termination).toBeDefined();
    expect(termination).toMatchObject({
      action: 'dispatch',
      status: 'completed',
      sessionId: 'session-1',
      detail: 'Process tree terminated: killed=4',
    });
    expect(ambiguous).toBeDefined();
    expect(journal.entries.indexOf(termination!)).toBeLessThan(journal.entries.indexOf(ambiguous!));
  });

  it('dispatch whose started session loses to a foreign LIVE session never kills that session\'s worktree tree (PK-1b Luna)', async () => {
    const seed = storedAttempt({ state: 'ended', sessionId: null, revision: 5 });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 2,
      freshAfterConflict: storedAttempt({ state: 'running', sessionId: 'ses_foreign_live', revision: 6 }),
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 5 });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('unknown');
    expect(runner.stopCalls).toHaveLength(1);
    expect(tree.calls).toHaveLength(0);
    expect(journal.entries.some((entry) => (entry.detail ?? '').startsWith('Process tree'))).toBe(false);
  });

  it('dispatch whose started session loses to a foreign state terminates the process tree and journals the ambiguous outcome', async () => {
    const seed = storedAttempt({ state: 'ended', sessionId: null, revision: 5 });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 2,
      freshAfterConflict: storedAttempt({ state: 'ended', sessionId: null, revision: 6 }),
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const tree = makeProcessTreePort({ outcome: 'refused', reason: 'kill script missing' });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
      processTreeTermination: tree.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('started session session-1 was not recorded');
    }
    expect(runner.stopCalls).toHaveLength(1);
    expect(tree.calls).toHaveLength(1);
    expect(tree.calls[0]).toMatchObject({
      attemptId: 'attempt-1',
      worktreePath: '/lanes/attempt-1',
      runner: expect.objectContaining({ kind: 'opencode' }),
      gracePeriodSeconds: 10,
    });
    const ambiguous = journal.entries.filter((entry) => entry.status === 'ambiguous');
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous[0]).toMatchObject({
      action: 'dispatch',
      status: 'ambiguous',
      sessionId: 'session-1',
      detail: 'Process tree termination refused: kill script missing',
    });
    expect(ambiguous[1]).toMatchObject({
      action: 'dispatch',
      status: 'ambiguous',
      sessionId: 'session-1',
    });
  });

  it('collect conflicts with the fresh record still ended: collected is rebuilt and saved, release runs once', async () => {
    const seed = storedAttempt({
      state: 'ended',
      sessionId: 'session-1',
      completionReceipt: completionReceipt(),
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ seed, conflictOnSave: 1 });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const artifacts = makeArtifactPort();
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort: artifacts.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result.outcome).toBe('collected');
    expect(attemptRepo.attempts.get('attempt-1')?.state).toBe('collected');
    expect(journal.releaseCount).toBe(1);
    expect(journal.heldFor('attempt-1')).toBe(false);
  });

  it('collect conflicts with the fresh record no longer ended: refused without release', async () => {
    const seed = storedAttempt({
      state: 'ended',
      sessionId: 'session-1',
      completionReceipt: completionReceipt(),
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: storedAttempt({ state: 'cancelled', revision: 2 }),
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const artifacts = makeArtifactPort();
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort: artifacts.port,
    });

    const result = await useCase.collectAttemptArtifacts(
      validCollectRequest() as Parameters<CollectAttemptArtifactsUseCase['collectAttemptArtifacts']>[0],
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt attempt-1 changed to cancelled while collecting artifacts',
    });
    expect(attemptRepo.attempts.get('attempt-1')?.state).toBe('cancelled');
    expect(journal.releaseCount).toBe(0);
  });

  it('dispatch refused start conflicts with a fresh running record holding a session: no save, no release, refused naming the fresh state', async () => {
    const freshRunning = storedAttempt({
      state: 'running',
      sessionId: 'session-9',
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2, freshAfterConflict: freshRunning });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({
      startResult: { outcome: 'refused', reason: 'no seat available' },
    });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt attempt-1 changed to running while refusing dispatch; capacity not released',
    });
    expect(attemptRepo.saveCalls).toBe(2);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshRunning);
    expect(journal.releaseCount).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
    const refusedEntries = journal.entries.filter((entry) => entry.status === 'refused');
    expect(refusedEntries).toHaveLength(1);
    expect(refusedEntries[0]?.detail).toContain('state running');
  });

  it('dispatch running-save conflicts with a fresh non-authoritative ended record and no session: the started session is stopped, never attached, unknown', async () => {
    const freshEnded = storedAttempt({
      state: 'ended',
      sessionId: null,
      completionReceipt: completionReceipt({ authoritative: false }),
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2, freshAfterConflict: freshEnded });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner(); // default start: started with session-1
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('session-1');
      expect(result.attempt.state).toBe('ended');
    }
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('ended');
    expect(stored?.sessionId).toBeNull();
    expect(stored?.revision).toBe(5);
    expect(runner.stopCalls).toHaveLength(1);
    expect(runner.stopCalls[0]?.sessionId).toBe('session-1');
    const sessionEntries = journal.entries.filter((entry) => entry.sessionId === 'session-1');
    expect(sessionEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatch running-save conflicts with a fresh record holding another session: the started session is stopped, the other session is kept', async () => {
    const freshOther = storedAttempt({
      state: 'running',
      sessionId: 'session-other',
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2, freshAfterConflict: freshOther });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner();
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(runner.stopCalls).toHaveLength(1);
    expect(runner.stopCalls[0]?.sessionId).toBe('session-1');
    expect(result.outcome).toBe('unknown');
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.sessionId).toBe('session-other');
    expect(stored?.state).toBe('running');
    expect(stored?.revision).toBe(5);
  });

  it('stop without an authoritative receipt conflicts with a fresh non-authoritative ended record: no reconciling write', async () => {
    const seed = storedAttempt({ state: 'running' });
    const freshEnded = storedAttempt({
      state: 'ended',
      sessionId: 'session-1',
      completionReceipt: completionReceipt({ authoritative: false }),
      revision: 3,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: freshEnded,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({ stopResult: { outcome: 'unknown', reason: 'receipt lost' } });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(runner.stopCalls).toHaveLength(1);
    expect(result.outcome).toBe('unknown');
    expect(attemptRepo.saveCalls).toBe(1);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshEnded);
    expect(journal.releaseCount).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch running-save conflicts with a fresh record already carrying the started session: no stop, treated as recorded', async () => {
    const freshRecorded = storedAttempt({
      state: 'running',
      sessionId: 'session-1',
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSave: 2,
      freshAfterConflict: freshRecorded,
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner(); // default start: started with session-1
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    expect(runner.startCalls).toHaveLength(1);
    expect(runner.stopCalls).toHaveLength(0);
    expect(attemptRepo.saveCalls).toBe(2);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshRecorded);
    if (result.outcome === 'started') {
      expect(result.attempt).toEqual(freshRecorded);
      expect(result.sessionId).toBe('session-1');
    }
  });

  it('dispatch refused start conflicts with a foreign re-dispatching record: refused, no cancelled save, capacity kept', async () => {
    const freshDispatching = storedAttempt({
      state: 'dispatching',
      sessionId: null,
      dispatchRevision: 99,
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSave: 2,
      freshAfterConflict: freshDispatching,
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({
      startResult: { outcome: 'refused', reason: 'no seat available' },
    });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('re-dispatched concurrently');
    }
    expect(attemptRepo.saveCalls).toBe(2);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshDispatching);
    expect(journal.releaseCount).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch refused start conflicts with a same-writer dispatching record (usage bump): cancelled rebuilt and capacity released', async () => {
    const freshDispatching = storedAttempt({
      state: 'dispatching',
      sessionId: null,
      dispatchRevision: 0,
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSave: 2,
      freshAfterConflict: freshDispatching,
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({
      startResult: { outcome: 'refused', reason: 'no seat available' },
    });
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.startCalls).toHaveLength(1);
    expect(result.outcome).toBe('refused');
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('cancelled');
    expect(stored?.dispatchRevision).toBe(0);
    expect(journal.releaseCount).toBe(1);
    expect(journal.heldFor('attempt-1')).toBe(false);
  });

  it('stop conflicts with a foreign re-dispatching record: capacity kept, record left dispatching, reason mentions re-dispatched', async () => {
    const seed = storedAttempt({ state: 'running' });
    const freshDispatching = storedAttempt({
      state: 'dispatching',
      sessionId: null,
      dispatchRevision: 99,
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      seed,
      conflictOnSave: 1,
      freshAfterConflict: freshDispatching,
    });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const receipt = completionReceipt({ stoppedByRequest: true });
    const runner = makeRunner({ stopResult: { outcome: 'terminated', receipt } });
    const tree = makeProcessTreePort({ outcome: 'terminated', killed: 9 });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port, processTreeTermination: tree.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    // The foreign live session's process tree is not this stop's to kill (PK-1b Argon).
    expect(tree.calls).toHaveLength(0);
    expect(journal.entries.some((entry) => (entry.detail ?? '').startsWith('Process tree'))).toBe(false);
    expect(result.outcome).toBe('terminated');
    if (result.outcome === 'terminated') {
      expect(result.capacityReleased).toBe(false);
      expect(result.reason).toContain('attempt re-dispatched concurrently');
      expect(result.attempt.state).toBe('dispatching');
      expect(result.attempt.sessionId).toBeNull();
    }
    expect(attemptRepo.saveCalls).toBe(1);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshDispatching);
    expect(journal.releaseCount).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('dispatch running-save rebuilt after a conflict returns the stored revision', async () => {
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2 });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner(); // default start: started with session-1
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('running');
    if (result.outcome === 'started') {
      expect(result.attempt.revision).toBe(stored?.revision);
      expect(result.attempt).toEqual(stored);
    }
  });

  it('dispatch running-save conflicts with a foreign re-dispatching record: the session is recorded on it, the result is unknown (never started), no stop', async () => {
    const freshForeign = storedAttempt({
      state: 'dispatching',
      sessionId: null,
      dispatchRevision: 99,
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2, freshAfterConflict: freshForeign });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner();
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('unknown');
    expect(runner.stopCalls).toHaveLength(0);
    const stored = attemptRepo.attempts.get('attempt-1');
    expect(stored?.state).toBe('dispatching');
    expect(stored?.sessionId).toBe('session-1');
    expect(stored?.revision).toBe(6);
    if (result.outcome === 'unknown') {
      expect(result.attempt.sessionId).toBe('session-1');
    }
  });

  it('dispatch running-save conflicts with a terminal record already carrying the started session: no stop, unknown', async () => {
    const freshEndedSame = storedAttempt({
      state: 'ended',
      sessionId: 'session-1',
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ conflictOnSave: 2, freshAfterConflict: freshEndedSame });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner();
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('unknown');
    expect(runner.stopCalls).toHaveLength(0);
    expect(attemptRepo.saveCalls).toBe(2);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshEndedSame);
  });

  it('dispatch second running-save conflict whose winner already recorded the started session: no stop', async () => {
    const freshReconciling = storedAttempt({
      state: 'reconciling',
      sessionId: null,
      revision: 5,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const winnerRunning = storedAttempt({
      state: 'running',
      sessionId: 'session-1',
      revision: 7,
      updatedAtIso: '2026-10-15T08:07:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({
      conflictOnSaves: [2, 3],
      freshAfterConflicts: [freshReconciling, winnerRunning],
    });
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder({ id: 'wo-1', state: 'implementing' }));
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner();
    const workspace = makeWorkspace();
    const observation = makeObservation();
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: workspace.port,
      runner: runner.port,
      observation: observation.port,
    });

    const result = await useCase.dispatchAttempt(
      validDispatchRequest() as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(runner.stopCalls).toHaveLength(0);
    expect(result.outcome).toBe('started');
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(winnerRunning);
  });

  it('stop without an authoritative receipt conflicts with a foreign re-dispatching record: no reconciling write', async () => {
    const seed = storedAttempt({ state: 'running', sessionId: 'session-1', dispatchRevision: 3 });
    const freshForeign = storedAttempt({
      state: 'dispatching',
      sessionId: null,
      dispatchRevision: 9,
      revision: 9,
      updatedAtIso: '2026-10-15T08:06:00.000Z',
    });
    const attemptRepo = makeFailingSaveAttemptRepo({ seed, conflictOnSave: 1, freshAfterConflict: freshForeign });
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
    const runner = makeRunner({ stopResult: { outcome: 'unknown', reason: 'receipt lost' } });
    const useCase = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });

    const result = await useCase.stopAttempt({ attemptId: 'attempt-1' });

    expect(result.outcome).toBe('unknown');
    expect(attemptRepo.saveCalls).toBe(1);
    expect(attemptRepo.attempts.get('attempt-1')).toEqual(freshForeign);
    expect(journal.releaseCount).toBe(0);
  });

  it('canOverwriteAfterConflict allows only the states the transition may start from', () => {
    expect(
      canOverwriteAfterConflict(
        storedAttempt({ state: 'dispatching', dispatchRevision: 1 }),
        ['dispatching'],
        storedAttempt({ state: 'dispatching', dispatchRevision: 1 }),
      ),
    ).toBe(true);
    expect(
      canOverwriteAfterConflict(
        storedAttempt({ state: 'dispatching', dispatchRevision: 2 }),
        ['dispatching'],
        storedAttempt({ state: 'dispatching', dispatchRevision: 1 }),
      ),
    ).toBe(false);
    expect(canOverwriteAfterConflict(storedAttempt({ state: 'dispatching' }), ['dispatching'])).toBe(false);
    expect(canOverwriteAfterConflict(storedAttempt({ state: 'running' }), ['running', 'reconciling'])).toBe(true);
    expect(canOverwriteAfterConflict(storedAttempt({ state: 'ended' }), ['running', 'reconciling'])).toBe(false);
    expect(
      canOverwriteAfterConflict(
        storedAttempt({ state: 'ended', completionReceipt: completionReceipt({ authoritative: true }) }),
        ['running', 'reconciling'],
      ),
    ).toBe(false);
    expect(canOverwriteAfterConflict(storedAttempt({ state: 'cancelled' }), ['dispatching'])).toBe(false);
    expect(canOverwriteAfterConflict(null, ['dispatching'])).toBe(false);
  });
});
