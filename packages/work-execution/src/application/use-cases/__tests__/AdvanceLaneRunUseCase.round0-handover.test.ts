/**
 * GB3c tests: a refused FIRST-PASS dispatch at round 0 whose attempt is a
 * seat pivot (`kind === 'initial'` with `priorAttemptId !== null`) hands the
 * dirty worktree to the next first-pass seat unchanged (cancel only, no
 * preserve/reset), exactly as GB3a does for fix attempts. The very first
 * attempt (`priorAttemptId === null`) keeps today's GB3 recovery. Fixtures
 * are copied from the GB3a harness in
 * `../../../../test/DirtyWorktreeHandover.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { SameModelFamily } from '../../../domain/seat-selection.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type {
  FindReviewReceiptRequest,
  FindReviewReceiptResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type {
  PrepareFixAttemptRequest,
  PrepareFixAttemptResult,
} from '../../ports/in/PrepareFixAttemptPort.in-port.js';
import type { PrepareBriefPackageResult } from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  DispatchAttemptRequest,
  DispatchAttemptResult,
} from '../../ports/in/DispatchAttemptPort.in-port.js';
import type {
  CancelPreparedAttemptRequest,
  CancelPreparedAttemptResult,
} from '../../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type {
  PreserveWorktreeEditsRequest,
  PreserveWorktreeEditsResult,
  ResetWorktreeToHeadRequest,
  ResetWorktreeToHeadResult,
} from '../../ports/out/WorkspacePort.out-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const SHA = 'c'.repeat(64);
const DEFAULT_PROSE = '# Task\n\nFix the acceptance problem.\n';
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

const FULL_MANIFEST_JSON = JSON.stringify({
  workOrderId: 'wo-example-1',
  projectId: 'project-example-1',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'example/repo',
  baseCommit: COMMIT_A,
  policyRevision: 'policy-example-1',
  modelAssignment: { model: 'model-example-1', variant: 'default', fallbackModel: 'fallback-model', seatTool: 'opencode' },
  independentReviewer: 'review-model-1',
  ownedPaths: ['packages/example/src'],
  allowedPathPrefixes: ['packages/example/src'],
  permissions: ['filesystem:worktree'],
  acceptanceChecks: ['check-1'],
  acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
  stepLimit: 100,
  timeLimitSeconds: 2700,
  resourceBounds: { cpu: '2' },
  expectedArtifacts: [],
  ownerDecisionReferences: [],
  prNotes: { hardToUndo: 'undo', assumptions: 'assume', challengeThis: 'challenge' },
});

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-example-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

/** At least three first-pass seats, so a pivot's next prepare has room. */
const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
    { id: 'fp-3', model: 'model-example-3', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'fix-model-1', tool: 'opencode' }],
  review: [],
};

const WORK_ORDER: WorkOrderRecord = {
  id: 'wo-example-1',
  projectId: 'project-example-1',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'example/repo',
  baseCommit: COMMIT_A,
  ownedPaths: [],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'reviewing',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

const CONDUCTED_RUNNER: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

function seatSelection(seatIndex: number): AttemptRecord['seatSelection'] {
  return {
    role: 'first-pass',
    seatIndex,
    seatId: 'fp-' + (seatIndex + 1),
    model: 'model-example-' + (seatIndex + 1),
    tool: 'opencode',
    variant: null,
    agent: null,
  };
}

/** Seat 0's cancelled attempt: it was runner-refused and its advance token named seat 1. */
function seat0Cancelled(): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'cancelled',
    outcome: 'stopped',
    revision: 0,
    briefDigest: simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: seatSelection(0),
    stopReason: 'rate-limited',
    createdAtIso: NOW,
    updatedAtIso: LATER,
  };
}

