/**
 * Unit tests for lane AG-3: the held reservation's seat tool chooses the
 * runner at dispatch. An `agy` reservation dispatches through the new
 * `agyRunner` dependency (refused as `runner-not-available` without it), the
 * frozen brief's seat tool must match the reservation's, an agy runner needs
 * no port, and the record carries the runner's own kind. Fixtures are copied
 * from `seat-plan-dispatch.test.ts`.
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
import type {
  ExecutionJournalPort,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionStatus,
  StartRunnerSessionResult,
  StopRunnerSessionResult,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort, WorktreeInspection } from '../../ports/out/WorkspacePort.out-port.js';
import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';

const FAKE_BRIEF_PROSE = '# Frozen brief prose';

type StartSessionCall = Parameters<ExecutionRunnerPort['startSession']>[0];

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
} {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  const journalState: ExecutionJournalPort & {
    entries: ActionJournalEntryRecord[];
    reservations: Map<string, CapacityReservationRecord>;
  } = {
    entries,
    reservations,
    async appendJournalEntry(entry) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async saveCapacityReservation(reservation) {
      reservations.set(reservation.id, reservation);
    },
    async listActiveReservations() {
      return [...reservations.values()].filter((reservation) => reservation.held);
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
    async reserveCapacityAtomically() {
      throw new Error('reserveCapacityAtomically must not be called');
    },
  };
  return journalState;
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

function makeRunner(
  options: {
    capabilities?: Partial<RunnerIsolationCapabilities>;
    startResult?: StartRunnerSessionResult;
    inspectStatus?: RunnerSessionStatus;
    stopResult?: StopRunnerSessionResult;
    describeRunner?: () => AttemptRunnerRecord | undefined;
    sessionId?: string;
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
      return options.startResult ?? { outcome: 'started', sessionId: options.sessionId ?? 'session-1' };
    },
    async inspectSession() {
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
      void request;
      return options.stopResult ?? { outcome: 'still-running', reason: 'grace period elapsed' };
    },
  };
  return { port, startCalls };
}

/** The agy fake: `describeRunner` reports the agy kind with no port. */
function makeAgyRunner() {
  return makeRunner({
    describeRunner: () => ({
      kind: 'agy',
      remotePort: null,
      host: null,
      agent: null,
      model: null,
      variant: null,
    }),
    sessionId: 'conv-example-1',
  });
}

function makeWorkspace(manifestRaw: string) {
  const calls: Parameters<WorkspacePort['inspectWorktree']>[0][] = [];
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
      } satisfies WorktreeInspection;
    },
    readWorktreeFile: async (_worktreePath, relativePath) =>
      relativePath === '.lane/brief-manifest.json' ? manifestRaw : FAKE_BRIEF_PROSE,
  };
  return { port, calls };
}

function validDispatchRequest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/lanes/attempt-1',
    briefPackagePath: '.lane/brief.md',
    briefDigest: '',
    baseCommit: 'abc123',
    stepLimit: 40,
    timeLimitSeconds: 3600,
    expectedArtifacts: ['dist/report.json'],
    nowIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function dispatchManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelAssignment: {
      model: 'gemini-example-high',
      seatTool: 'agy',
    },
    independentReviewer: 'acme/grok-4.7',
    ...overrides,
  };
}

function makeDispatchSetup(options: {
  reservationSeatTool?: CapacityReservationRecord['seatTool'];
  manifest?: Record<string, unknown>;
  withAgyRunner?: boolean;
  opencodeDescribeRunner?: () => AttemptRunnerRecord | undefined;
}) {
  const manifest = options.manifest ?? dispatchManifest();
  const manifestRaw = JSON.stringify(manifest);
  const digest = simpleDeterministicHexDigest(FAKE_BRIEF_PROSE + '\n' + manifestRaw);
  const workOrderRepo = makeWorkOrderRepo();
  workOrderRepo.orders.set('wo-1', storedWorkOrder());
  const attemptRepo = makeAttemptRepo();
  const journal = makeJournal();
  journal.reservations.set(
    'res-1',
    storedReservation({
      id: 'res-1',
      attemptId: 'attempt-1',
      ...(options.reservationSeatTool === undefined
        ? { seatTool: 'agy' as const }
        : { seatTool: options.reservationSeatTool }),
    }),
  );
  const opencode = makeRunner({
    describeRunner: options.opencodeDescribeRunner,
  });
  const agy = makeAgyRunner();
  const workspace = makeWorkspace(manifestRaw);
  const useCase = new DispatchAttemptUseCase({
    workOrderRepo,
    attemptRepo,
    journal,
    workspace: workspace.port,
    runner: opencode.port,
    ...(options.withAgyRunner === false ? {} : { agyRunner: agy.port }),
  });
  const request = validDispatchRequest({ briefDigest: digest });
  return { attemptRepo, journal, opencode, agy, workspace, useCase, request };
}

