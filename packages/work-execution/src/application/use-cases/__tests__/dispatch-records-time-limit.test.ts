/**
 * Unit tests for lane SEC-5c-1: dispatch records the time limit it started
 * the session with (`dispatchedTimeLimitSeconds`). Fixtures are copied from
 * `seat-plan-dispatch.test.ts`; `makeAttemptRepo` keeps only the latest
 * record, so `saveAttempt` is wrapped with a log of every call.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
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
import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';

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

function makeAttemptRepo(): AttemptRepositoryPort & {
  attempts: Map<string, AttemptRecord>;
  saved: AttemptRecord[];
} {
  const attempts = new Map<string, AttemptRecord>();
  const saved: AttemptRecord[] = [];
  return {
    attempts,
    saved,
    async saveAttempt(record) {
      saved.push(record);
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
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-0',
    laneId: 'lane-prior',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/prior/**'],
    policyRevision: 'policy-7',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
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

describe('DispatchAttemptUseCase records the session time limit (SEC-5c-1)', () => {
  it('records dispatchedTimeLimitSeconds 2700 on the dispatching and running records', async () => {
    const setup = makeDispatchSetup();
    const result = await setup.useCase.dispatchAttempt(validDispatchRequest({ timeLimitSeconds: 2700 }));

    expect(result.outcome).toBe('started');
    expect(setup.attemptRepo.saved).toHaveLength(2);
    const [dispatching, running] = setup.attemptRepo.saved;
    expect(dispatching.dispatchedTimeLimitSeconds).toBe(2700);
    expect(running.dispatchedTimeLimitSeconds).toBe(2700);
    expect(setup.attemptRepo.attempts.get('attempt-1')?.dispatchedTimeLimitSeconds).toBe(2700);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
  ])('does not record a dispatchedTimeLimitSeconds for %s', async (_label, timeLimitSeconds) => {
    const setup = makeDispatchSetup();
    const result = await setup.useCase.dispatchAttempt(validDispatchRequest({ timeLimitSeconds }));

    expect(result.outcome).toBe('started');
    expect(setup.runner.startCalls).toHaveLength(1);
    expect(setup.attemptRepo.saved).toHaveLength(2);
    for (const record of setup.attemptRepo.saved) {
      expect(Object.hasOwn(record, 'dispatchedTimeLimitSeconds')).toBe(false);
    }
    const stored = setup.attemptRepo.attempts.get('attempt-1');
    expect(Object.hasOwn(stored ?? {}, 'dispatchedTimeLimitSeconds')).toBe(false);
  });

  it('a re-dispatch with an unrecordable limit drops a stale dispatchedTimeLimitSeconds', async () => {
    const setup = makeDispatchSetup();
    setup.attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({
        id: 'attempt-1',
        state: 'collected',
        dispatchedTimeLimitSeconds: 2700,
      }),
    );

    const result = await setup.useCase.dispatchAttempt(validDispatchRequest({ timeLimitSeconds: 0 }));

    expect(result.outcome).toBe('started');
    const [dispatching] = setup.attemptRepo.saved;
    expect(Object.hasOwn(dispatching, 'dispatchedTimeLimitSeconds')).toBe(false);
    const stored = setup.attemptRepo.attempts.get('attempt-1');
    expect(Object.hasOwn(stored ?? {}, 'dispatchedTimeLimitSeconds')).toBe(false);
  });
});

describe('attempt record round-trip without the field (regression, SEC-5c-1)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-time-limit-roundtrip-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('passes before and after: a record written without the field round-trips through the file-backed adapter without gaining it', async () => {
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await adapter.saveAttempt(storedAttempt({ id: 'attempt-roundtrip' }));

    const loaded = await adapter.findAttemptById('attempt-roundtrip');
    expect(loaded).not.toBeNull();
    expect(Object.hasOwn(loaded ?? {}, 'dispatchedTimeLimitSeconds')).toBe(false);
  });
});