/** Seat 1's prepared pivot attempt: initial, with seat 0 as its prior, same worktree. */
function seat1Prepared(): AttemptRecord {
  return {
    id: 'attempt-example-2',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: 'attempt-example-1',
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: seatSelection(1),
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

/** The run's first attempt (no prior): keeps today's GB3 recovery. */
function firstAttempt(): AttemptRecord {
  return {
    ...seat1Prepared(),
    id: 'attempt-example-1',
    priorAttemptId: null,
    seatSelection: seatSelection(0),
  };
}

function runRecord(overrides: Record<string, unknown> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function makeUlidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

function attemptStepKey(step: 'prepare' | 'dispatch', round: number, seatIndex: number, attemptOrdinal: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round,
    step,
    seatIndex,
    attemptOrdinal,
    head12: null,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a step key');
  }
  return built.key;
}

function prepareKey(round: number, seatIndex: number, attemptOrdinal: number): string {
  return attemptStepKey('prepare', round, seatIndex, attemptOrdinal);
}

function dispatchKey(round: number, seatIndex: number, attemptOrdinal: number): string {
  return attemptStepKey('dispatch', round, seatIndex, attemptOrdinal);
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly fixRequests: PrepareFixAttemptRequest[];
  readonly briefRequests: PrepareBriefPackageUseCaseRequest[];
  readonly dispatchRequests: DispatchAttemptRequest[];
  readonly cancelRequests: CancelPreparedAttemptRequest[];
  readonly preserveRequests: PreserveWorktreeEditsRequest[];
  readonly resetRequests: ResetWorktreeToHeadRequest[];
  readonly deps: AdvanceLaneRunDependencies;
  readonly journalLengthWhenPrepared: number;
  setManifest(json: string | null): void;
  setProse(json: string | null): void;
  setFindReceiptAnswer(answer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult>): void;
  setFixAnswer(answer: (request: PrepareFixAttemptRequest) => Promise<PrepareFixAttemptResult>): void;
  setDispatchAnswer(answer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult>): void;
  setCancelAnswer(answer: CancelPreparedAttemptResult): void;
  setPreserveAnswer(answer: (request: PreserveWorktreeEditsRequest) => Promise<PreserveWorktreeEditsResult>): void;
  setResetAnswer(answer: (request: ResetWorktreeToHeadRequest) => Promise<ResetWorktreeToHeadResult>): void;
  setJournalBaseline(length: number): void;
  markAttemptCancelled(attemptId: string, stopReason: AttemptRecord['stopReason']): Promise<void>;
}

interface HarnessOptions {
  readonly wirePrepareFix?: boolean;
  readonly wireDispatch?: boolean;
  /** When true, the GB3 worktree recovery port is wired (preserve/reset fakes). */
  readonly wireRecovery?: boolean;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const fixRequests: PrepareFixAttemptRequest[] = [];
  const briefRequests: PrepareBriefPackageUseCaseRequest[] = [];
  const dispatchRequests: DispatchAttemptRequest[] = [];
  const cancelRequests: CancelPreparedAttemptRequest[] = [];
  const preserveRequests: PreserveWorktreeEditsRequest[] = [];
  const resetRequests: ResetWorktreeToHeadRequest[] = [];
  let manifestJson: string | null = FULL_MANIFEST_JSON;
  let prose: string | null = DEFAULT_PROSE;
  let journalLengthWhenPrepared = 0;
  let journalLengthBeforeAdvance = 0;
  let findReceiptAnswer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult> = async () => ({
    outcome: 'not-found',
  });
  let prepareAnswer: (request: PrepareFixAttemptRequest) => Promise<PrepareFixAttemptResult> = async (request) => ({
    outcome: 'prepared',
    attempt: { ...seat1Prepared(), id: request.fixAttemptId },
  });
  const prepareBriefAnswer: (request: PrepareBriefPackageUseCaseRequest) => Promise<PrepareBriefPackageResult> = async (request) => ({
    outcome: 'prepared',
    prepared: {
      attemptId: request.attemptId ?? '',
      briefDigest: simpleDeterministicHexDigest(request.proseMarkdown + '\n' + manifestJson),
      prosePath: '.lane/brief.md',
      manifestPath: '.lane/brief-manifest.json',
      selectedKnowledgeVersions: [],
    },
  });
  let dispatchAnswer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult> = async (request) => ({
    outcome: 'started',
    attempt: { ...seat1Prepared(), id: request.attemptId },
    sessionId: 'session-example-1',
  });
  let cancelAnswer: CancelPreparedAttemptResult = {
    outcome: 'cancelled',
    attempt: seat1Prepared(),
    capacity: 'released',
  };
  let preserveAnswer: (request: PreserveWorktreeEditsRequest) => Promise<PreserveWorktreeEditsResult> = async (request) => ({
    outcome: 'preserved',
    patchPath: request.patchPath,
    patchBytes: 42,
  });
  let resetAnswer: (request: ResetWorktreeToHeadRequest) => Promise<ResetWorktreeToHeadResult> = async () => ({
    outcome: 'reset',
    headCommit: COMMIT_A,
  });

  const created = await runRepo.create(record);
  expect(created.outcome).toBe('saved');
  const leased = await runRepo.acquireLease(record.runId, {
    holderId: HOLDER,
    observedFence: 0,
    leaseUntilIso: LEASE_UNTIL,
    nowIso: NOW,
  });
  expect(leased.outcome).toBe('saved');
  for (const attempt of attempts) {
    await attemptRepo.saveAttempt(attempt);
  }

  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    artifactPort: {
      readChangedPaths: async () => null,
      readBriefManifest: async (worktreePath, manifestPath, recordedHost) => {
        void worktreePath;
        void manifestPath;
        void recordedHost;
        return manifestJson;
      },
      readBriefFile: async () => prose,
      verifyArtifactManifest: async () => ({ outcome: 'sealed' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({
        outcome: 'active',
        attempt: attempts[attempts.length - 1] ?? seat0Cancelled(),
        status: {
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'active',
          completionReceipt: null,
          artifactsCollected: false,
        },
      }),
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    cancelPreparedAttempt: {
      cancelPreparedAttempt: async (request) => {
        cancelRequests.push(request);
        const existing = await attemptRepo.findAttemptById(request.attemptId);
        if (cancelAnswer.outcome === 'cancelled' && existing !== null && existing.state === 'intent-recorded') {
          const cancelled: AttemptRecord = {
            ...existing,
            revision: (existing.revision ?? 0) + 1,
            state: 'cancelled',
            outcome: 'stopped',
            updatedAtIso: request.nowIso,
          };
          await attemptRepo.saveAttempt(cancelled);
          const released = await executionJournal.releaseCapacityReservation(request.attemptId, request.nowIso);
          return { outcome: 'cancelled', attempt: cancelled, capacity: released ? 'released' as const : 'none-held' as const };
        }
        return cancelAnswer;
      },
    },
    runnerForAttempt: {
      runnerForAttempt: () => ({
        ok: true,
        runner: {
          inspectWorktreeRun: async () => ({ state: 'idle' }),
        } as unknown as ExecutionRunnerPort,
      }),
    },
    newUlid: makeUlidMinter(),
    sameModelFamily: ((left: string, right: string) => left === right) as SameModelFamily,
    workOrderRepo: {
      findWorkOrderById: async () => WORK_ORDER,
    },
    reviewRequest: {
      requestReview: async () => ({ outcome: 'unknown', reason: 'delegate-failed' }),
      findReviewReceipt: (request) => findReceiptAnswer(request),
      findLatestReceiptOfKind: async () => ({ outcome: 'not-found' }),
    },
    ...(options.wirePrepareFix === false
      ? {}
      : {
          prepareFixAttempt: {
            prepareFixAttempt: async (request) => {
              fixRequests.push(request);
              journalLengthWhenPrepared = (await runJournal.listForRun(RUN_ID)).length;
              expect(journalLengthWhenPrepared).toBe(journalLengthBeforeAdvance + 1);
              const prepared = await prepareAnswer(request);
              if (prepared.outcome === 'prepared') {
                await attemptRepo.saveAttempt(prepared.attempt);
              }
              return prepared;
            },
          },
        }),
    prepareBrief: {
      prepareBriefPackage: async (request) => {
        briefRequests.push(request);
        const answer = await prepareBriefAnswer(request);
        if (answer.outcome === 'prepared' && typeof request.proseMarkdown === 'string') {
          prose = request.proseMarkdown;
        }
        return answer;
      },
      previewBriefPackage: async () => ({
        outcome: 'previewed',
        preview: {
          attemptId: '',
          briefDigest: SHA,
          modelAssignment: { model: 'model-example-1', variant: 'default', seatTool: 'opencode' },
          seatPlan: null,
          acceptance: { commitRequired: true, diffCheck: true, commandCount: 1, commandDigests: [] },
          prNotesPresent: false,
          selectedKnowledgeVersions: [],
        },
      }),
    },
    ...(options.wireDispatch === false
      ? {}
      : {
          dispatchAttempt: {
            dispatchAttempt: async (request) => {
              dispatchRequests.push(request);
              return dispatchAnswer(request);
            },
          },
        }),
    ...(options.wireRecovery
      ? {
          worktreeRecovery: {
            preserveWorktreeEdits: async (request) => {
              preserveRequests.push(request);
              return preserveAnswer(request);
            },
            resetWorktreeToHead: async (request) => {
              resetRequests.push(request);
              return resetAnswer(request);
            },
          },
        }
      : {}),
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    fixRequests,
    briefRequests,
    dispatchRequests,
    cancelRequests,
    preserveRequests,
    resetRequests,
    deps,
    get journalLengthWhenPrepared() {
      return journalLengthWhenPrepared;
    },
    setManifest: (json) => {
      manifestJson = json;
    },
    setProse: (json) => {
      prose = json;
    },
    setFindReceiptAnswer: (answer) => {
      findReceiptAnswer = answer;
    },
    setFixAnswer: (answer) => {
      prepareAnswer = answer;
    },
    setDispatchAnswer: (answer) => {
      dispatchAnswer = answer;
    },
    setCancelAnswer: (answer) => {
      cancelAnswer = answer;
    },
    setPreserveAnswer: (answer) => {
      preserveAnswer = answer;
    },
    setResetAnswer: (answer) => {
      resetAnswer = answer;
    },
    setJournalBaseline: (length) => {
      journalLengthBeforeAdvance = length;
    },
    markAttemptCancelled: async (attemptId, stopReason) => {
      const existing = await attemptRepo.findAttemptById(attemptId);
      expect(existing).not.toBeNull();
      await attemptRepo.saveAttempt({
        ...(existing ?? seat0Cancelled()),
        revision: (existing?.revision ?? 0) + 1,
        state: 'cancelled',
        stopReason,
        updatedAtIso: LATER,
      });
    },
  };
}

async function advance(harness: Harness, overrides: Record<string, unknown> = {}) {
  harness.setJournalBaseline((await harness.runJournal.listForRun(RUN_ID)).length);
  const useCase = new AdvanceLaneRunUseCase(harness.deps);
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...overrides,
  });
}

async function conduct(harness: Harness, state: LaneRunStateValue, nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendIntent(
  harness: Harness,
  key: string,
  mintedId: string | null,
  recordedAtIso: string,
): Promise<void> {
  const entry = laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, key, mintedId, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendResult(
  harness: Harness,
  key: string,
  outcome: LaneRunJournalOutcome,
  reasonCode: LaneRunResultReasonCode,
  recordedAtIso: string,
  detail: string | null = null,
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso, detail);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function admit(harness: Harness, attemptId: string): Promise<void> {
  await harness.executionJournal.saveCapacityReservation({
    id: harness.deps.newUlid(),
    attemptId,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
}

/** The GB2-shaped round-0 pivot base: seat 0 cancelled with its advance token, seat 1 prepared. */
async function seedRound0Pivot(harness: Harness): Promise<void> {
  const seat0Dispatch = dispatchKey(0, 0, 1);
  await appendIntent(harness, seat0Dispatch, 'attempt-example-1', NOW);
  await appendResult(harness, seat0Dispatch, 'refused', 'runner-refused', NOW, 'next-seat-rate-limited-1');
  await conduct(harness, 'seat-failed', NOW);
  await admit(harness, 'attempt-example-2');
}

describe('AdvanceLaneRunUseCase round-0 pivot handover (GB3c)', () => {
  const WORKTREE_REFUSAL = 'Worktree ' + WORKTREE + ' has uncommitted changes: src/ex.ts';
  const WORKTREE_UNTRACKED_REFUSAL = 'Worktree ' + WORKTREE + ' has untracked files: notes.txt';
  const WORKTREE_RESIDUE_REFUSAL = 'Worktree ' + WORKTREE + ' contains residue from earlier attempts: x';

  it('1. an uncommitted refusal at round 0 hands the pivot seat over: cancel only, no park, no preserve/reset', async () => {
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [seat0Cancelled(), seat1Prepared()],
      { wireRecovery: true },
    );
    await seedRound0Pivot(harness);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(0, 1, 2),
      result: 'refused',
      reasonCode: 'dispatch-refused',
    });

    // The attempt is cancelled, the run is NOT parked, and the dirty detail is journalled.
    expect((await harness.attemptRepo.findAttemptById('attempt-example-2'))?.state).toBe('cancelled');
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        outcome: 'refused',
        reasonCode: 'dispatch-refused',
        detail: 'worktree-uncommitted',
      }),
    );

    // None of the GB3 preserve/reset side effects run; cancel is the only side effect.
    expect(harness.preserveRequests).toEqual([]);
    expect(harness.resetRequests).toEqual([]);
    expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-2', nowIso: LATER }]);
  });

  it('2. an untracked refusal at round 0 also hands the pivot seat over', async () => {
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [seat0Cancelled(), seat1Prepared()],
      { wireRecovery: true },
    );
    await seedRound0Pivot(harness);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_UNTRACKED_REFUSAL }));

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(0, 1, 2),
      result: 'refused',
      reasonCode: 'dispatch-refused',
    });
    expect((await harness.attemptRepo.findAttemptById('attempt-example-2'))?.state).toBe('cancelled');
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    expect(harness.preserveRequests).toEqual([]);
    expect(harness.resetRequests).toEqual([]);
    expect(harness.cancelRequests).toHaveLength(1);
  });

  it('3. the next seat hands over with allowUncommittedHandover and the same worktree', async () => {
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [seat0Cancelled(), seat1Prepared()],
      { wireRecovery: true },
    );
    await seedRound0Pivot(harness);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'dispatch', result: 'refused' });

    // The next advance prepares the next first-pass seat (the recorded advance).
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(0, 1, 3),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const nextAttemptId = (await harness.runRepo.get(RUN_ID))?.attemptIds[2];
    expect(typeof nextAttemptId).toBe('string');
    await admit(harness, nextAttemptId as string);

    // Its dispatch carries the handed-over worktree flag and the same worktree; never reset.
    harness.setDispatchAnswer(async (request) => ({
      outcome: 'started',
      attempt: { ...seat1Prepared(), id: request.attemptId },
      sessionId: 'session-example-2',
    }));
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted',
      step: 'dispatch',
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(2);
    expect(harness.dispatchRequests[0]?.allowUncommittedHandover).toBeUndefined();
    expect(harness.dispatchRequests[1]?.allowUncommittedHandover).toBe(true);
    expect(harness.dispatchRequests[1]?.worktreePath).toBe(WORKTREE);
    expect(harness.resetRequests).toEqual([]);
    expect(harness.preserveRequests).toEqual([]);
  });

  it('4. a cancel that does not land parks the run at dispatch without preserve/reset', async () => {
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [seat0Cancelled(), seat1Prepared()],
      { wireRecovery: true },
    );
    await seedRound0Pivot(harness);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
    harness.setCancelAnswer({ outcome: 'refused', reason: 'changed' });

    expect(await advance(harness)).toEqual({
      outcome: 'parked',
      reason: 'step-refused',
      qualifier: 'dispatch',
    });
    expect(harness.preserveRequests).toEqual([]);
    expect(harness.resetRequests).toEqual([]);
    expect(harness.cancelRequests).toHaveLength(1);
  });

  it('5. a non-dirty refusal never hands over: it parks without calling cancel', async () => {
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [seat0Cancelled(), seat1Prepared()],
      { wireRecovery: true },
    );
    await seedRound0Pivot(harness);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_RESIDUE_REFUSAL }));

    expect(await advance(harness)).toEqual({
      outcome: 'parked',
      reason: 'step-refused',
      qualifier: 'dispatch',
    });
    expect(harness.cancelRequests).toEqual([]);
    expect(harness.preserveRequests).toEqual([]);
    expect(harness.resetRequests).toEqual([]);
  });

  it('6. the first attempt (no prior) keeps today\'s GB3 recovery for uncommitted work', async () => {
    const harness = await makeHarness(runRecord(), [firstAttempt()], { wireRecovery: true });
    await admit(harness, 'attempt-example-1');
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(0, 0, 1),
      result: 'refused',
      reasonCode: 'dispatch-refused',
    });
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('cancelled');
    // The old path preserves and resets, and journals the patch path.
    expect(harness.preserveRequests).toHaveLength(1);
    expect(harness.resetRequests).toHaveLength(1);
    expect(harness.cancelRequests).toHaveLength(1);
    const preserved = (await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1')).filter(
      (entry) => entry.action === 'dispatch' && entry.detail !== null && entry.detail.startsWith('preserved uncommitted edits:'),
    );
    expect(preserved.map((entry) => entry.status)).toEqual(['intent-recorded', 'completed']);
  });
});
