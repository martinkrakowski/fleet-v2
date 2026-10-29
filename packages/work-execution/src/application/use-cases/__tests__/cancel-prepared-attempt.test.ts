/**
 * Unit tests for K4-1: the record-only cancel of a prepared attempt
 * (`CancelPreparedAttemptUseCase`), the dispatch refusal of a `cancelled`
 * record, and the K-GC pin that reconcile moves a session-less
 * `intent-recorded` record to `reconciling` (a state a forced stop can abort
 * by worktree). Fixtures are copied from `seat-plan-dispatch.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import {
  AttemptRevisionConflictError,
} from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
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
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort, WorktreeInspection } from '../../ports/out/WorkspacePort.out-port.js';
import { CancelPreparedAttemptUseCase } from '../CancelPreparedAttemptUseCase.use-case.js';
import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { ReconcileAttemptUseCase } from '../ReconcileAttemptUseCase.use-case.js';
import { StopAttemptUseCase } from '../StopAttemptUseCase.use-case.js';

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

/** A repository whose `saveAttempt` always throws a CAS conflict. */
function makeConflictAttemptRepo(): AttemptRepositoryPort {
  return {
    async saveAttempt() {
      throw new AttemptRevisionConflictError('attempt-1', 0, 1);
    },
    async findAttemptById(attemptId) {
      return attemptId === 'attempt-1' ? storedAttempt({ state: 'intent-recorded', sessionId: null }) : null;
    },
    async listAttemptsByWorkOrder() {
      return [];
    },
    async listAllAttempts() {
      return [];
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

type StartSessionCall = Parameters<ExecutionRunnerPort['startSession']>[0];
type InspectSessionCall = Parameters<ExecutionRunnerPort['inspectSession']>[0];
type StopSessionCall = Parameters<ExecutionRunnerPort['stopSession']>[0];
type InspectWorktreeCall = Parameters<WorkspacePort['inspectWorktree']>[0];

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
    runnerOptions?: Parameters<typeof makeRunner>[0];
    workspaceOptions?: Parameters<typeof makeWorkspace>[0];
  } = {},
) {
  const workOrderRepo = makeWorkOrderRepo();
  workOrderRepo.orders.set(
    'wo-1',
    storedWorkOrder({ id: 'wo-1', state: 'implementing' }),
  );
  const attemptRepo = makeAttemptRepo();
  const journal = makeJournal();
  journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  const runner = makeRunner(options.runnerOptions);
  const workspace = makeWorkspace(options.workspaceOptions);
  const useCase = new DispatchAttemptUseCase({
    workOrderRepo,
    attemptRepo,
    journal,
    workspace: workspace.port,
    runner: runner.port,
  });
  return { workOrderRepo, attemptRepo, journal, runner, workspace, useCase };
}

describe('CancelPreparedAttemptUseCase', () => {
  it('cancels an intent-recorded attempt with a held reservation and releases capacity', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ state: 'intent-recorded', sessionId: null, revision: 0 }),
    );
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation());
    const useCase = new CancelPreparedAttemptUseCase({ attemptRepo, journal });

    const result = await useCase.cancelPreparedAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });

    expect(result.outcome).toBe('cancelled');
    if (result.outcome === 'cancelled') {
      expect(result.capacity).toBe('released');
      expect(result.attempt.state).toBe('cancelled');
      expect(result.attempt.outcome).toBe('stopped');
      expect(result.attempt.revision).toBe(1);
    }
    const stored = attemptRepo.attempts.get('attempt-1')!;
    expect(stored.state).toBe('cancelled');
    expect(stored.outcome).toBe('stopped');
    expect(stored.revision).toBe(1);
    expect(journal.entries).toHaveLength(1);
    const entry = journal.entries[0]!;
    expect(entry.action).toBe('stop');
    expect(entry.status).toBe('completed');
    expect(entry.sessionId).toBeNull();
    expect(entry.detail).toBe('Record-only cancel of an attempt that was never dispatched; capacity released');
    expect(journal.heldFor('attempt-1')).toBe(false);
  });

  it('reports none-held with no reservation and held when the release is refused', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ state: 'intent-recorded', sessionId: null, revision: 0 }),
    );
    const journal = makeJournal();
    const useCase = new CancelPreparedAttemptUseCase({ attemptRepo, journal });

    const result = await useCase.cancelPreparedAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });
    expect(result.outcome).toBe('cancelled');
    if (result.outcome === 'cancelled') {
      expect(result.capacity).toBe('none-held');
    }
  });

  it('reports held when a held reservation refuses release', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ state: 'intent-recorded', sessionId: null, revision: 0 }),
    );
    const journal = makeJournal();
    journal.reservations.set('res-1', storedReservation());
    journal.releaseCapacityReservation = async () => false;
    const useCase = new CancelPreparedAttemptUseCase({ attemptRepo, journal });

    const result = await useCase.cancelPreparedAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });
    expect(result.outcome).toBe('cancelled');
    if (result.outcome === 'cancelled') {
      expect(result.capacity).toBe('held');
    }
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('refuses a record that is not intent-recorded and writes nothing', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'dispatching', sessionId: null }));
    const journal = makeJournal();
    const useCase = new CancelPreparedAttemptUseCase({ attemptRepo, journal });

    const result = await useCase.cancelPreparedAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'not-prepared' });
    const stored = attemptRepo.attempts.get('attempt-1')!;
    expect(stored.state).toBe('dispatching');
    expect(journal.entries).toHaveLength(0);
    expect(journal.releaseCount).toBe(0);
  });

  it('refuses a missing attempt', async () => {
    const attemptRepo = makeAttemptRepo();
    const journal = makeJournal();
    const useCase = new CancelPreparedAttemptUseCase({ attemptRepo, journal });

    const result = await useCase.cancelPreparedAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'attempt-missing' });
    expect(journal.entries).toHaveLength(0);
    expect(journal.releaseCount).toBe(0);
  });

  it('refuses changed when the CAS save conflicts and writes nothing', async () => {
    const attemptRepo = makeConflictAttemptRepo();
    const journal = makeJournal();
    const useCase = new CancelPreparedAttemptUseCase({ attemptRepo, journal });

    const result = await useCase.cancelPreparedAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'changed' });
    expect(journal.entries).toHaveLength(0);
    expect(journal.releaseCount).toBe(0);
  });
});

