/**
 * GB3a tests: a refused FIX dispatch hands the dirty worktree to the next fix
 * seat unchanged (cancel only, no preserve/reset), the next fix brief opens
 * with the handover note, and the next dispatch accepts the handed-over
 * worktree. Fixtures are copied from the GB3 harness in
 * `src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts`
 * and `advance-lane-run-dispatch.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../src/domain/execution-records.js';
import { LaneRun } from '../src/domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../src/domain/lane-run-records.js';
import type { LaneRunStateValue } from '../src/domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey } from '../src/domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../src/domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome, LaneRunJournalEntryRecord } from '../src/domain/lane-run-journal.js';
import { renderHandoverBrief } from '../src/domain/lane-run-handover.js';
import type { SameModelFamily } from '../src/domain/seat-selection.js';
import { LaneRunRepositoryAdapter } from '../src/infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../src/infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../src/infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../src/infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../src/application/use-cases/AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../src/application/use-cases/AdvanceLaneRunUseCase.use-case.js';
import type { SessionStartGate } from '../src/application/ports/in/AdvanceLaneRunPort.in-port.js';
import type {
  FindReviewReceiptRequest,
  FindReviewReceiptResult,
  ReviewRequest,
  ReviewRequestFinding,
  ReviewRequestResult,
} from '../src/application/ports/out/ReviewRequestPort.out-port.js';
import type {
  PrepareFixAttemptRequest,
  PrepareFixAttemptResult,
} from '../src/application/ports/in/PrepareFixAttemptPort.in-port.js';
import type { PrepareBriefPackageResult } from '../src/application/ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../src/application/use-cases/PrepareBriefPackageUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../src/application/use-cases/PrepareBriefPackageUseCase.use-case.js';
import type {
  DispatchAttemptRequest,
  DispatchAttemptResult,
} from '../src/application/ports/in/DispatchAttemptPort.in-port.js';
import type { CancelPreparedAttemptRequest } from '../src/application/ports/in/CancelPreparedAttemptPort.in-port.js';
import type { ExecutionRunnerPort } from '../src/application/ports/out/ExecutionRunnerPort.out-port.js';
import type {
  EvaluateAttemptGateRequest,
  EvaluateAttemptGateResult,
} from '../src/application/ports/in/EvaluateAttemptGatePort.in-port.js';
import type { GatePredicateResult } from '../src/application/ports/out/GatePredicatePort.out-port.js';
import type {
  OpenReviewAssessmentRequest,
  OpenReviewAssessmentResult,
} from '../src/application/ports/out/ReviewAssessmentPort.out-port.js';
import type {
  RecordGateReceiptsRequest,
  RecordGateReceiptsResult,
} from '../src/application/ports/out/GateReceiptPort.out-port.js';
import type {
  PreserveWorktreeEditsRequest,
  PreserveWorktreeEditsResult,
  ResetWorktreeToHeadRequest,
  ResetWorktreeToHeadResult,
} from '../src/application/ports/out/WorkspacePort.out-port.js';
import { lastDispatchLeftDirtyWorktree } from '../src/application/use-cases/advance-lane-run/dirty-handover.js';
import { DispatchAttemptUseCase } from '../src/application/use-cases/DispatchAttemptUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
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

const HANDOVER_NOTE = '[handover] The previous seat left uncommitted work in this worktree; finish that work and commit it. Do not discard it.';

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

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
  ],
  fix: [
    { id: 'fx-1', model: 'fix-model-1', tool: 'opencode' },
    { id: 'fx-2', model: 'fix-model-2', tool: 'opencode' },
  ],
  review: [
    { id: 'rev-1', model: 'review-model-1', tool: 'opencode' },
  ],
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

function collectedAttempt(headCommit: string = COMMIT_A): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'collected',
    outcome: null,
    revision: 0,
    briefDigest: simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: {
      attemptId: 'attempt-example-1',
      sessionId: 'session-example-1',
      endedAtIso: LATER,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: {
      headCommit,
      commitsSinceBase: [headCommit],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'fp-1',
      model: 'model-example-1',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

function buildFixAttempt(request: PrepareFixAttemptRequest, seatIndex: number): AttemptRecord {
  const seatId = seatIndex === 0 ? 'fx-1' : 'fx-2';
  return {
    id: request.fixAttemptId,
    workOrderId: request.workOrderId,
    kind: 'fix',
    fixNumber: 1,
    priorAttemptId: request.priorAttemptId,
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: request.briefDigest ?? SHA,
    briefPackagePath: request.briefPackagePath ?? '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: {
      role: 'fix',
      seatIndex,
      seatId,
      model: seatIndex === 0 ? 'fix-model-1' : 'fix-model-2',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    createdAtIso: request.nowIso ?? NOW,
    updatedAtIso: request.nowIso ?? NOW,
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

function reviewKey(step: 'brief-check' | 'code-review', seatIndex: number, head12: string): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step,
    seatIndex,
    attemptOrdinal: null,
    head12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a review key');
  }
  return built.key;
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
    attempt: buildFixAttempt(request, 0),
  });
  let prepareBriefAnswer: (request: PrepareBriefPackageUseCaseRequest) => Promise<PrepareBriefPackageResult> = async (request) => ({
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
    attempt: buildFixAttempt({ fixAttemptId: request.attemptId, workOrderId: record.workOrderId, priorAttemptId: 'attempt-example-1', numberedFixes: [] }, 0),
    sessionId: 'session-example-1',
  });
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
      readBriefManifest: async () => manifestJson,
      readBriefFile: async () => prose,
      verifyArtifactManifest: async () => ({ outcome: 'sealed' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({
        outcome: 'active',
        attempt: attempts[attempts.length - 1] ?? collectedAttempt(),
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
        if (existing === null || existing.state !== 'intent-recorded') {
          return { outcome: 'refused', reason: 'not-prepared' } as const;
        }
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
    sameModelFamily: (left, right) => left === right,
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
        ...(existing ?? collectedAttempt()),
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

function blockerFinding(): ReviewRequestFinding {
  return { findingId: 'finding-1', severity: 'blocker', summary: 'blocks the acceptance check', filePath: 'src/ex.ts', line: 4 };
}

async function seedReviewFailure(harness: Harness, findings: readonly ReviewRequestFinding[]): Promise<void> {
  const key = reviewKey('code-review', 0, HEAD12_A);
  const requestId = 'review-' + harness.deps.newUlid();
  await appendIntent(harness, key, requestId, NOW);
  await appendResult(harness, key, 'completed', 'review-failed', NOW);
  await conduct(harness, 'fixing', NOW);
  harness.setFindReceiptAnswer(async (request) => ({
    outcome: 'found',
    receipt: {
      receiptId: 'rcpt-' + request.requestId,
      requestId: request.requestId,
      kind: 'code-review',
      reviewerModel: 'review-model-1',
      candidateHeadSha: COMMIT_A,
      verdict: 'failed',
      findings,
    },
  }));
}

describe('lastDispatchLeftDirtyWorktree (GB3a)', () => {
  const worktreeUncommitted = 'worktree-uncommitted';
  const worktreeUntracked = 'worktree-untracked';
  const worktreeResidue = 'worktree-residue';

  function dispatchRefused(detail: string): LaneRunJournalEntryRecord {
    return laneRunResultEntry('01JB0000000000000000000001', RUN_ID, dispatchKey(1, 0, 2), 'refused', 'dispatch-refused', NOW, detail);
  }

  it('returns true when the last final dispatch-step result is dispatch-refused with detail worktree-uncommitted', () => {
    const entries = [dispatchRefused(worktreeUncommitted)];
    expect(lastDispatchLeftDirtyWorktree(entries, RUN_ID)).toBe(true);
  });

  it('returns true for worktree-untracked', () => {
    const entries = [dispatchRefused(worktreeUntracked)];
    expect(lastDispatchLeftDirtyWorktree(entries, RUN_ID)).toBe(true);
  });

  it('returns false for another detail such as worktree-residue', () => {
    const entries = [dispatchRefused(worktreeResidue)];
    expect(lastDispatchLeftDirtyWorktree(entries, RUN_ID)).toBe(false);
  });

  it('returns false when a later dispatch result is dispatch-started', () => {
    const entries = [
      dispatchRefused(worktreeUncommitted),
      laneRunResultEntry('01JB0000000000000000000002', RUN_ID, dispatchKey(1, 1, 3), 'completed', 'dispatch-started', LATER),
    ];
    expect(lastDispatchLeftDirtyWorktree(entries, RUN_ID)).toBe(false);
  });

  it('returns false for an empty journal', () => {
    expect(lastDispatchLeftDirtyWorktree([], RUN_ID)).toBe(false);
  });

  it('returns false when the latest dispatch result is ambiguous-only', () => {
    const entries = [
      laneRunResultEntry('01JB0000000000000000000001', RUN_ID, dispatchKey(1, 0, 2), 'ambiguous', 'dispatch-unknown', NOW, 'unknown'),
      laneRunResultEntry('01JB0000000000000000000002', RUN_ID, dispatchKey(1, 0, 2), 'ambiguous', 'dispatch-unknown', LATER, 'unknown'),
    ];
    expect(lastDispatchLeftDirtyWorktree(entries, RUN_ID)).toBe(false);
  });

  it('ignores entries of other runs and non-dispatch steps', () => {
    const otherRun = laneRunResultEntry('01JB0000000000000000000001', 'run-01JB0000000000000000000001', dispatchKey(1, 0, 2), 'refused', 'dispatch-refused', NOW, worktreeUncommitted);
    const review = laneRunResultEntry('01JB0000000000000000000002', RUN_ID, reviewKey('code-review', 0, HEAD12_A), 'completed', 'review-failed', NOW);
    expect(lastDispatchLeftDirtyWorktree([otherRun, review], RUN_ID)).toBe(false);
  });
});

describe('renderHandoverBrief with uncommittedHandover (GB3a)', () => {
  const baseInput = {
    runId: RUN_ID,
    round: 1 as const,
    branchName: 'wt-example-1',
    head12: HEAD12_A,
    source: 'review' as const,
    findings: [
      { findingId: 'finding-1', severity: 'major' as const, summary: 'fix the thing', filePath: 'src/ex.ts', line: 4 },
    ],
    gateReasonCodes: [],
    gatePredicates: [],
    proofCommands: [['corepack', 'yarn', 'build']],
    originalBrief: DEFAULT_PROSE,
  };

  it('prepends the note to numberedFixes and text when uncommittedHandover is true', () => {
    const rendered = renderHandoverBrief({ ...baseInput, uncommittedHandover: true });
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.numberedFixes[0]).toBe(HANDOVER_NOTE);
      expect(rendered.text).toContain('previous seat left uncommitted work');
      expect(rendered.text).toContain(HANDOVER_NOTE);
    }
  });

  it('without the flag the output is identical to today\'s', () => {
    const rendered = renderHandoverBrief(baseInput);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.numberedFixes[0]).toBe('[major] src/ex.ts:4 — fix the thing');
      expect(rendered.numberedFixes).not.toContain(HANDOVER_NOTE);
      expect(rendered.text).not.toContain('previous seat left uncommitted work');
    }
  });
});

describe('DispatchAttemptUseCase allowUncommittedHandover (GB3a)', () => {
  // Fixtures copied from dispatch-records-time-limit.test.ts.
  const FAKE_BRIEF_PROSE = '# Frozen brief prose';
  const FAKE_BRIEF_FILE = JSON.stringify({
    modelAssignment: {
      model: 'nvidia/z-ai/glm-5.3',
      agent: 'lane-agent',
      variant: 'default',
    },
    independentReviewer: 'reviewer-model',
  });
  const FAKE_BRIEF_DIGEST = simpleDeterministicHexDigest(FAKE_BRIEF_PROSE + '\n' + FAKE_BRIEF_FILE);

  function makeWorkOrderRepo() {
    const orders = new Map<string, WorkOrderRecord>();
    orders.set('wo-1', {
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
    });
    return {
      orders,
      async findWorkOrderById(workOrderId: string) {
        return orders.get(workOrderId) ?? null;
      },
    };
  }

  function makeJournal() {
    const entries: { attemptId: string; detail: string }[] = [];
    const reservations = new Map<string, { attemptId: string; held: boolean }>();
    reservations.set('res-1', { attemptId: 'attempt-1', held: true });
    return {
      entries,
      reservations,
      async appendJournalEntry(entry: { attemptId: string; detail: string }) {
        entries.push(entry);
      },
      async listJournalEntriesForAttempt() {
        return [];
      },
      async saveCapacityReservation() {},
      async listActiveReservations() {
        return [...reservations.values()].filter((r) => r.held);
      },
      async releaseCapacityReservation() {
        return true;
      },
      async reserveCapacityAtomically() {
        return { outcome: 'reserved' as const, reservation: null as never };
      },
    };
  }

  function makeDispatchSetup(inspection: Record<string, unknown>) {
    const workOrderRepo = makeWorkOrderRepo();
    const attemptRepo = {
      attempts: new Map<string, AttemptRecord>(),
      saved: [] as AttemptRecord[],
      async saveAttempt(record: AttemptRecord) {
        attemptRepo.saved.push(record);
        attemptRepo.attempts.set(record.id, record);
      },
      async findAttemptById(attemptId: string) {
        return attemptRepo.attempts.get(attemptId) ?? null;
      },
      async listAttemptsByWorkOrder() {
        return [];
      },
      async listAllAttempts() {
        return [];
      },
    };
    const journal = makeJournal();
    const runner = {
      describeCapabilities: () => ({
        filesystemScope: 'scoped-worktree' as const,
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        authoritativeCompletion: true,
        artifactPersistence: true,
      }),
      describeRunner: () => ({
        kind: 'opencode' as const,
        remotePort: 4166,
        host: null,
        agent: null,
        model: 'nvidia/z-ai/glm-5.3',
        variant: 'default',
      }),
      async startSession() {
        return { outcome: 'started' as const, sessionId: 'session-1' };
      },
      async stopSession() {
        return { outcome: 'still-running' as const, reason: 'grace period elapsed' };
      },
    };
    const workspace = {
      async inspectWorktree(request: { baseCommit: string; worktreePath: string }) {
        return {
          worktreePath: request.worktreePath,
          checkedOutCommit: request.baseCommit,
          matchesBaseCommit: true,
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
          ...inspection,
        };
      },
      async readWorktreeFile(_worktreePath: string, relativePath: string) {
        return relativePath === '.lane/brief-manifest.json' ? FAKE_BRIEF_FILE : FAKE_BRIEF_PROSE;
      },
    };
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace,
      runner,
      computeDigest: simpleDeterministicHexDigest,
    });
    return { useCase, workspace, journal };
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

  it('refuses uncommitted changes without the flag and accepts them with it', async () => {
    const withoutFlag = makeDispatchSetup({ uncommittedPaths: ['a.ts'] });
    const refused = await withoutFlag.useCase.dispatchAttempt(validDispatchRequest());
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.reason).toContain('has uncommitted changes');
    }

    const withFlag = makeDispatchSetup({ uncommittedPaths: ['a.ts'] });
    const accepted = await withFlag.useCase.dispatchAttempt(validDispatchRequest({ allowUncommittedHandover: true }));
    expect(accepted.outcome).toBe('started');
  });

  it('refuses untracked files without the flag and accepts them with it', async () => {
    const withoutFlag = makeDispatchSetup({ untrackedPaths: ['b.ts'] });
    const refused = await withoutFlag.useCase.dispatchAttempt(validDispatchRequest());
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.reason).toContain('has untracked files');
    }

    const withFlag = makeDispatchSetup({ untrackedPaths: ['b.ts'] });
    const accepted = await withFlag.useCase.dispatchAttempt(validDispatchRequest({ allowUncommittedHandover: true }));
    expect(accepted.outcome).toBe('started');
  });

  it('the head-match check stays unconditional: still refused with the flag when matchesBaseCommit is false', async () => {
    const setup = makeDispatchSetup({ matchesBaseCommit: false, checkedOutCommit: 'def456' });
    const result = await setup.useCase.dispatchAttempt(validDispatchRequest({ allowUncommittedHandover: true }));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('does not match the base commit');
    }
  });

  it('the residue check stays unconditional: still refused with the flag when residue is present', async () => {
    const setup = makeDispatchSetup({ residueFromEarlierAttempts: ['old.txt'] });
    const result = await setup.useCase.dispatchAttempt(validDispatchRequest({ allowUncommittedHandover: true }));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('contains residue from earlier attempts');
    }
  });
});

describe('GB3a: refused fix dispatch hands the dirty worktree to the next seat', () => {
  const WORKTREE_REFUSAL = 'Worktree ' + WORKTREE + ' has uncommitted changes: src/ex.ts';
  const WORKTREE_UNTRACKED_REFUSAL = 'Worktree ' + WORKTREE + ' has untracked files: notes.txt';

  it('T4: a fix dispatch refused with the dirty detail cancels the attempt, acts without parking, and calls never preserve or reset', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()], { wireRecovery: true });
    await seedReviewFailure(harness, [blockerFinding()]);

    // Fix round 1 prepares a2.
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);

    // a2's dispatch is refused because the worktree has uncommitted changes.
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'dispatch-refused',
    });

    // The attempt is cancelled and the run is NOT parked.
    expect((await harness.attemptRepo.findAttemptById(fixAttemptId as string))?.state).toBe('cancelled');
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toBeNull();
    expect(after?.round).toBe(1);

    // The refusal is journalled with the dirty detail.
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        outcome: 'refused',
        reasonCode: 'dispatch-refused',
        detail: 'worktree-uncommitted',
      }),
    );

    // None of the GB3 preserve/reset side effects run.
    expect(harness.preserveRequests).toEqual([]);
    expect(harness.resetRequests).toEqual([]);
    expect(harness.cancelRequests).toEqual([{ attemptId: fixAttemptId, nowIso: LATER }]);
  });

  it('T4: a fix dispatch refused with the untracked detail also hands over without preserve or reset', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()], { wireRecovery: true });
    await seedReviewFailure(harness, [blockerFinding()]);
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed' });
    const fixAttemptId = (await harness.runRepo.get(RUN_ID))?.attemptIds[1];
    await admit(harness, fixAttemptId as string);

    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_UNTRACKED_REFUSAL }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'dispatch-refused',
    });
    expect((await harness.attemptRepo.findAttemptById(fixAttemptId as string))?.state).toBe('cancelled');
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    expect(harness.preserveRequests).toEqual([]);
    expect(harness.resetRequests).toEqual([]);
  });

  it('T4: an initial (non-fix) attempt refused with worktree-uncommitted still takes the old GB3 path', async () => {
    const firstAttempt: AttemptRecord = {
      ...collectedAttempt(),
      state: 'intent-recorded',
      completionReceipt: null,
      artifacts: null,
    };
    const harness = await makeHarness(runRecord(), [firstAttempt], { wireRecovery: true });
    await admit(harness, 'attempt-example-1');
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(0, 0, 1),
      result: 'refused',
      reasonCode: 'dispatch-refused',
    });
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('cancelled');
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    // The old path preserves and resets, and journals the patch path.
    expect(harness.preserveRequests).toHaveLength(1);
    expect(harness.resetRequests).toHaveLength(1);
    const preserved = (await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1')).filter(
      (entry) => entry.action === 'dispatch' && entry.detail !== null && entry.detail.startsWith('preserved uncommitted edits:'),
    );
    expect(preserved.map((entry) => entry.status)).toEqual(['intent-recorded', 'completed']);
  });

  it('T5: the next fix prepare opens with the handover note and the next dispatch carries allowUncommittedHandover', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()], { wireRecovery: true });
    await seedReviewFailure(harness, [blockerFinding()]);

    // Fix round 1 prepares a2 and its dispatch is refused dirty (T4).
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed' });
    const a2Id = (await harness.runRepo.get(RUN_ID))?.attemptIds[1];
    await admit(harness, a2Id as string);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'dispatch', result: 'refused', reasonCode: 'dispatch-refused' });

    // The next advance prepares a3; its numberedFixes open with the note.
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 1, 3),
      result: 'completed',
      reasonCode: 'prepared',
    });
    expect(harness.fixRequests).toHaveLength(2);
    expect(harness.fixRequests[1]?.numberedFixes[0]).toBe(HANDOVER_NOTE);
    expect(harness.briefRequests[1]?.proseMarkdown).toContain('previous seat left uncommitted work');

    // a3 dispatches with the handed-over worktree accepted.
    const a3Id = (await harness.runRepo.get(RUN_ID))?.attemptIds[2];
    expect(typeof a3Id).toBe('string');
    await admit(harness, a3Id as string);
    harness.setDispatchAnswer(async (request) => ({
      outcome: 'started',
      attempt: buildFixAttempt({ fixAttemptId: request.attemptId, workOrderId: 'wo-example-1', priorAttemptId: 'attempt-example-1', numberedFixes: [] }, 1),
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

    // A later fix round after a dispatch-started result carries no flag.
    const frozenDigest = simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON);
    const later = await makeHarness(
      runRecord({ round: 1, attemptIds: ['attempt-example-1', 'attempt-fix-a', 'attempt-fix-b'] }),
      [
        collectedAttempt(),
        {
          ...buildFixAttempt({ fixAttemptId: 'attempt-fix-a', workOrderId: 'wo-example-1', priorAttemptId: 'attempt-example-1', numberedFixes: [] }, 0),
          state: 'cancelled',
          outcome: 'stopped',
        },
        buildFixAttempt({ fixAttemptId: 'attempt-fix-b', workOrderId: 'wo-example-1', priorAttemptId: 'attempt-example-1', numberedFixes: [], briefDigest: frozenDigest }, 1),
      ],
    );
    await appendIntent(later, reviewKey('code-review', 0, HEAD12_A), 'review-later', NOW);
    await appendResult(later, reviewKey('code-review', 0, HEAD12_A), 'completed', 'review-failed', NOW);
    await conduct(later, 'fixing', NOW);
    // The previous fix attempt dispatched STARTED — the last final dispatch result.
    await appendIntent(later, dispatchKey(1, 0, 2), 'attempt-fix-a', NOW);
    await appendResult(later, dispatchKey(1, 0, 2), 'completed', 'dispatch-started', NOW);
    // The current fix attempt was prepared (its placement) and is ready to dispatch.
    await appendIntent(later, prepareKey(1, 1, 3), 'attempt-fix-b', NOW);
    await appendResult(later, prepareKey(1, 1, 3), 'completed', 'prepared', NOW);
    await admit(later, 'attempt-fix-b');
    expect(await advance(later)).toMatchObject({
      outcome: 'acted',
      step: 'dispatch',
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(later.dispatchRequests).toHaveLength(1);
    expect(later.dispatchRequests[0]?.allowUncommittedHandover).toBeUndefined();
  });
});