describe('DispatchAttemptUseCase: the reservation seat tool chooses the runner (AG-3)', () => {
  it('dispatches an agy reservation through the agy runner and records its kind', async () => {
    const setup = makeDispatchSetup({ reservationSeatTool: 'agy' });
    const result = await setup.useCase.dispatchAttempt(setup.request);
    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    expect(result.sessionId).toBe('conv-example-1');
    expect(setup.agy.startCalls).toHaveLength(1);
    expect(setup.opencode.startCalls).toHaveLength(0);
    expect(result.attempt.runner?.kind).toBe('agy');
    expect(result.attempt.runner?.remotePort).toBe(null);
    expect(setup.attemptRepo.attempts.get('attempt-1')?.runner?.kind).toBe('agy');
  });

  it('refuses an agy reservation as runner-not-available without an agy runner and writes nothing', async () => {
    const setup = makeDispatchSetup({ reservationSeatTool: 'agy', withAgyRunner: false });
    const result = await setup.useCase.dispatchAttempt(setup.request);
    expect(result).toEqual({ outcome: 'refused', reason: 'runner-not-available' });
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.attemptRepo.attempts.size).toBe(0);
  });

  it('refuses when the frozen brief seat tool does not match the reservation seat tool', async () => {
    const setup = makeDispatchSetup({
      reservationSeatTool: 'agy',
      manifest: dispatchManifest({
        modelAssignment: { model: 'gemini-example-high', seatTool: 'opencode' },
      }),
    });
    const result = await setup.useCase.dispatchAttempt(setup.request);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Frozen brief seat tool does not match the reservation seat tool',
    });
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.attemptRepo.attempts.size).toBe(0);
  });

  it('runs the opencode runner for an opencode reservation even with an agy runner wired', async () => {
    const setup = makeDispatchSetup({
      reservationSeatTool: 'opencode',
      manifest: dispatchManifest({
        modelAssignment: { model: 'nvidia/z-ai/glm-5.3', seatTool: 'opencode' },
      }),
    });
    const result = await setup.useCase.dispatchAttempt(setup.request);
    expect(result.outcome).toBe('started');
    expect(setup.opencode.startCalls).toHaveLength(1);
    expect(setup.agy.startCalls).toHaveLength(0);
    if (result.outcome !== 'started') return;
    expect(result.attempt.runner?.kind).toBe('opencode');
  });

  it('runs the opencode runner for a legacy reservation with a null seat tool', async () => {
    const setup = makeDispatchSetup({
      reservationSeatTool: null,
      manifest: dispatchManifest({
        modelAssignment: { model: 'nvidia/z-ai/glm-5.3', seatTool: 'opencode' },
      }),
    });
    const result = await setup.useCase.dispatchAttempt(setup.request);
    expect(result.outcome).toBe('started');
    expect(setup.opencode.startCalls).toHaveLength(1);
    expect(setup.agy.startCalls).toHaveLength(0);
  });

  it('keeps refusing an opencode runner that describes no port', async () => {
    const setup = makeDispatchSetup({
      reservationSeatTool: 'opencode',
      manifest: dispatchManifest({
        modelAssignment: { model: 'nvidia/z-ai/glm-5.3', seatTool: 'opencode' },
      }),
      opencodeDescribeRunner: () => ({
        kind: 'opencode',
        remotePort: null,
        host: null,
        agent: null,
        model: 'nvidia/z-ai/glm-5.3',
        variant: 'default',
      }),
    });
    const result = await setup.useCase.dispatchAttempt(setup.request);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'No runner port can be described for dispatch',
    });
  });

  it('inspects the worktree with the recorded host of the agy runner', async () => {
    const setup = makeDispatchSetup({ reservationSeatTool: 'agy' });
    await setup.useCase.dispatchAttempt(setup.request);
    expect(setup.workspace.calls).toHaveLength(1);
    expect(setup.workspace.calls[0]?.recordedHost?.kind).toBe('agy');
    expect(setup.workspace.calls[0]?.recordedHost?.remotePort).toBe(null);
  });
});
