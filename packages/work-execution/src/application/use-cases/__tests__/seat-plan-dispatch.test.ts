/**
 * Unit tests for lane S1b: freezing the seat plan into the brief manifest,
 * binding it at dispatch, and recording a typed stop reason on a refused
 * start. Fixtures are copied from `work-execution-use-cases.test.ts` and
 * `prepare-brief-validation.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import { seatSelectionRecord } from '../../../domain/seat-selection.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { BriefAuthoringPort } from '../../ports/out/BriefAuthoringPort.out-port.js';
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
import {
  PrepareBriefPackageUseCase,
  simpleDeterministicHexDigest,
  type PrepareBriefPackageUseCaseRequest,
} from '../PrepareBriefPackageUseCase.use-case.js';

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

function briefFiles(manifest: Record<string, unknown>) {
  const prose = '# Frozen brief prose';
  const manifestRaw = JSON.stringify(manifest);
  return { prose, manifestRaw, digest: simpleDeterministicHexDigest(prose + '\n' + manifestRaw) };
}

/** A plan with distinct model families (brief S1b, step 8). */
const PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'acme/mercury-3', tool: 'opencode', agent: 'lane' },
  ],
  fix: [
    { id: 'fx-1', model: 'acme/argon-4', tool: 'opencode' },
    { id: 'fx-2', model: 'acme/glm-5.3', tool: 'opencode', variant: 'low' },
  ],
  review: [{ id: 'rv-1', model: 'acme/grok-4.7' }],
};

function dispatchManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelAssignment: {
      model: 'acme/mercury-3',
      agent: 'lane',
      seatTool: 'opencode',
    },
    independentReviewer: 'acme/grok-4.7',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PrepareBriefPackage use case: freezing the seat plan
// ---------------------------------------------------------------------------

function makeBriefAuthoring(): BriefAuthoringPort {
  return {
    async authorBrief() {
      return {
        outcome: 'authored',
        brief: {
          proseMarkdown: '# Frozen brief prose',
          provenance: 'orchestrator',
        },
      };
    },
  };
}

function makeCapturingArtifactPort(): { port: AttemptArtifactPort; placedManifestJsons: string[] } {
  const placedManifestJsons: string[] = [];
  const port: AttemptArtifactPort = {
    async verifyIgnoredPaths(request) {
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief(request) {
      placedManifestJsons.push(request.manifestJson);
      return {
        outcome: 'placed',
        prosePath: '.lane/brief.md',
        manifestPath: '.lane/brief-manifest.json',
      };
    },
    async collectCompletedAttemptArtifacts() {
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
  return { port, placedManifestJsons };
}

function validRequest(overrides: Partial<PrepareBriefPackageUseCaseRequest> = {}): PrepareBriefPackageUseCaseRequest {
  return {
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
    expectedArtifacts: [],
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
    ],
    worktreePath: '/wt',
    ...overrides,
  };
}

/** The prepare plan: first-pass seat matches `validRequest().modelAssignment`. */
const PREPARE_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'implementer-model', tool: 'opencode' },
  ],
  fix: [
    { id: 'fx-1', model: 'acme/argon-4', tool: 'opencode' },
    { id: 'fx-2', model: 'acme/glm-5.3', tool: 'opencode', variant: 'low' },
  ],
  review: [{ id: 'rv-1', model: 'acme/grok-4.7' }],
};

function makePrepareUseCase() {
  const captured = makeCapturingArtifactPort();
  const useCase = new PrepareBriefPackageUseCase({
    briefAuthoring: makeBriefAuthoring(),
    artifactPort: captured.port,
  });
  return { useCase, captured };
}

