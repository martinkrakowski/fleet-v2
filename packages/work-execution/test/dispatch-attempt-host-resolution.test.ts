/**
 * G1 tests: `DispatchAttemptUseCase.dispatchAttempt` resolves a reservation
 * held on a second lane-runner host through a wired `runnerForHost`, and
 * keeps the single-host H9a/H9b/H10 refusal byte-for-byte whenever the
 * resolved runner cannot prove the reservation's own host. Every refusal
 * fires before any journal write (and before `inspectWorktree` for the
 * pre-inspection host and runner refusals) and never falls back to the
 * composed runner; every test title states what it asserts.
 *
 * Mutation note (see the brief): production code is never broken or edited
 * to prove these tests. Each line below instead names the single production
 * line whose change would make the named test fail
 * (all in `DispatchAttemptUseCase.use-case.ts`):
 * - "refuses reservation on runner-b with existing reason and no journal
 *   write when runnerForHost is absent" — the guarded-branch return
 *   `return { outcome: 'refused', reason: mismatchReason };` made to fall
 *   through (the dispatch would proceed on the composed runner-a).
 * - "refuses reservation on runner-b with existing reason and no journal
 *   write when runnerForHost returns null" — the line
 *   `resolvedHostName = resolvedRunner?.describeRunner?.()?.hostName ?? null;`
 *   replaced with `resolvedHostName = reservationHostName;` (a null answer
 *   would then be dispatched and crash on `describeCapabilities`).
 * - "refuses with zero inspectWorktree calls when runnerForHost returns
 *   wrong host or no description" — the identity comparison
 *   `resolvedHostName !== reservationHostName` replaced with `false`.
 * - "refuses with zero inspectWorktree calls when runnerForHost throws" —
 *   the catch block's `return { outcome: 'refused', reason: mismatchReason };`
 *   replaced with a rethrow.
 * - "never calls runnerForHost when composed runner has null hostName" —
 *   the guard clause `runnerHostName === null ||` replaced with `false`.
 * - "never calls runnerForHost for an agy reservation" (runner-not-available
 *   sub-case) — `if (composedRunner === undefined)` replaced with `if (false)`;
 *   (mismatch and dispatch sub-cases) — the line
 *   `const composedRunner = reservedTool === 'agy' ? this.deps.agyRunner : this.deps.runner;`
 *   replaced with `const composedRunner = this.deps.runner;`.
 * - "uses composed runner and never calls runnerForHost when reservation
 *   host matches runner-a" — the outer condition
 *   `reservationHostName !== null && reservationHostName !== runnerHostName`
 *   replaced with `true` (a matching reservation would then refuse).
 * - "dispatches reservation on runner-b through runnerForHost and records
 *   runner-b hostName and port" — the assignment `runner = resolvedRunner;`
 *   removed (the dispatch would stay on the composed runner-a).
 * - "refuses when resolved runner-b runner describes null remotePort" —
 *   `if (!runnerInfo || (runnerInfo.kind !== 'agy' && runnerInfo.remotePort === null))`
 *   replaced with `if (false)`.
 * - "refuses when resolved runner-b runner lacks required isolation
 *   capabilities" — `if (capabilitiesMissing)` replaced with `if (false)`.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  AttemptRunnerRecord,
  WorkOrderRecord,
} from '../src/domain/execution-records.js';
import type { AttemptRepositoryPort } from '../src/application/ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../src/application/ports/out/ExecutionJournalPort.out-port.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
} from '../src/application/ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../src/application/ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  WorkspacePort,
  WorktreeInspection,
  WorktreeInspectionRequest,
} from '../src/application/ports/out/WorkspacePort.out-port.js';
import { DispatchAttemptUseCase } from '../src/application/use-cases/DispatchAttemptUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../src/application/use-cases/PrepareBriefPackageUseCase.use-case.js';

const BASE = 'a'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const NOW = '2026-11-20T10:00:00.000Z';
const PROSE = '# Task\n\nImplement the change.\n';

function manifestJson(seatTool: 'opencode' | 'agy'): string {
  return JSON.stringify({
    workOrderId: 'wo-1',
    modelAssignment: { model: 'model-example-1', seatTool },
    allowedPathPrefixes: ['packages/example/src'],
    ownerDecisionReferences: [],
  });
}

function manifestDigest(seatTool: 'opencode' | 'agy'): string {
  return simpleDeterministicHexDigest(PROSE + '\n' + manifestJson(seatTool));
}

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

function makeJournal(): ExecutionJournalPort & { entries: ActionJournalEntryRecord[] } {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  return {
    entries,
    async appendJournalEntry(entry) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async saveCapacityReservation(savedReservation) {
      reservations.set(savedReservation.id, savedReservation);
    },
    async listActiveReservations() {
      return [...reservations.values()].filter((entry) => entry.held);
    },
    async releaseCapacityReservation(attemptId, releasedAtIso) {
      for (const [id, entry] of reservations) {
        if (entry.attemptId === attemptId && entry.held) {
          reservations.set(id, { ...entry, held: false, releasedAtIso });
          return true;
        }
      }
      return false;
    },
    async reserveCapacityAtomically() {
      return { outcome: 'no-free-slot', heldCount: 0, maxSlots: 0 };
    },
  };
}

function makeWorkOrderRepo(): WorkOrderRepositoryPort {
  const order: WorkOrderRecord = {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: BASE,
    ownedPaths: ['packages/example/src/**'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
  return {
    async saveWorkOrder() {},
    async findWorkOrderById(workOrderId) {
      return workOrderId === 'wo-1' ? order : null;
    },
    async listWorkOrdersByProject() {
      return [order];
    },
  };
}

type StartSessionCall = Parameters<ExecutionRunnerPort['startSession']>[0];

function makeRunner(
  describe: (() => AttemptRunnerRecord | undefined) | undefined,
  capabilitiesOverride: Partial<RunnerIsolationCapabilities> = {},
): {
  port: ExecutionRunnerPort;
  startCalls: StartSessionCall[];
} {
  const capabilities: RunnerIsolationCapabilities = {
    filesystemScope: 'scoped-worktree',
    networkEgressRestricted: true,
    cpuAndMemoryLimited: true,
    processTreeTermination: true,
    authoritativeCompletion: true,
    artifactPersistence: true,
    ...capabilitiesOverride,
  };
  const startCalls: StartSessionCall[] = [];
  const port: ExecutionRunnerPort = {
    describeCapabilities: () => capabilities,
    ...(describe !== undefined ? { describeRunner: describe } : {}),
    async startSession(request) {
      startCalls.push(request);
      return { outcome: 'started', sessionId: 'session-1' };
    },
    async inspectSession() {
      throw new Error('inspectSession must never run in these tests');
    },
    async stopSession() {
      throw new Error('stopSession must never run in these tests');
    },
  };
  return { port, startCalls };
}

const RUNNER_A_RECORD: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: null,
  hostName: 'runner-a',
  agent: null,
  model: 'model-example-1',
  variant: null,
};

const LEGACY_RUNNER_RECORD: AttemptRunnerRecord = {
  ...RUNNER_A_RECORD,
  hostName: null,
};

const RUNNER_B_RECORD: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4266,
  host: 'runner-b-host',
  hostName: 'runner-b',
  agent: null,
  model: 'model-example-1',
  variant: null,
};

const AGY_RUNNER_B_RECORD: AttemptRunnerRecord = {
  kind: 'agy',
  remotePort: null,
  host: null,
  hostName: 'runner-b',
  agent: null,
  model: null,
  variant: null,
};

function makeWorkspace(seatTool: 'opencode' | 'agy'): {
  port: WorkspacePort;
  inspectCalls: WorktreeInspectionRequest[];
} {
  const manifest = manifestJson(seatTool);
  const inspectCalls: WorktreeInspectionRequest[] = [];
  const port: WorkspacePort = {
    async inspectWorktree(request) {
      inspectCalls.push(request);
      const inspection: WorktreeInspection = {
        worktreePath: request.worktreePath,
        checkedOutCommit: request.baseCommit,
        matchesBaseCommit: true,
        uncommittedPaths: [],
        untrackedPaths: [],
        residueFromEarlierAttempts: [],
        missingExpectedArtifacts: [],
      };
      return inspection;
    },
    async readWorktreeFile(_worktreePath, relativePath) {
      return relativePath === '.lane/brief-manifest.json' ? manifest : PROSE;
    },
  };
  return { port, inspectCalls };
}

interface Setup {
  attemptRepo: AttemptRepositoryPort & { saved: AttemptRecord[] };
  journal: ExecutionJournalPort & { entries: ActionJournalEntryRecord[] };
  useCase: DispatchAttemptUseCase;
  runnerA: { port: ExecutionRunnerPort; startCalls: StartSessionCall[] };
  agyRunner: { port: ExecutionRunnerPort; startCalls: StartSessionCall[] } | undefined;
  workspace: { port: WorkspacePort; inspectCalls: WorktreeInspectionRequest[] };
  runnerForHostCalls: string[];
}

function makeSetup(options: {
  seatTool?: 'opencode' | 'agy';
  reservationHostName?: string | null;
  /** The raw answer of the wired `runnerForHost`; absent wires nothing. */
  runnerForHost?: (hostName: string) => ExecutionRunnerPort | null;
  /** The composed runner's own description; defaults to runner-a. */
  runnerARecord?: AttemptRunnerRecord;
  /** The agy runner's own description; absence wires no agyRunner. */
  agyRunnerRecord?: AttemptRunnerRecord;
}): Setup {
  const seatTool = options.seatTool ?? 'opencode';
  const attemptRepo = makeAttemptRepo();
  const journal = makeJournal();
  journal.saveCapacityReservation({
    id: 'res-1',
    attemptId: 'attempt-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool,
    hostName: options.reservationHostName ?? null,
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
  const runnerA = makeRunner(() => options.runnerARecord ?? RUNNER_A_RECORD);
  const agyRunner =
    options.agyRunnerRecord !== undefined ? makeRunner(() => options.agyRunnerRecord) : undefined;
  const workspace = makeWorkspace(seatTool);
  const runnerForHostCalls: string[] = [];
  const runnerForHost =
    options.runnerForHost === undefined
      ? undefined
      : (hostName: string) => {
          runnerForHostCalls.push(hostName);
          return options.runnerForHost!(hostName);
        };
  const useCase = new DispatchAttemptUseCase({
    workOrderRepo: makeWorkOrderRepo(),
    attemptRepo,
    journal,
    workspace: workspace.port,
    runner: runnerA.port,
    ...(agyRunner !== undefined ? { agyRunner: agyRunner.port } : {}),
    ...(runnerForHost !== undefined ? { runnerForHost } : {}),
  });
  return { attemptRepo, journal, useCase, runnerA, agyRunner, workspace, runnerForHostCalls };
}

function dispatchRequest(briefDigest: string, overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: WORKTREE,
    briefPackagePath: '.lane/brief.md',
    briefDigest,
    baseCommit: BASE,
    stepLimit: 40,
    timeLimitSeconds: 3600,
    nowIso: NOW,
    ...overrides,
  };
}

type DispatchResult = Awaited<ReturnType<DispatchAttemptUseCase['dispatchAttempt']>>;

function expectRefusal(result: DispatchResult, reason: string): void {
  expect(result.outcome).toBe('refused');
  if (result.outcome !== 'refused') {
    throw new Error('unreachable');
  }
  expect(result.reason).toBe(reason);
}

describe('DispatchAttemptUseCase per-reservation-host runner resolution', () => {
  it('refuses reservation on runner-b with existing reason and no journal write when runnerForHost is absent', async () => {
    const setup = makeSetup({ reservationHostName: 'runner-b' });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(
      result,
      'Reservation host runner-b is not the configured runner host runner-a; several lane-runner hosts need H9b/H10',
    );
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.workspace.inspectCalls).toHaveLength(0);
    expect(setup.runnerA.startCalls).toHaveLength(0);
  });

  it('refuses reservation on runner-b with existing reason and no journal write when runnerForHost returns null', async () => {
    const setup = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: () => null,
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(
      result,
      'Reservation host runner-b is not the configured runner host runner-a; several lane-runner hosts need H9b/H10',
    );
    expect(setup.runnerForHostCalls).toEqual(['runner-b']);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.workspace.inspectCalls).toHaveLength(0);
    expect(setup.runnerA.startCalls).toHaveLength(0);
  });

  it('refuses with zero inspectWorktree calls when runnerForHost returns wrong host or no description', async () => {
    // A resolved runner that still describes runner-a fails the identity check.
    const wrongHost = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: () => makeRunner(() => RUNNER_A_RECORD).port,
    });
    const wrongHostResult = await wrongHost.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(
      wrongHostResult,
      'Reservation host runner-b is not the configured runner host runner-a; several lane-runner hosts need H9b/H10',
    );
    expect(wrongHost.runnerForHostCalls).toEqual(['runner-b']);
    expect(wrongHost.journal.entries).toHaveLength(0);
    expect(wrongHost.workspace.inspectCalls).toHaveLength(0);
    expect(wrongHost.runnerA.startCalls).toHaveLength(0);

    // A resolved runner without any description also fails the identity check.
    const noDescription = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: () => makeRunner(undefined).port,
    });
    const noDescriptionResult = await noDescription.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(
      noDescriptionResult,
      'Reservation host runner-b is not the configured runner host runner-a; several lane-runner hosts need H9b/H10',
    );
    expect(noDescription.runnerForHostCalls).toEqual(['runner-b']);
    expect(noDescription.journal.entries).toHaveLength(0);
    expect(noDescription.workspace.inspectCalls).toHaveLength(0);
    expect(noDescription.runnerA.startCalls).toHaveLength(0);
  });

  it('refuses with zero inspectWorktree calls when runnerForHost throws', async () => {
    const setup = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: () => {
        throw new Error('resolver failure');
      },
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(
      result,
      'Reservation host runner-b is not the configured runner host runner-a; several lane-runner hosts need H9b/H10',
    );
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.workspace.inspectCalls).toHaveLength(0);
    expect(setup.runnerA.startCalls).toHaveLength(0);
  });

  it('never calls runnerForHost when composed runner has null hostName', async () => {
    const setup = makeSetup({
      reservationHostName: 'runner-b',
      runnerARecord: LEGACY_RUNNER_RECORD,
      runnerForHost: () => makeRunner(() => RUNNER_B_RECORD).port,
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(
      result,
      'Reservation host runner-b is not the configured runner host null; several lane-runner hosts need H9b/H10',
    );
    expect(setup.runnerForHostCalls).toEqual([]);
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.workspace.inspectCalls).toHaveLength(0);
    expect(setup.runnerA.startCalls).toHaveLength(0);
  });

  it('never calls runnerForHost for an agy reservation', async () => {
    // No agy runner wired: the runner-not-available refusal, before any host work.
    const absent = makeSetup({
      seatTool: 'agy',
      reservationHostName: 'runner-b',
      runnerForHost: () => makeRunner(() => RUNNER_B_RECORD).port,
    });
    const absentResult = await absent.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('agy')),
    );
    expectRefusal(absentResult, 'runner-not-available');
    expect(absent.runnerForHostCalls).toEqual([]);
    expect(absent.journal.entries).toHaveLength(0);
    expect(absent.workspace.inspectCalls).toHaveLength(0);
    expect(absent.runnerA.startCalls).toHaveLength(0);

    // Agy runner on runner-a: the host-mismatch refusal, without runnerForHost.
    const mismatch = makeSetup({
      seatTool: 'agy',
      reservationHostName: 'runner-b',
      agyRunnerRecord: RUNNER_A_RECORD,
      runnerForHost: () => makeRunner(() => RUNNER_B_RECORD).port,
    });
    const mismatchResult = await mismatch.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('agy')),
    );
    expectRefusal(
      mismatchResult,
      'Reservation host runner-b is not the configured runner host runner-a; several lane-runner hosts need H9b/H10',
    );
    expect(mismatch.runnerForHostCalls).toEqual([]);
    expect(mismatch.journal.entries).toHaveLength(0);
    expect(mismatch.workspace.inspectCalls).toHaveLength(0);
    expect(mismatch.runnerA.startCalls).toHaveLength(0);
    expect(mismatch.agyRunner!.startCalls).toHaveLength(0);

    // Agy runner already on runner-b: it dispatches, still without runnerForHost.
    const matching = makeSetup({
      seatTool: 'agy',
      reservationHostName: 'runner-b',
      agyRunnerRecord: AGY_RUNNER_B_RECORD,
      runnerForHost: () => null,
    });
    const matchingResult = await matching.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('agy')),
    );
    expect(matchingResult.outcome).toBe('started');
    expect(matching.runnerForHostCalls).toEqual([]);
    expect(matching.agyRunner!.startCalls).toHaveLength(1);
    expect(matching.runnerA.startCalls).toHaveLength(0);
  });

  it('uses composed runner and never calls runnerForHost when reservation host matches runner-a', async () => {
    const setup = makeSetup({
      reservationHostName: 'runner-a',
      runnerForHost: () => null,
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expect(result.outcome).toBe('started');
    expect(setup.runnerForHostCalls).toEqual([]);
    expect(setup.runnerA.startCalls).toHaveLength(1);
  });

  it('dispatches reservation on runner-b through runnerForHost and records runner-b hostName and port', async () => {
    const runnerB = makeRunner(() => RUNNER_B_RECORD);
    const setup = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: (hostName) => (hostName === 'runner-b' ? runnerB.port : null),
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expect(result.outcome).toBe('started');
    expect(runnerB.startCalls).toHaveLength(1);
    expect(setup.runnerA.startCalls).toHaveLength(0);
    expect(setup.workspace.inspectCalls).toHaveLength(1);
    expect(setup.workspace.inspectCalls[0]!.recordedHost?.hostName).toBe('runner-b');
    const saved = setup.attemptRepo.saved[setup.attemptRepo.saved.length - 1]!;
    expect(saved.runner?.hostName).toBe('runner-b');
    expect(saved.runner?.remotePort).toBe(4266);
    expect(saved.runner?.host).toBe('runner-b-host');
  });

  it('refuses when resolved runner-b runner describes null remotePort', async () => {
    const runnerB = makeRunner(() => ({ ...RUNNER_B_RECORD, remotePort: null }));
    const setup = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: (hostName) => (hostName === 'runner-b' ? runnerB.port : null),
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(result, 'No runner port can be described for dispatch');
    expect(setup.journal.entries).toHaveLength(0);
    expect(runnerB.startCalls).toHaveLength(0);
    expect(setup.runnerA.startCalls).toHaveLength(0);
  });

  it('refuses when resolved runner-b runner lacks required isolation capabilities', async () => {
    const runnerB = makeRunner(() => RUNNER_B_RECORD, {
      filesystemScope: 'inherited-directory',
    });
    const setup = makeSetup({
      reservationHostName: 'runner-b',
      runnerForHost: (hostName) => (hostName === 'runner-b' ? runnerB.port : null),
    });
    const result = await setup.useCase.dispatchAttempt(
      dispatchRequest(manifestDigest('opencode')),
    );
    expectRefusal(result, 'Runner capabilities do not satisfy required isolation');
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.workspace.inspectCalls).toHaveLength(0);
    expect(runnerB.startCalls).toHaveLength(0);
    expect(setup.runnerA.startCalls).toHaveLength(0);
  });
});
