/**
 * Unit tests for K7-5b: `StartLaneRunUseCase` (reserve → worktree → brief →
 * attempt → run, in the owner's order) and its crash-and-refusal table. A
 * recording `LaneRunStartCapacityPort` fake saves a held reservation in the
 * in-memory execution journal; every store is in-memory; no runner, no
 * subprocess, no network. Test 7 proves the driver's first step is dispatch
 * against a fake-acting `AdvanceLaneRunUseCase`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { PrepareBriefPackagePort, PrepareBriefPackageRequest } from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareLaneWorktreeRequest, PrepareLaneWorktreeResult } from '../../ports/out/WorkspacePort.out-port.js';
import type { WorkspacePort } from '../../ports/out/WorkspacePort.out-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  LaneRunFirstReservationRequest,
  LaneRunFirstReservationResult,
  LaneRunStartCapacityPort,
} from '../../ports/out/LaneRunStartCapacityPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { DispatchAttemptPort } from '../../ports/in/DispatchAttemptPort.in-port.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import { CancelPreparedAttemptUseCase } from '../CancelPreparedAttemptUseCase.use-case.js';
import { StartLaneRunUseCase } from '../StartLaneRunUseCase.use-case.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-example-1';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const COMMIT = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const HOST_NAME = 'lane-example';
const WORKTREE_ROOT = '/tmp/fleet-example/wt';
const WORKTREE_PATH = WORKTREE_ROOT + '/example0000000000000000000000000001';

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [],
};

function storedWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: COMMIT,
    ownedPaths: ['packages/example/src'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function briefFixture(overrides: Partial<PrepareBriefPackageRequest> = {}): PrepareBriefPackageRequest {
  return {
    workOrderId: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: COMMIT,
    policyRevision: 'policy-example-1',
    modelAssignment: {
      model: 'model-example-1',
      variant: 'default',
      fallbackModel: 'model-example-2',
      seatTool: 'opencode',
    },
    seatPlan: SEAT_PLAN,
    independentReviewer: 'reviewer-model-example-1',
    ownedPaths: ['packages/example/src'],
    permissions: [],
    acceptanceChecks: [],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ['node', '--eval', 'process.exit(0)'] }],
    },
    stepLimit: 40,
    timeLimitSeconds: 2700,
    resourceBounds: {},
    expectedArtifacts: [],
    ownerDecisionReferences: [],
    contextDecisions: [],
    prNotes: {
      hardToUndo: 'The conductor opens the PR and merges it automatically',
      assumptions: 'The base branch is main and CI passes',
      challengeThis: 'That the merge train is safe without a reviewer on the final diff',
    },
    ...overrides,
  };
}

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    tier: 2 as const,
    runPolicyRevision: 'policy-example-1',
    brief: briefFixture(),
    nowIso: NOW,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly workOrder?: WorkOrderRecord | null;
  readonly profileStatus?: 'active' | 'retired';
  readonly withProfile?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const workOrders = new Map<string, WorkOrderRecord>();
  if (options.workOrder !== null) {
    const order = options.workOrder ?? storedWorkOrder();
    workOrders.set(order.id, order);
  }
  const workOrderRepo = {
    findWorkOrderById: async (workOrderId: string) => workOrders.get(workOrderId) ?? null,
  };
  const profile = {
    projectId: 'project-example-1',
    status: options.profileStatus ?? ('active' as const),
    repository: 'repo-example-1',
    clones: { [HOST_NAME]: { path: '/tmp/fleet-example/clone', worktreeRoot: WORKTREE_ROOT } },
    gateProcedures: [],
    revision: 1,
  };
  const profileRead = {
    readProjectProfile: async () => (options.withProfile === false ? null : profile),
  };

  const attemptRepoStore = new AttemptRepositoryAdapter();
  let failSaveAttemptOnce = false;
  const attemptRepo: AttemptRepositoryPort = {
    saveAttempt: async (record) => {
      if (failSaveAttemptOnce) {
        failSaveAttemptOnce = false;
        throw new Error('example attempt save failure');
      }
      return attemptRepoStore.saveAttempt(record);
    },
    findAttemptById: (attemptId) => attemptRepoStore.findAttemptById(attemptId),
    listAttemptsByWorkOrder: (workOrderId) => attemptRepoStore.listAttemptsByWorkOrder(workOrderId),
    listAllAttempts: () => attemptRepoStore.listAllAttempts(),
  };

  const executionJournal = new ExecutionJournalAdapter();
  const runJournal = new LaneRunJournalAdapter();

  const runRepoStore = new LaneRunRepositoryAdapter();
  let failCreateRunOnce = false;
  const runRepo = {
    get: (runId: string) => runRepoStore.get(runId),
    list: () => runRepoStore.list(),
    create: async (record: LaneRunRecord) => {
      if (failCreateRunOnce) {
        failCreateRunOnce = false;
        throw new Error('example run create failure');
      }
      return runRepoStore.create(record);
    },
    acquireLease: (runId: string, request: Parameters<LaneRunRepositoryAdapter['acquireLease']>[1]) =>
      runRepoStore.acquireLease(runId, request),
  };

  const capacityCalls: LaneRunFirstReservationRequest[] = [];
  let capacityAnswer: LaneRunFirstReservationResult | null = null;
  const capacity: LaneRunStartCapacityPort = {
    async reserveFirst(request) {
      capacityCalls.push(request);
      const answer =
        capacityAnswer ?? {
          outcome: 'reserved' as const,
          hostName: HOST_NAME,
          hostKind: 'opencode' as const,
          worktreePath: WORKTREE_PATH,
          transport: 'local' as const,
          sshAlias: null,
          port: 41001,
        };
      if (answer.outcome === 'reserved') {
        await executionJournal.saveCapacityReservation({
          id: 'res-example-' + String(capacityCalls.length),
          attemptId: request.attemptId,
          hostId: answer.hostName,
          slotIndex: 0,
          held: true,
          seatTool: request.seatTool,
          hostName: answer.hostName,
          hostKind: answer.hostKind,
          transport: answer.transport,
          sshAlias: answer.sshAlias,
          port: answer.port,
          worktreePath: answer.worktreePath,
          reservedAtIso: request.nowIso,
          releasedAtIso: null,
        });
      }
      return answer;
    },
  };

  const worktreeCalls: PrepareLaneWorktreeRequest[] = [];
  let worktreeAnswers: PrepareLaneWorktreeResult[] = [];
  const workspace: Pick<WorkspacePort, 'prepareLaneWorktree'> = {
    prepareLaneWorktree: async (request) => {
      worktreeCalls.push(request);
      if (worktreeAnswers.length > 0) {
        return worktreeAnswers.shift() as PrepareLaneWorktreeResult;
      }
      return worktreeCalls.length > 1 ? { outcome: 'already-prepared' } : { outcome: 'prepared' };
    },
  };

  const briefCalls: PrepareBriefPackageUseCaseRequest[] = [];
  let briefAnswers: ('prepared' | 'rejected')[] = [];
  const prepareBrief: PrepareBriefPackagePort = {
    async prepareBriefPackage(request) {
      briefCalls.push(request);
      const answer = briefAnswers.length > 0 ? (briefAnswers.shift() as 'prepared' | 'rejected') : 'prepared';
      const placed = request as PrepareBriefPackageUseCaseRequest;
      return answer === 'prepared'
        ? {
            outcome: 'prepared' as const,
            prepared: {
              attemptId: placed.attemptId ?? ATTEMPT_ID,
              briefDigest: DIGEST,
              prosePath: (placed.worktreePath ?? WORKTREE_PATH) + '/.lane/brief.md',
              manifestPath: (placed.worktreePath ?? WORKTREE_PATH) + '/.lane/brief-manifest.json',
              selectedKnowledgeVersions: [],
            },
          }
        : { outcome: 'rejected' as const, reason: 'example brief rejection' };
    },
    async previewBriefPackage() {
      throw new Error('not used in this test');
    },
  };

  const cancelPreparedAttempt = new CancelPreparedAttemptUseCase({ attemptRepo, journal: executionJournal });

  const useCase = new StartLaneRunUseCase({
    workOrderRepo,
    profileRead,
    capacity,
    executionJournal,
    workspace,
    prepareBrief,
    attemptRepo,
    runRepo,
    runJournal,
    cancelPreparedAttempt,
    computeDigest: (content) => DIGEST.slice(0, 8) + String(content.length).padStart(56, '0'),
  });

  return {
    useCase,
    attemptRepoStore,
    executionJournal,
    runRepoStore,
    runRepo,
    runJournal,
    capacityCalls,
    setCapacityAnswer: (answer: LaneRunFirstReservationResult | null) => {
      capacityAnswer = answer;
    },
    worktreeCalls,
    setWorktreeAnswers: (answers: PrepareLaneWorktreeResult[]) => {
      worktreeAnswers = answers;
    },
    briefCalls,
    setBriefAnswers: (answers: ('prepared' | 'rejected')[]) => {
      briefAnswers = answers;
    },
    failNextAttemptSave: () => {
      failSaveAttemptOnce = true;
    },
    failNextRunCreate: () => {
      failCreateRunOnce = true;
    },
  };
}

function makeUlidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

async function heldFor(journal: ExecutionJournalAdapter, attemptId: string): Promise<boolean> {
  return (await journal.listActiveReservations()).some(
    (reservation) => reservation.attemptId === attemptId && reservation.held,
  );
}

describe('StartLaneRunUseCase', () => {
  it('test 1: a fresh start runs reserve, worktree, brief, attempt, run in order and ends started', async () => {
    const harness = makeHarness();
    const result = await harness.useCase.startLaneRun(requestFixture());

    expect(result).toEqual({
      outcome: 'started',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      hostName: HOST_NAME,
      worktreePath: WORKTREE_PATH,
    });
    expect(harness.capacityCalls).toHaveLength(1);
    expect(harness.capacityCalls[0]).toEqual({
      attemptId: ATTEMPT_ID,
      workOrderId: 'wo-example-1',
      seatTool: 'opencode',
      nowIso: NOW,
    });
    expect(harness.worktreeCalls).toHaveLength(1);
    expect(harness.worktreeCalls[0]).toMatchObject({
      clonePath: '/tmp/fleet-example/clone',
      worktreePath: WORKTREE_PATH,
      branch: 'fleet/' + RUN_ID,
      baseCommit: COMMIT,
      recordedHost: {
        kind: 'opencode',
        hostName: HOST_NAME,
        remotePort: 41001,
        host: null,
        agent: null,
        model: null,
        variant: null,
      },
    });
    expect(harness.briefCalls).toHaveLength(1);
    expect(harness.briefCalls[0]).toMatchObject({
      attemptId: ATTEMPT_ID,
      worktreePath: WORKTREE_PATH,
      recordedHost: {
        kind: 'opencode',
        hostName: HOST_NAME,
        remotePort: 41001,
        host: null,
        agent: null,
        model: null,
        variant: null,
      },
    });

    const attempt = await harness.attemptRepoStore.findAttemptById(ATTEMPT_ID);
    expect(attempt).not.toBeNull();
    expect(attempt).toMatchObject({
      id: ATTEMPT_ID,
      workOrderId: 'wo-example-1',
      kind: 'initial',
      fixNumber: 0,
      state: 'intent-recorded',
      worktreePath: WORKTREE_PATH,
      briefDigest: DIGEST,
      briefPackagePath: WORKTREE_PATH + '/.lane/brief.md',
      seatSelection: expect.objectContaining({ role: 'first-pass', seatIndex: 0, seatId: 'fp-1' }),
      reviewerSeat: null,
    });
    const run = await harness.runRepoStore.get(RUN_ID);
    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      runId: RUN_ID,
      workOrderId: 'wo-example-1',
      attemptIds: [ATTEMPT_ID],
      revision: 1,
      lease: null,
      round: 0,
    });
    // The run record names the worktree branch start gave the workspace (KF-5a).
    expect(run?.branchName).toBe(`fleet/${RUN_ID}`);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(true);
  });

  it('test 2: every step-0 refusal writes nothing and calls no fake', async () => {
    const badRun = await makeHarness().useCase.startLaneRun(requestFixture({ runId: 'not-a-run-id' }));
    expect(badRun).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    const missingOrder = makeHarness({ workOrder: null });
    expect(await missingOrder.useCase.startLaneRun(requestFixture())).toEqual({
      outcome: 'refused',
      reason: 'work-order-missing',
    });
    expect(missingOrder.capacityCalls).toHaveLength(0);

    const closedOrder = makeHarness({ workOrder: storedWorkOrder({ state: 'merged' }) });
    expect(await closedOrder.useCase.startLaneRun(requestFixture())).toEqual({
      outcome: 'refused',
      reason: 'work-order-not-open',
    });

    const busyOrder = makeHarness();
    const otherRun = await busyOrder.runRepoStore.create({
      version: 1,
      runId: 'run-01JB0000000000000000000001',
      workOrderId: 'wo-example-1',
      tier: 2,
      seatPlanRef: DIGEST,
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: ['attempt-example-9'],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-1',
    });
    expect(otherRun.outcome).toBe('saved');
    expect(await busyOrder.useCase.startLaneRun(requestFixture())).toEqual({
      outcome: 'refused',
      reason: 'run-active-for-work-order',
    });

    const retiredProject = makeHarness({ profileStatus: 'retired' });
    expect(await retiredProject.useCase.startLaneRun(requestFixture())).toEqual({
      outcome: 'refused',
      reason: 'project-not-active',
    });
    const absentProject = makeHarness({ withProfile: false });
    expect(await absentProject.useCase.startLaneRun(requestFixture())).toEqual({
      outcome: 'refused',
      reason: 'project-not-active',
    });

    const noPlan = makeHarness();
    expect(
      await noPlan.useCase.startLaneRun(requestFixture({ brief: briefFixture({ seatPlan: undefined }) })),
    ).toEqual({ outcome: 'refused', reason: 'no-seat-plan' });
    const badPlan = makeHarness();
    expect(
      await badPlan.useCase.startLaneRun(
        requestFixture({ brief: briefFixture({ seatPlan: { ...SEAT_PLAN, extra: true } as unknown as PrepareBriefPackageRequest['seatPlan'] }) }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'no-seat-plan' });

    const noSpec = makeHarness();
    expect(
      await noSpec.useCase.startLaneRun(requestFixture({ brief: briefFixture({ acceptanceSpec: undefined }) })),
    ).toEqual({ outcome: 'refused', reason: 'no-acceptance-spec' });

    const blockedSeatPlan = {
      version: 1 as const,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode', on: ['rate-limited'] as const }],
      fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
      review: [],
    };
    const noSeat = makeHarness();
    expect(
      await noSeat.useCase.startLaneRun(requestFixture({ brief: briefFixture({ seatPlan: blockedSeatPlan }) })),
    ).toEqual({ outcome: 'refused', reason: 'no-first-pass-seat' });

    const existingRun = makeHarness();
    const created = await existingRun.runRepoStore.create({
      version: 1,
      runId: RUN_ID,
      workOrderId: 'wo-other-example-1',
      tier: 2,
      seatPlanRef: DIGEST,
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: ['attempt-example-9'],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-1',
    });
    expect(created.outcome).toBe('saved');
    expect(await existingRun.useCase.startLaneRun(requestFixture())).toEqual({
      outcome: 'refused',
      reason: 'run-exists',
    });

    for (const harness of [
      missingOrder,
      closedOrder,
      busyOrder,
      retiredProject,
      absentProject,
      noPlan,
      badPlan,
      noSpec,
      noSeat,
      existingRun,
    ]) {
      expect(harness.capacityCalls).toHaveLength(0);
      expect(harness.worktreeCalls).toHaveLength(0);
      expect(harness.briefCalls).toHaveLength(0);
      expect(await harness.executionJournal.listActiveReservations()).toEqual([]);
      expect(await harness.attemptRepoStore.listAllAttempts()).toEqual([]);
    }
  });

  it('test 2b: an unreadable work-order state refuses work-order-missing and never reserves', async () => {
    const harness = makeHarness({
      workOrder: storedWorkOrder({
        state: 'not-a-real-state' as unknown as WorkOrderRecord['state'],
      }),
    });
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({ outcome: 'refused', reason: 'work-order-missing' });
    expect(harness.capacityCalls).toHaveLength(0);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await harness.executionJournal.listActiveReservations()).toEqual([]);
    expect(await harness.attemptRepoStore.listAllAttempts()).toEqual([]);
  });

  it('test 2d: a conducted start refuses a brief without frozen PR notes and writes nothing', async () => {
    const harness = makeHarness();
    const result = await harness.useCase.startLaneRun(
      requestFixture({ brief: briefFixture({ prNotes: undefined }) }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'pr-notes-missing' });
    expect(harness.capacityCalls).toHaveLength(0);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await harness.executionJournal.listActiveReservations()).toEqual([]);
    expect(await harness.attemptRepoStore.listAllAttempts()).toEqual([]);
  });

  it('test 3: no capacity reports no-capacity, writes nothing and never calls the worktree', async () => {
    const harness = makeHarness();
    harness.setCapacityAnswer({ outcome: 'no-capacity' });
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({ outcome: 'no-capacity' });
    expect(harness.capacityCalls).toHaveLength(1);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await harness.attemptRepoStore.listAllAttempts()).toEqual([]);
    expect(await harness.runRepoStore.list()).toEqual([]);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 3b: a held, incomplete reservation is released and reported incomplete reserve, never re-reserved', async () => {    const harness = makeHarness();
    await harness.executionJournal.saveCapacityReservation({
      id: 'res-example-incomplete',
      attemptId: ATTEMPT_ID,
      hostId: HOST_NAME,
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: null,
      hostKind: null,
      transport: 'local',
      sshAlias: null,
      port: null,
      worktreePath: null,
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'reserve',
      reason: 'reservation-incomplete',
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(ATTEMPT_ID, NOW);
    expect(harness.capacityCalls).toHaveLength(0);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 3c (KF-8): a start on an ssh host records the alias and port and places the brief on that host', async () => {
    const harness = makeHarness();
    harness.setCapacityAnswer({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'ssh',
      sshAlias: 'lane-ssh-example',
      port: 41002,
    });
    const result = await harness.useCase.startLaneRun(requestFixture());

    expect(result).toEqual({
      outcome: 'started',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      hostName: HOST_NAME,
      worktreePath: WORKTREE_PATH,
    });
    expect(harness.worktreeCalls).toHaveLength(1);
    expect(harness.worktreeCalls[0]).toMatchObject({
      clonePath: '/tmp/fleet-example/clone',
      worktreePath: WORKTREE_PATH,
      recordedHost: {
        kind: 'opencode',
        hostName: HOST_NAME,
        remotePort: 41002,
        host: 'lane-ssh-example',
        agent: null,
        model: null,
        variant: null,
      },
    });
    expect(harness.briefCalls).toHaveLength(1);
    expect(harness.briefCalls[0]).toMatchObject({
      attemptId: ATTEMPT_ID,
      worktreePath: WORKTREE_PATH,
      recordedHost: {
        kind: 'opencode',
        hostName: HOST_NAME,
        remotePort: 41002,
        host: 'lane-ssh-example',
        agent: null,
        model: null,
        variant: null,
      },
    });
    const held = (await harness.executionJournal.listActiveReservations()).find(
      (reservation) => reservation.attemptId === ATTEMPT_ID && reservation.held,
    );
    expect(held).toMatchObject({
      transport: 'ssh',
      sshAlias: 'lane-ssh-example',
      port: 41002,
    });
  });

  it('test 3d (KF-8): an agy host records no remote port', async () => {
    const harness = makeHarness();
    harness.setCapacityAnswer({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'agy',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      // The agy guard maps any numeric port to a null remote port.
      port: 4166,
    });
    const result = await harness.useCase.startLaneRun(
      requestFixture({
        brief: briefFixture({
          modelAssignment: {
            model: 'model-example-1',
            variant: 'default',
            fallbackModel: 'model-example-2',
            seatTool: 'agy' as const,
          },
          seatPlan: {
            version: 1 as const,
            'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'agy' }],
            fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'agy' }],
            review: [],
          },
          allowedPathPrefixes: ['packages/example/src'],
        }),
      }),
    );

    expect(result).toMatchObject({ outcome: 'started', hostName: HOST_NAME });
    expect(harness.worktreeCalls).toHaveLength(1);
    expect(harness.worktreeCalls[0].recordedHost).toEqual({
      kind: 'agy',
      hostName: HOST_NAME,
      remotePort: null,
      host: null,
      agent: null,
      model: null,
      variant: null,
    });
    expect(harness.briefCalls[0].recordedHost).toEqual(harness.worktreeCalls[0].recordedHost);
  });

  it('test 3e (KF-8): a held ssh reservation without an alias is released and reported incomplete reserve', async () => {
    const harness = makeHarness();
    await harness.executionJournal.saveCapacityReservation({
      id: 'res-example-ssh-no-alias',
      attemptId: ATTEMPT_ID,
      hostId: HOST_NAME,
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      transport: 'ssh',
      sshAlias: null,
      port: 41001,
      worktreePath: WORKTREE_PATH,
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'reserve',
      reason: 'reservation-incomplete',
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 3j (KF-8): a held legacy reservation with a blank alias and no transport reads as local and starts', async () => {
    const harness = makeHarness();
    await harness.executionJournal.saveCapacityReservation({
      id: 'res-example-legacy-blank-alias',
      attemptId: ATTEMPT_ID,
      hostId: HOST_NAME,
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      transport: null,
      sshAlias: '   ',
      port: 41001,
      worktreePath: WORKTREE_PATH,
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    await harness.useCase.startLaneRun(requestFixture());
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(harness.worktreeCalls).toHaveLength(1);
    expect(harness.worktreeCalls[0]!.recordedHost).toMatchObject({ host: null, remotePort: 41001, kind: 'opencode' });
  });

  it('test 3f (KF-8): a held opencode reservation without a port is released and reported incomplete reserve', async () => {
    const harness = makeHarness();
    await harness.executionJournal.saveCapacityReservation({
      id: 'res-example-opencode-no-port',
      attemptId: ATTEMPT_ID,
      hostId: HOST_NAME,
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      transport: 'local',
      sshAlias: null,
      port: null,
      worktreePath: WORKTREE_PATH,
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'reserve',
      reason: 'reservation-incomplete',
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 3g (KF-8): a fresh ssh reservation without an alias is released and reported incomplete reserve', async () => {
    const harness = makeHarness();
    harness.setCapacityAnswer({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'ssh',
      sshAlias: null,
      port: 41001,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'reserve',
      reason: 'reservation-incomplete',
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(ATTEMPT_ID, NOW);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 3h (KF-8): a fresh ssh reservation with a blank alias is released and reported incomplete reserve', async () => {
    const harness = makeHarness();
    harness.setCapacityAnswer({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'ssh',
      sshAlias: '   ',
      port: 41001,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'reserve',
      reason: 'reservation-incomplete',
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(ATTEMPT_ID, NOW);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 3i (KF-8): a fresh opencode reservation without a port is released and reported incomplete reserve', async () => {
    const harness = makeHarness();
    harness.setCapacityAnswer({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      port: null,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'reserve',
      reason: 'reservation-incomplete',
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(ATTEMPT_ID, NOW);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it.each([
    ['worktree-unknown', 'worktree', 'worktree-unknown'],
    ['brief-rejected', 'brief', 'brief-rejected'],
    ['attempt-save-failed', 'attempt', 'attempt-save-failed'],
    ['run-exists', 'run', 'run-exists'],
  ])('test 4 (%s): a crash at that step keeps the reservation; the retry with the same ids completes', async (
    _name,
    step,
    reason,
  ) => {
    const harness = makeHarness();
    if (step === 'worktree') {
      harness.setWorktreeAnswers([{ outcome: 'unknown' }]);
    } else if (step === 'brief') {
      harness.setBriefAnswers(['rejected']);
    } else if (step === 'attempt') {
      harness.failNextAttemptSave();
    } else {
      harness.failNextRunCreate();
    }
    const first = await harness.useCase.startLaneRun(requestFixture());
    expect(first).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step,
      reason,
    });
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(true);

    const retry = await harness.useCase.startLaneRun(requestFixture({ nowIso: LATER }));
    expect(retry).toEqual({
      outcome: 'started',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      hostName: HOST_NAME,
      worktreePath: WORKTREE_PATH,
    });
    expect(harness.capacityCalls).toHaveLength(1);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(true);
    const run = await harness.runRepoStore.get(RUN_ID);
    expect(run?.attemptIds).toEqual([ATTEMPT_ID]);
    const attempts = await harness.attemptRepoStore.listAllAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe('intent-recorded');
  });

  it('test 5: a retry after completion returns started and calls no fake again', async () => {
    const harness = makeHarness();
    expect(await harness.useCase.startLaneRun(requestFixture())).toMatchObject({ outcome: 'started' });
    expect(await harness.useCase.startLaneRun(requestFixture({ nowIso: LATER }))).toEqual({
      outcome: 'started',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      hostName: HOST_NAME,
      worktreePath: WORKTREE_PATH,
    });
    expect(harness.capacityCalls).toHaveLength(1);
    expect(harness.worktreeCalls).toHaveLength(1);
    expect(harness.briefCalls).toHaveLength(1);
  });

  it('test 5b: a retry after completion with neither runner host nor held reservation returns incomplete attempt', async () => {
    const harness = makeHarness();
    const created = await harness.runRepoStore.create({
      version: 1,
      runId: RUN_ID,
      workOrderId: 'wo-example-1',
      tier: 2,
      seatPlanRef: DIGEST,
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: [ATTEMPT_ID],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-1',
    });
    expect(created.outcome).toBe('saved');
    const result = await harness.useCase.startLaneRun(requestFixture());
    expect(result).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'attempt',
      reason: 'attempt-incomplete',
    });
    expect(harness.capacityCalls).toHaveLength(0);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
  });

  it('test 6: abandon releases a reserve-only crash, cancels a prepared attempt and refuses a completed start', async () => {
    const reserveOnly = makeHarness();
    reserveOnly.setWorktreeAnswers([{ outcome: 'unknown' }]);
    expect(await reserveOnly.useCase.startLaneRun(requestFixture())).toMatchObject({
      outcome: 'incomplete',
      step: 'worktree',
    });
    expect(await reserveOnly.useCase.abandonStart({ runId: RUN_ID, attemptId: ATTEMPT_ID, nowIso: LATER })).toEqual({
      outcome: 'abandoned',
      capacity: 'released',
      attemptCancelled: false,
    });
    expect(await heldFor(reserveOnly.executionJournal, ATTEMPT_ID)).toBe(false);
    expect(await reserveOnly.attemptRepoStore.findAttemptById(ATTEMPT_ID)).toBeNull();
    expect(reserveOnly.worktreeCalls).toHaveLength(1);

    const attemptCrash = makeHarness();
    attemptCrash.failNextRunCreate();
    expect(await attemptCrash.useCase.startLaneRun(requestFixture())).toMatchObject({
      outcome: 'incomplete',
      step: 'run',
    });
    expect(await attemptCrash.useCase.abandonStart({ runId: RUN_ID, attemptId: ATTEMPT_ID, nowIso: LATER })).toEqual({
      outcome: 'abandoned',
      capacity: 'released',
      attemptCancelled: true,
    });
    const cancelled = await attemptCrash.attemptRepoStore.findAttemptById(ATTEMPT_ID);
    expect(cancelled?.state).toBe('cancelled');
    expect(await heldFor(attemptCrash.executionJournal, ATTEMPT_ID)).toBe(false);
    expect(attemptCrash.worktreeCalls).toHaveLength(1);

    const completed = makeHarness();
    expect(await completed.useCase.startLaneRun(requestFixture())).toMatchObject({ outcome: 'started' });
    expect(await completed.useCase.abandonStart({ runId: RUN_ID, attemptId: ATTEMPT_ID, nowIso: LATER })).toEqual({
      outcome: 'refused',
      reason: 'run-exists',
    });
  });

  it('test 6b: abandon of a completed step-4 attempt releases the slot; a retry start with the same ids is never re-reserved', async () => {
    const harness = makeHarness();
    // Crash at step 5: the attempt exists (`intent-recorded`), the
    // reservation is held.
    harness.failNextRunCreate();
    expect(await harness.useCase.startLaneRun(requestFixture())).toMatchObject({
      outcome: 'incomplete',
      step: 'run',
    });
    expect(await harness.attemptRepoStore.findAttemptById(ATTEMPT_ID)).toMatchObject({
      state: 'intent-recorded',
    });

    // Abandon: the attempt is cancelled record-only and the slot released.
    expect(
      await harness.useCase.abandonStart({ runId: RUN_ID, attemptId: ATTEMPT_ID, nowIso: LATER }),
    ).toEqual({ outcome: 'abandoned', capacity: 'released', attemptCancelled: true });
    expect(await harness.attemptRepoStore.findAttemptById(ATTEMPT_ID)).toMatchObject({
      state: 'cancelled',
    });
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);

    // A retry start with the same ids refuses without reserving, preparing
    // the worktree or rewriting the brief: the attempt is no longer
    // prepared.
    const briefCallsBefore = harness.briefCalls.length;
    const retry = await harness.useCase.startLaneRun(requestFixture({ nowIso: LATER }));
    expect(retry).toEqual({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'attempt',
      reason: 'attempt-differs',
    });
    expect(harness.capacityCalls).toHaveLength(1); // only the first start's reserve
    expect(harness.worktreeCalls).toHaveLength(1); // only the first start's call
    expect(harness.briefCalls).toHaveLength(briefCallsBefore);
  });

  it('test 6c: abandon of a cancelled attempt releases its held reservation', async () => {
    const harness = makeHarness();
    await harness.attemptRepoStore.saveAttempt({
      id: ATTEMPT_ID,
      workOrderId: 'wo-example-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: WORKTREE_PATH,
      baseCommit: COMMIT,
      state: 'cancelled',
      outcome: null,
      briefDigest: DIGEST,
      briefPackagePath: WORKTREE_PATH + '/.lane/brief.md',
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      seatPlan: SEAT_PLAN,
      seatSelection: { role: 'first-pass', seatIndex: 0, seatId: 'fp-1', model: 'model-example-1', tool: 'opencode', variant: null, agent: null },
      reviewerSeat: null,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    });
    await harness.executionJournal.saveCapacityReservation({
      id: 'res-example-held',
      attemptId: ATTEMPT_ID,
      hostId: HOST_NAME,
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      transport: 'local',
      sshAlias: null,
      port: null,
      worktreePath: WORKTREE_PATH,
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    expect(
      await harness.useCase.abandonStart({ runId: RUN_ID, attemptId: ATTEMPT_ID, nowIso: LATER }),
    ).toEqual({ outcome: 'abandoned', capacity: 'released', attemptCancelled: false });
    expect(releaseSpy).toHaveBeenCalledWith(ATTEMPT_ID, LATER);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
  });

  it('test 2c: a model assignment that is not the selected first-pass seat is refused before any reserve', async () => {
    const twoSeatPlan = {
      version: 1 as const,
      'first-pass': [
        { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
        { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
      ],
      fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
      review: [],
    };
    const harness = makeHarness();
    // The first pass starts at seat 0; the assignment names the second seat.
    const result = await harness.useCase.startLaneRun(
      requestFixture({
        brief: briefFixture({
          seatPlan: twoSeatPlan,
          modelAssignment: {
            model: 'model-example-2',
            variant: 'default',
            fallbackModel: 'model-example-2',
            seatTool: 'opencode',
          },
        }),
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.capacityCalls).toHaveLength(0);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
    expect(await harness.attemptRepoStore.listAllAttempts()).toEqual([]);
  });

  it('test 2e: a start whose first-pass seat names an agent accepts an assignment that names it (KF-7)', async () => {
    const agentSeatPlan = {
      version: 1 as const,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode', agent: 'lane' }],
      fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
      review: [],
    };
    const harness = makeHarness();
    const result = await harness.useCase.startLaneRun(
      requestFixture({
        brief: briefFixture({
          seatPlan: agentSeatPlan,
          modelAssignment: {
            model: 'model-example-1',
            variant: 'default',
            fallbackModel: 'model-example-2',
            seatTool: 'opencode',
            agent: 'lane',
          },
        }),
      }),
    );
    expect(result).toEqual({
      outcome: 'started',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      hostName: HOST_NAME,
      worktreePath: WORKTREE_PATH,
    });
  });

  it('test 2f: a start whose plan seat names an agent refuses an assignment that does not (KF-7)', async () => {
    const agentSeatPlan = {
      version: 1 as const,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode', agent: 'lane' }],
      fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
      review: [],
    };
    const harness = makeHarness();
    const result = await harness.useCase.startLaneRun(
      requestFixture({ brief: briefFixture({ seatPlan: agentSeatPlan }) }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.capacityCalls).toHaveLength(0);
    expect(harness.worktreeCalls).toHaveLength(0);
    expect(harness.briefCalls).toHaveLength(0);
    expect(await heldFor(harness.executionJournal, ATTEMPT_ID)).toBe(false);
    expect(await harness.attemptRepoStore.listAllAttempts()).toEqual([]);
  });

  it('test 7: after a start the driver\'s first step is dispatch, without an admit call', async () => {
    const harness = makeHarness();
    expect(await harness.useCase.startLaneRun(requestFixture())).toMatchObject({ outcome: 'started' });

    const leased = await harness.runRepo.acquireLease(RUN_ID, {
      holderId: 'driver-example-1',
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
    expect(leased.outcome).toBe('saved');

    const admitCalls: unknown[] = [];
    const dispatchCalls: unknown[] = [];
    const deps: AdvanceLaneRunDependencies = {
      runRepo: harness.runRepoStore,
      runJournal: harness.runJournal,
      attemptRepo: harness.attemptRepoStore,
      executionJournal: harness.executionJournal,
      artifactPort: {
        readBriefManifest: async () =>
          JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] }),
        verifyArtifactManifest: async () => ({ outcome: 'missing' }),
      },
      reconcileAttempt: {
        reconcileAttempt: async (request) => ({ outcome: 'not-found', attemptId: request.attemptId }),
      },
      admission: {
        admit: async (request) => {
          admitCalls.push(request);
          return { outcome: 'admitted' };
        },
      },
      newUlid: makeUlidMinter(),
      dispatchAttempt: {
        dispatchAttempt: async (request) => {
          dispatchCalls.push(request);
          const attempt = await harness.attemptRepoStore.findAttemptById(request.attemptId);
          if (attempt === null) {
            throw new Error('example dispatch of a missing attempt');
          }
          return { outcome: 'started', attempt: attempt as AttemptRecord, sessionId: 'session-example-1' };
        },
      } satisfies DispatchAttemptPort,
    };
    const advance = new AdvanceLaneRunUseCase(deps);
    const result = await advance.advanceLaneRun({
      runId: RUN_ID,
      lease: { holderId: 'driver-example-1', fence: 1 },
      halted: false,
      nowIso: LATER,
    });
    expect(result).toMatchObject({ outcome: 'acted', step: 'dispatch' });
    expect(dispatchCalls).toHaveLength(1);
    expect(admitCalls).toHaveLength(0);
  });
});