describe('PrepareBriefPackageUseCase seat plan (S1b)', () => {
  it('freezes no seatPlan key when none is provided (D1)', async () => {
    const { useCase, captured } = makePrepareUseCase();

    const result = await useCase.prepareBriefPackage(validRequest());

    expect(result.outcome).toBe('prepared');
    expect(captured.placedManifestJsons).toHaveLength(1);
    const manifestJson = captured.placedManifestJsons[0];
    expect(manifestJson).not.toContain('"seatPlan"');
    const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
    expect('seatPlan' in manifest).toBe(false);
  });

  it('freezes a valid seat plan whose first-pass seat matches the model assignment', async () => {
    const { useCase, captured } = makePrepareUseCase();

    const result = await useCase.prepareBriefPackage(validRequest({ seatPlan: PREPARE_PLAN }));

    expect(result.outcome).toBe('prepared');
    const manifest = JSON.parse(captured.placedManifestJsons[0]) as { seatPlan?: unknown };
    expect(manifest.seatPlan).toEqual(SeatPlan.create(PREPARE_PLAN).value!.toJSON());
  });

  it('rejects an invalid seat plan', async () => {
    const { useCase } = makePrepareUseCase();

    const result = await useCase.prepareBriefPackage(
      validRequest({ seatPlan: { version: 2 } as unknown as PrepareBriefPackageUseCaseRequest['seatPlan'] }),
    );

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toMatch(/^Seat plan is invalid: /);
    }
  });

  it('refuses a plan whose review seat shares a model family with a fix seat', async () => {
    const { useCase } = makePrepareUseCase();
    const plan = { ...PREPARE_PLAN, review: [{ id: 'rv-1', model: 'acme/argon-5' }] };

    const result = await useCase.prepareBriefPackage(validRequest({ seatPlan: plan }));

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toMatch(/^Seat plan refused: /);
    }
  });

  it('refuses a plan whose implementer seat shares a family with the independent reviewer', async () => {
    const { useCase } = makePrepareUseCase();

    const result = await useCase.prepareBriefPackage(
      validRequest({ seatPlan: PREPARE_PLAN, independentReviewer: 'acme/glm-9' }),
    );

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('fx-2');
    }
  });

  it('refuses a plan whose first-pass seats do not match the model assignment', async () => {
    const { useCase } = makePrepareUseCase();

    const result = await useCase.prepareBriefPackage(
      validRequest({
        seatPlan: PREPARE_PLAN,
        modelAssignment: { ...validRequest().modelAssignment, model: 'acme/argon-4' },
      }),
    );

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('Model assignment must match a first-pass seat of the seat plan');
    }
  });
});

// ---------------------------------------------------------------------------
// DispatchAttempt use case: binding the seat and recording the stop reason
// ---------------------------------------------------------------------------