describe('DispatchAttemptUseCase', () => {
  it('refuses a cancelled attempt with its own text and writes nothing', async () => {
    const { attemptRepo, journal, runner, useCase } = makeDispatchSetup();
    attemptRepo.attempts.set('attempt-1', storedAttempt({ state: 'cancelled', sessionId: null }));

    const result = await useCase.dispatchAttempt(validDispatchRequest());

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('Attempt attempt-1 is cancelled and is never dispatched again; prepare a new attempt');
    }
    expect(journal.entries).toHaveLength(0);
    expect(runner.startCalls).toHaveLength(0);
    const stored = attemptRepo.attempts.get('attempt-1')!;
    expect(stored.state).toBe('cancelled');
  });

  it.each(['dispatching', 'running', 'reconciling', 'blocked'])(
    'still refuses a %s attempt with the claim-state text',
    async (state) => {
      const { attemptRepo, journal, runner, useCase } = makeDispatchSetup();
      attemptRepo.attempts.set('attempt-1', storedAttempt({ state: state as AttemptRecord['state'] }));

      const result = await useCase.dispatchAttempt(validDispatchRequest());

      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') {
        expect(result.reason).toBe(
          `Attempt attempt-1 is ${state}; run 'attempt reconcile' (it resolves an attempt with no recorded session by inspecting its worktree) or 'attempt stop' before dispatching again`,
        );
      }
      expect(journal.entries).toHaveLength(0);
      expect(runner.startCalls).toHaveLength(0);
    },
  );
});

describe('K-GC pin', () => {
  it('reconcile moves a session-less intent-recorded record to reconciling, and stop aborts its worktree', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({ state: 'intent-recorded', sessionId: null, revision: 0 }),
    );
    const journal = makeJournal();
    const runner = makeRunner();

    const reconcile = new ReconcileAttemptUseCase({ attemptRepo, journal, runner: runner.port });
    const reconcileResult = await reconcile.reconcileAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });

    expect(reconcileResult.outcome).toBe('unknown');
    const stored = attemptRepo.attempts.get('attempt-1')!;
    expect(stored.state).toBe('reconciling');
    expect(runner.inspectCalls).toHaveLength(0);
    expect(runner.inspectWorktreeCalls).toHaveLength(0);

    const stop = new StopAttemptUseCase({ attemptRepo, journal, runner: runner.port });
    const stopResult = await stop.stopAttempt({
      attemptId: 'attempt-1',
      nowIso: '2026-10-15T08:00:00.000Z',
    });

    expect(stopResult.outcome).toBe('cancelled');
    expect(runner.abortWorktreeCalls).toHaveLength(1);
  });
});