describe('DispatchAttemptUseCase seat binding (S1b)', () => {
  it('binds a fresh attempt to the manifest seat plan', async () => {
    const files = briefFiles(dispatchManifest({ seatPlan: PLAN }));
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect(stored?.seatPlan).toEqual(SeatPlan.create(PLAN).value!.toJSON());
    expect(stored?.seatSelection).toEqual({
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'fp-1',
      model: 'acme/mercury-3',
      tool: 'opencode',
      variant: null,
      agent: 'lane',
    });
  });

  it('records no seat fields when the manifest has no seat plan (D1)', async () => {
    const files = briefFiles(dispatchManifest());
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect('seatPlan' in (stored ?? {})).toBe(false);
    expect('seatSelection' in (stored ?? {})).toBe(false);
  });

  it('refuses an invalid frozen seat plan before any journal entry or start', async () => {
    const files = briefFiles(dispatchManifest({ seatPlan: { version: 1 } }));
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toMatch(/^Frozen brief manifest 'seatPlan' is invalid: /);
    }
    expect(setup.journal.entries).toHaveLength(0);
    expect(setup.journal.heldFor('attempt-1')).toBe(true);
    expect(setup.runner.startCalls).toHaveLength(0);
  });

  function seedFixAttempt(setup: ReturnType<typeof makeDispatchSetup>) {
    setup.attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({
        id: 'attempt-1',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-0',
        state: 'intent-recorded',
        seatSelection: seatSelectionRecord('fix', 1, PLAN.fix[1]),
      }),
    );
    setup.attemptRepo.attempts.set(
      'attempt-0',
      storedAttempt({ id: 'attempt-0', state: 'collected', sessionId: 'session-0' }),
    );
  }

  it('refuses a fix attempt whose frozen assignment mismatches its recorded seat selection', async () => {
    const files = briefFiles(
      dispatchManifest({ modelAssignment: { model: 'acme/argon-4', seatTool: 'opencode' } }),
    );
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });
    seedFixAttempt(setup);

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('fx-2');
    }
    expect(setup.journal.entries).toHaveLength(0);
  });

  it('binds a fix attempt with no recorded selection to the frozen plan only, never as a first-pass seat', async () => {
    const files = briefFiles(dispatchManifest({ seatPlan: PLAN }));
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });
    seedFixAttempt(setup);
    const seeded = setup.attemptRepo.attempts.get('attempt-1')!;
    setup.attemptRepo.attempts.set('attempt-1', { ...seeded, seatSelection: undefined });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    const stored = setup.attemptRepo.attempts.get('attempt-1');
    expect(stored?.seatPlan).toBeDefined();
    expect(stored?.seatSelection).toBeUndefined();
  });

  it('dispatches a fix attempt whose frozen assignment matches its recorded seat selection', async () => {
    const files = briefFiles(
      dispatchManifest({ modelAssignment: { model: 'acme/glm-5.3', variant: 'low', seatTool: 'opencode' } }),
    );
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });
    seedFixAttempt(setup);

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect(stored?.seatSelection).toEqual(seatSelectionRecord('fix', 1, PLAN.fix[1]));
  });

  it('allows an operator seat override on a mismatched fix seat selection', async () => {
    const files = briefFiles(
      dispatchManifest({ modelAssignment: { model: 'acme/argon-4', seatTool: 'opencode' } }),
    );
    const setup = makeDispatchSetup({
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });
    seedFixAttempt(setup);

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({
        briefDigest: files.digest,
        seatOverride: {
          model: 'acme/glm-5.3',
          variant: 'low',
          reason: 'operator switch for capacity',
          setBy: 'operator',
          expiresAtIso: '2026-10-16T08:00:00.000Z',
        },
      }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('started');
  });
});

describe('DispatchAttemptUseCase stopped stop reason (S1b)', () => {
  it('records stopReason rate-limited on a cancelled attempt and its refused journal entry', async () => {
    const files = briefFiles(dispatchManifest());
    const setup = makeDispatchSetup({
      runnerOptions: { startResult: { outcome: 'refused', reason: 'HTTP 429 Too Many Requests' } },
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'HTTP 429 Too Many Requests' });
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect(stored?.state).toBe('cancelled');
    expect(stored?.stopReason).toBe('rate-limited');
    const refused = setup.journal.entries.filter((entry) => entry.status === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].stopReason).toBe('rate-limited');
    expect(setup.journal.heldFor('attempt-1')).toBe(false);
  });

  it('records an adapter-provided reasonClass verbatim', async () => {
    const files = briefFiles(dispatchManifest());
    const setup = makeDispatchSetup({
      runnerOptions: { startResult: { outcome: 'refused', reason: 'anything', reasonClass: 'payment' } },
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect(stored?.stopReason).toBe('payment');
    const refused = setup.journal.entries.filter((entry) => entry.status === 'refused');
    expect(refused[0].stopReason).toBe('payment');
  });

  it('classifies an untyped runner refusal as runner-refused', async () => {
    const files = briefFiles(dispatchManifest());
    const setup = makeDispatchSetup({
      runnerOptions: { startResult: { outcome: 'refused', reason: 'runner rejected isolation profile' } },
      workspaceOptions: {
        readWorktreeFile: async (_w, rel) => (rel === '.lane/brief-manifest.json' ? files.manifestRaw : files.prose),
      },
    });

    const result = await setup.useCase.dispatchAttempt(
      validDispatchRequest({ briefDigest: files.digest }) as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );

    expect(result.outcome).toBe('refused');
    const stored = await setup.attemptRepo.findAttemptById('attempt-1');
    expect(stored?.stopReason).toBe('runner-refused');
  });
});
