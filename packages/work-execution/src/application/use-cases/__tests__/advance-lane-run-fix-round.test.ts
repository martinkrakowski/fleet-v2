/**
 * Unit tests for K5-5: `act prepare` for fix rounds 1 and 2 prepares a fix
 * attempt through `PrepareFixAttemptPort` with `renderHandoverBrief` rendered
 * from the failure that sent the run to `fixing` — numbered findings from the
 * review receipt, or the gate's reason codes. The decider chooses the act from
 * the journal state; every store is in-memory; no runner, no subprocess, no
 * network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from '../../../domain/lane-run-journal.js';
import { dispatchRefusalDetail, fixSeatForDispatch } from '../advance-lane-run/prepare-dispatch.js';
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
  ReviewRequest,
  ReviewRequestFinding,
  ReviewRequestResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type {
  PrepareFixAttemptRequest,
  PrepareFixAttemptResult,
} from '../../ports/in/PrepareFixAttemptPort.in-port.js';
import type {
  PrepareBriefPackageResult,
} from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import { ORIGINAL_BRIEF_MARKER, originalBriefOf, renderHandoverBrief } from '../../../domain/lane-run-handover.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  DispatchAttemptRequest,
  DispatchAttemptResult,
} from '../../ports/in/DispatchAttemptPort.in-port.js';
import type {
  CancelPreparedAttemptRequest,
} from '../../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type {
  EvaluateAttemptGateRequest,
  EvaluateAttemptGateResult,
} from '../../ports/in/EvaluateAttemptGatePort.in-port.js';
import type { GatePredicateResult } from '../../ports/out/GatePredicatePort.out-port.js';
import type {
  OpenReviewAssessmentRequest,
  OpenReviewAssessmentResult,
} from '../../ports/out/ReviewAssessmentPort.out-port.js';
import type {
  RecordGateReceiptsRequest,
  RecordGateReceiptsResult,
} from '../../ports/out/GateReceiptPort.out-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
const SHA = 'c'.repeat(64);
/** The frozen prose the harness reads back for an attempt's `.lane/brief.md`; its digest seals the prior. */
const DEFAULT_PROSE = '# Task\n\nFix the acceptance problem.\n';
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

/** The frozen manifest a conducted run writes: every field the fix-round brief rebuild needs. */
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

/** First-pass one seat; fix TWO seats (the pivot test needs a next seat in the same round); review one seat. */
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

/** The recorded host of a conducted attempt (KF-10/Q2a-2 invariant). */
const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

/** A collected round-0 attempt whose head is `headCommit`; it is the run's latest attempt. */
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

/** The fix attempt the prepare port returns: a full attempt bound to the fix seat at `seatIndex`. */
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
    // Q2a-1: the fix attempt inherits its prior's host block; the conductor
    // only reads and dispatches through it (Q2a-2).
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

/** A run record via the domain entity, like the K4/K5 fixtures. */
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

function reviewKey(step: 'brief-check' | 'code-review', seatIndex: number, head12: string, retry: number | null = null): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step,
    seatIndex,
    attemptOrdinal: null,
    head12,
    retry,
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

function gateKey(): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'gate',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: HEAD12_A,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a gate key');
  }
  return built.key;
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly reviewRequests: ReviewRequest[];
  readonly fixRequests: PrepareFixAttemptRequest[];
  readonly briefRequests: PrepareBriefPackageUseCaseRequest[];
  readonly dispatchRequests: DispatchAttemptRequest[];
  readonly cancelRequests: CancelPreparedAttemptRequest[];
  readonly gateRequests: readonly EvaluateAttemptGateRequest[];
  readonly reviewOpenRequests: readonly OpenReviewAssessmentRequest[];
  readonly gateReceiptRequests: readonly RecordGateReceiptsRequest[];
  /** Every `readBriefFile` call's arguments, in call order. */
  readonly briefFileReads: readonly { worktreePath: string; relativePath: string; recordedHost: AttemptRunnerRecord | null | undefined }[];
  /** Every `readBriefManifest` call's arguments, in call order. */
  readonly briefManifestReads: readonly { worktreePath: string; manifestPath: string | undefined; recordedHost: AttemptRunnerRecord | null | undefined }[];
  readonly deps: AdvanceLaneRunDependencies;
  /** Journal length when the prepare port was called (order assertion). */
  readonly journalLengthWhenPrepared: number;
  setManifest(json: string | null): void;
  setProse(json: string | null): void;
  setBriefFileError(message: string | null): void;
  setFindReceiptAnswer(answer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult>): void;
  setFixAnswer(answer: (request: PrepareFixAttemptRequest) => Promise<PrepareFixAttemptResult>): void;
  setBriefAnswer(answer: (request: PrepareBriefPackageUseCaseRequest) => Promise<PrepareBriefPackageResult>): void;
  setDispatchAnswer(answer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult>): void;
  setSameFamily(fn: SameModelFamily): void;
  setJournalBaseline(length: number): void;
  setGateAnswer(answer: EvaluateAttemptGateResult): void;
  setReviewAssessmentAnswer(answer: OpenReviewAssessmentResult): void;
  markAttemptCancelled(attemptId: string, stopReason: AttemptRecord['stopReason']): Promise<void>;
}

interface HarnessOptions {
  readonly wireReviewRequest?: boolean;
  readonly wirePrepareFix?: boolean;
  readonly wireDispatch?: boolean;
  readonly wireGate?: boolean;
  readonly wireReviewAssessment?: boolean;
  readonly wireGateReceipts?: boolean;
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
  const reviewRequests: ReviewRequest[] = [];
  const fixRequests: PrepareFixAttemptRequest[] = [];
  const briefRequests: PrepareBriefPackageUseCaseRequest[] = [];
  const dispatchRequests: DispatchAttemptRequest[] = [];
  const cancelRequests: CancelPreparedAttemptRequest[] = [];
  const gateRequests: EvaluateAttemptGateRequest[] = [];
  const reviewOpenRequests: OpenReviewAssessmentRequest[] = [];
  const gateReceiptRequests: RecordGateReceiptsRequest[] = [];
  const briefFileReads: { worktreePath: string; relativePath: string; recordedHost: AttemptRunnerRecord | null | undefined }[] = [];
  const briefManifestReads: { worktreePath: string; manifestPath: string | undefined; recordedHost: AttemptRunnerRecord | null | undefined }[] = [];
  let manifestJson: string | null = FULL_MANIFEST_JSON;
  let prose: string | null = DEFAULT_PROSE;
  let briefFileError: string | null = null;
  let journalLengthWhenPrepared = 0;
  let journalLengthBeforeAdvance = 0;
  let sameFamilyImpl: SameModelFamily = (left, right) => left === right;
  let gateAnswer: EvaluateAttemptGateResult = { verdict: 'passed' };
  let reviewAssessmentAnswer: OpenReviewAssessmentResult = { outcome: 'open' };
  const reviewAnswer: (request: ReviewRequest) => Promise<ReviewRequestResult> = async (request) => ({
    outcome: 'receipt',
    receipt: {
      receiptId: 'rcpt-' + request.requestId,
      requestId: request.requestId,
      kind: request.kind,
      reviewerModel: request.reviewerModel,
      candidateHeadSha: request.candidateHeadSha,
      verdict: 'passed',
      findings: [],
    },
  });
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
      readBriefManifest: async (worktreePath, manifestPath, recordedHost) => {
        briefManifestReads.push({ worktreePath, manifestPath, recordedHost });
        return manifestJson;
      },
      readBriefFile: async (worktreePath, relativePath, recordedHost) => {
        briefFileReads.push({ worktreePath, relativePath, recordedHost });
        if (briefFileError !== null) {
          throw new Error(briefFileError);
        }
        return prose;
      },
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
    // KF-17: the record-only cancel of a never-dispatched attempt, releasing
    // its held reservation, exactly as the real use case does.
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
    // KF-17: the worktree reconcile of a pending dispatch intent reads an
    // idle worktree, so the never-started dispatch closes as not-started.
    runnerForAttempt: {
      runnerForAttempt: () => ({
        ok: true,
        runner: {
          inspectWorktreeRun: async () => ({ state: 'idle' }),
        } as unknown as ExecutionRunnerPort,
      }),
    },
    newUlid: makeUlidMinter(),
    sameModelFamily: (left, right) => sameFamilyImpl(left, right),
    workOrderRepo: {
      findWorkOrderById: async () => WORK_ORDER,
    },
    ...(options.wireReviewRequest === false
      ? {}
      : {
          reviewRequest: {
            requestReview: async (request) => {
              reviewRequests.push(request);
              return reviewAnswer(request);
            },
            findReviewReceipt: async (request) => findReceiptAnswer(request),
            findLatestReceiptOfKind: async () => ({ outcome: 'not-found' }),
          },
        }),
    ...(options.wirePrepareFix === false
      ? {}
      : {
          prepareFixAttempt: {
            prepareFixAttempt: async (request) => {
              // The intent (with the minted fix attempt id) must already be
              // journalled before any port call: the journal held
              // `journalLengthBeforeAdvance` entries and the act appended
              // exactly one (the intent) before reaching this fake.
              fixRequests.push(request);
              journalLengthWhenPrepared = (await runJournal.listForRun(RUN_ID)).length;
              expect(journalLengthWhenPrepared).toBe(journalLengthBeforeAdvance + 1);
              const prepared = await prepareAnswer(request);
              if (prepared.outcome === 'prepared') {
                // The port saves the attempt itself; the conductor appends its id to the run record.
                await attemptRepo.saveAttempt(prepared.attempt);
              }
              return prepared;
            },
          },
        }),
    // KF-6: the recording `prepareBrief` fake; a fix round places its brief
    // package before preparing the fix attempt.
    prepareBrief: {
      prepareBriefPackage: async (request) => {
        briefRequests.push(request);
        return prepareBriefAnswer(request);
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
    ...(options.wireGate === true
      ? {
          evaluateAttemptGate: {
            evaluateAttemptGate: async (request) => {
              gateRequests.push(request);
              return gateAnswer;
            },
          },
        }
      : {}),
    ...(options.wireReviewAssessment === true
      ? {
          reviewAssessment: {
            openReviewAssessment: async (request) => {
              reviewOpenRequests.push(request);
              return reviewAssessmentAnswer;
            },
          },
        }
      : {}),
    ...(options.wireGateReceipts === true
      ? {
          gateReceipts: {
            recordGateReceipts: async (request) => {
              gateReceiptRequests.push(request);
              return { outcome: 'recorded', count: request.receipts.length } as RecordGateReceiptsResult;
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
    reviewRequests,
    fixRequests,
    briefRequests,
    dispatchRequests,
    cancelRequests,
    gateRequests,
    reviewOpenRequests,
    gateReceiptRequests,
    briefFileReads,
    briefManifestReads,
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
    setBriefFileError: (message) => {
      briefFileError = message;
    },
    setFindReceiptAnswer: (answer) => {
      findReceiptAnswer = answer;
    },
    setFixAnswer: (answer) => {
      prepareAnswer = answer;
    },
    setBriefAnswer: (answer) => {
      prepareBriefAnswer = answer;
    },
    setDispatchAnswer: (answer) => {
      dispatchAnswer = answer;
    },
    setSameFamily: (fn) => {
      sameFamilyImpl = fn;
    },
    setJournalBaseline: (length) => {
      journalLengthBeforeAdvance = length;
    },
    setGateAnswer: (answer) => {
      gateAnswer = answer;
    },
    setReviewAssessmentAnswer: (answer) => {
      reviewAssessmentAnswer = answer;
    },
    markAttemptCancelled: async (attemptId, stopReason: AttemptRecord['stopReason']) => {
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
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

/** Admit a prepared attempt so the decider issues its dispatch (K4-5 reservation shape). */
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

/** A `code-review` failure at HEAD12_A with `findings`; the next advance is an `act prepare` for round 1. */
async function seedReviewFailure(
  harness: Harness,
  findings: readonly ReviewRequestFinding[],
  step: 'brief-check' | 'code-review' = 'code-review',
): Promise<void> {
  const key = reviewKey(step, 0, HEAD12_A);
  const requestId = 'review-' + harness.deps.newUlid();
  await appendIntent(harness, key, requestId, NOW);
  await appendResult(harness, key, 'completed', 'review-failed', NOW);
  await conduct(harness, 'fixing', NOW);
  harness.setFindReceiptAnswer(async (request) => ({
    outcome: 'found',
    receipt: {
      receiptId: 'rcpt-' + request.requestId,
      requestId: request.requestId,
      kind: step,
      reviewerModel: 'review-model-1',
      candidateHeadSha: COMMIT_A,
      verdict: 'failed',
      findings,
    },
  }));
}

/** A `gate` failure at HEAD12_A; the next advance is an `act prepare` for round 1. */
async function seedGateFailure(harness: Harness): Promise<void> {
  const key = gateKey();
  await appendIntent(harness, key, null, NOW);
  await appendResult(harness, key, 'completed', 'gate-failed', NOW);
  await conduct(harness, 'fixing', NOW);
}

describe('AdvanceLaneRunUseCase fix-round prepare (K5-5)', () => {
  it('a) prepares a fix round from a review receipt with two findings, names both, and lists the new attempt', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [
      blockerFinding(),
      { findingId: 'finding-2', severity: 'major', summary: 'blocks the acceptance check', filePath: 'src/ex.ts', line: 20 },
    ]);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });

    expect(harness.fixRequests).toHaveLength(1);
    const fixRequest = harness.fixRequests[0]!;
    expect(fixRequest.workOrderId).toBe('wo-example-1');
    expect(fixRequest.priorAttemptId).toBe('attempt-example-1');
    expect(fixRequest.numberedFixes).toEqual([
      '[blocker] src/ex.ts:4 — blocks the acceptance check',
      '[major] src/ex.ts:20 — blocks the acceptance check',
    ]);
    expect(fixRequest.fixAttemptId.startsWith('attempt-')).toBe(true);

    // KF-6: the fix round placed its brief package before preparing the fix
    // attempt — the handover text as the prose, the manifest fields, and the
    // prepared digest and path carried into the fix attempt.
    expect(harness.briefRequests).toHaveLength(1);
    const briefRequest = harness.briefRequests[0]!;
    expect(briefRequest.attemptId).toBe(fixRequest.fixAttemptId);
    expect(briefRequest.worktreePath).toBe(WORKTREE);
    expect(briefRequest.contextDecisions).toEqual([]);
    expect(briefRequest.prNotes).toEqual({ hardToUndo: 'undo', assumptions: 'assume', challengeThis: 'challenge' });
    const rendered = renderHandoverBrief({
      runId: RUN_ID,
      round: 1,
      branchName: WORKTREE.split('/').pop() ?? '',
      head12: HEAD12_A,
      source: 'review',
      findings: [
        blockerFinding(),
        { findingId: 'finding-2', severity: 'major', summary: 'blocks the acceptance check', filePath: 'src/ex.ts', line: 20 },
      ],
      gateReasonCodes: [],
      gatePredicates: [],
      proofCommands: [['corepack', 'yarn', 'build']],
      originalBrief: DEFAULT_PROSE,
    });
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(briefRequest.proseMarkdown).toBe(rendered.text);
      expect(fixRequest.briefDigest).toBe(simpleDeterministicHexDigest(rendered.text + '\n' + FULL_MANIFEST_JSON));
    }
    expect(fixRequest.briefPackagePath).toBe('.lane/brief.md');

    // The prior's frozen prose and manifest are read through the prior's
    // recorded host, at the prior's worktree and the frozen brief path.
    expect(harness.briefFileReads).toEqual([
      { worktreePath: WORKTREE, relativePath: '.lane/brief.md', recordedHost: CONDUCTED_RUNNER },
    ]);
    expect(harness.briefManifestReads.length).toBeGreaterThan(0);
    expect(
      harness.briefManifestReads.every(
        (read) => read.worktreePath === WORKTREE && read.recordedHost === CONDUCTED_RUNNER,
      ),
    ).toBe(true);

    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1', fixRequest.fixAttemptId]);

    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === prepareKey(1, 0, 2));
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === prepareKey(1, 0, 2));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.mintedId).toBe(fixRequest.fixAttemptId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'prepared' });
  });

  it('b) a gate-failed with no recorded failed check refuses prepare-refused rather than a bare reason code (KF-21b)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedGateFailure(harness);

    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'refused', reasonCode: 'prepare-refused' });
    expect(harness.fixRequests).toHaveLength(0);
  });

  it('b1) a journal row with the gate id prefix but another attempt or action is never a gate check (KF-21b)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedGateFailure(harness);
    const forged = (attemptId: string, action: 'accept' | 'dispatch', n: number) => ({
      id: 'attempt-example-1:accept:' + COMMIT_A + ':' + n,
      attemptId,
      workOrderId: 'wo-example-1',
      action,
      baseCommit: COMMIT_A,
      recordedAtIso: NOW,
      status: 'completed' as const,
      sessionId: null,
      detail: JSON.stringify({ predicate: 'command 1', kind: 'command', verdict: 'fail', exitCode: 1, durationMs: 1, detail: 'x' }),
    });
    await harness.executionJournal.appendJournalEntry(forged('attempt-example-other', 'accept', 0));
    await harness.executionJournal.appendJournalEntry(forged('attempt-example-1', 'dispatch', 1));

    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'refused', reasonCode: 'prepare-refused' });
    expect(harness.fixRequests).toHaveLength(0);
  });

  it('b2) uses the recorded branch for the handover header; old records fall back (KF-5b)', async () => {
    // The prior worktree path's last segment would be an invalid header value
    // (a backtick), so the prepare can only succeed when the run's recorded
    // branch is used for the handover header.
    const harness = await makeHarness(
      runRecord({ branchName: 'fleet/' + RUN_ID }),
      [{ ...collectedAttempt(), worktreePath: '/tmp/opencode/wo-example-1/wt-`inject' }],
    );
    await seedReviewFailure(harness, [blockerFinding()]);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    expect(harness.fixRequests).toHaveLength(1);
  });

  it('c) refuses prepare-refused when the receipt has only nit findings, saving no fix attempt', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [
      { findingId: 'finding-1', severity: 'nit', summary: 'nit only', filePath: 'src/ex.ts', line: 4 },
    ]);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'prepare-refused')).toBe(true);
  });

  it('d) journals refused/prepare-refused and never lists the minted id when the port refuses', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    harness.setFixAnswer(async () => ({ outcome: 'refused', reason: 'example' }));

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });

    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intent = entries.find((entry) => entry.kind === 'intent' && entry.key === prepareKey(1, 0, 2));
    expect(typeof intent?.mintedId).toBe('string');
    expect(record?.attemptIds).not.toContain(intent?.mintedId);
    expect(entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'prepare-refused')).toBe(true);
  });

  it('e) a fix dispatch that never starts pivots to the next fix seat in the same round', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);

    const first = await advance(harness);
    expect(first).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared' });

    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);

    // The runner refuses and cancels the attempt, so the dispatch reads not-started
    // and the decider pivots within the same round (K4-5 test 2 shape).
    harness.setDispatchAnswer(async (request) => {
      await harness.markAttemptCancelled(request.attemptId, 'rate-limited');
      return { outcome: 'refused', reason: '429 rate limited' };
    });

    const dispatched = await advance(harness);
    expect(dispatched).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'runner-refused',
    });
    const seatFailed = await advance(harness);
    expect(seatFailed).toEqual({ outcome: 'entered', state: 'seat-failed' });

    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 1, 3),
      result: 'completed',
      reasonCode: 'prepared',
    });

    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.round).toBe(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'intent' && entry.key === prepareKey(1, 1, 3))).toBe(true);
    expect(harness.dispatchRequests).toHaveLength(1);
  });

  it('f) a failure in round 2 parks blocker-after-round-2', async () => {
    const harness = await makeHarness(
      runRecord({ round: 2, attemptIds: ['attempt-example-1', 'attempt-example-2', 'attempt-example-3'] }),
      [collectedAttempt()],
    );
    await seedReviewFailure(harness, [blockerFinding()]);

    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'blocker-after-round-2', qualifier: null });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked?.reason).toBe('blocker-after-round-2');
    expect(record?.round).toBe(2);
    expect(harness.fixRequests).toHaveLength(0);
  });

  it('g) journals the prepare intent before the port call', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);

    const baseline = (await harness.runJournal.listForRun(RUN_ID)).length;
    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared' });
    expect(harness.journalLengthWhenPrepared).toBe(baseline + 1);
  });

  it('h) still journals prepared when the port selects a different fix seat', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    harness.setFixAnswer(async (request) => ({
      outcome: 'prepared',
      attempt: buildFixAttempt(request, 1),
    }));

    const result = await advance(harness);
    // PrepareFixAttempt selects the fix seat itself; the decider's seat index is advisory until the port takes one (follow-up).
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toHaveLength(2);
    expect(harness.fixRequests).toHaveLength(1);
    const savedAttempt = await harness.attemptRepo.findAttemptById(harness.fixRequests[0]!.fixAttemptId);
    expect(savedAttempt?.seatSelection?.seatIndex).toBe(1);
    expect(savedAttempt?.seatSelection?.seatId).toBe('fx-2');
  });

  it('i) dispatches the prepared fix attempt: the brief digest and path flow from prepareBrief into the fix attempt', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);

    const first = await advance(harness);
    expect(first).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared' });

    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    const saved = await harness.attemptRepo.findAttemptById(fixAttemptId as string);
    const handoverProse = harness.briefRequests[0]!.proseMarkdown;
    expect(saved?.briefDigest).toBe(simpleDeterministicHexDigest(handoverProse + '\n' + FULL_MANIFEST_JSON));
    expect(saved?.briefPackagePath).toBe('.lane/brief.md');

    await admit(harness, fixAttemptId as string);
    const dispatched = await advance(harness);
    expect(dispatched).toMatchObject({
      outcome: 'acted',
      step: 'dispatch',
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
  });

  it('j) refuses prepare-refused when the brief placement is rejected, saving no fix attempt', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    harness.setBriefAnswer(async () => ({ outcome: 'rejected', reason: 'example' }));

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'prepare-refused')).toBe(true);
  });

  it('k) refuses prepare-refused when the prior manifest is unusable or incomplete', async () => {
    for (const manifest of [null, JSON.stringify({ stepLimit: 100 })]) {
      const harness = await makeHarness(runRecord(), [collectedAttempt()]);
      await seedReviewFailure(harness, [blockerFinding()]);
      harness.setManifest(manifest);

      const result = await advance(harness);
      expect(result).toEqual({
        outcome: 'acted',
        step: 'prepare',
        key: prepareKey(1, 0, 2),
        result: 'refused',
        reasonCode: 'prepare-refused',
      });
      expect(harness.fixRequests).toHaveLength(0);
      expect(harness.briefRequests).toHaveLength(0);
      const record = await harness.runRepo.get(RUN_ID);
      expect(record?.attemptIds).toEqual(['attempt-example-1']);
    }
  });

  it('l) parks step-refused when a refused fix prepare would re-run under the same key (KF-9)', async () => {
    // A prepare whose brief rebuild refuses (the prior manifest is
    // incomplete) journals its intent and its refused result; the next
    // advance re-issues the SAME key (the run's round is still the prior
    // round) and must park instead of looping on `duplicate-key`.
    const refused = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(refused, [blockerFinding()]);
    refused.setManifest(JSON.stringify({ stepLimit: 100 }));
    expect(await advance(refused)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });

    expect(await advance(refused)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'prepare' });
    const entries = await refused.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === prepareKey(1, 0, 2))).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'result' && entry.key === prepareKey(1, 0, 2))).toHaveLength(1);
    expect(refused.fixRequests).toHaveLength(0);
    expect(refused.briefRequests).toHaveLength(0);
    const refusedRecord = await refused.runRepo.get(RUN_ID);
    expect(refusedRecord?.parked).toMatchObject({ reason: 'step-refused', qualifier: 'prepare' });

    // A refusal that ran both ports (the fix port refuses) parks the same way
    // with each port called exactly once in total.
    const spent = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(spent, [blockerFinding()]);
    spent.setFixAnswer(async () => ({ outcome: 'refused', reason: 'example' }));
    expect(await advance(spent)).toMatchObject({ result: 'refused', reasonCode: 'prepare-refused' });
    expect(await advance(spent)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'prepare' });
    expect(spent.briefRequests).toHaveLength(1);
    expect(spent.fixRequests).toHaveLength(1);
  });

  it('m) addresses the fix brief to the reserved host of the prior attempt (KF-9)', async () => {
    const runner = {
      kind: 'opencode' as const,
      remotePort: 4321,
      host: 'lane-example',
      hostName: 'lane-example',
      agent: 'agent-example',
      model: 'model-example-1',
      variant: null,
    };
    const withHost = await makeHarness(runRecord(), [{ ...collectedAttempt(), runner }]);
    await seedReviewFailure(withHost, [blockerFinding()]);
    expect(await advance(withHost)).toMatchObject({ result: 'completed', reasonCode: 'prepared' });
    expect(withHost.briefRequests[0]?.recordedHost).toEqual(runner);

    // A prior attempt without a recorded host is never read through the local
    // executor: the frozen-manifest read is not made and the prepare refuses.
    const withoutHost = await makeHarness(runRecord(), [{ ...collectedAttempt(), runner: null }]);
    await seedReviewFailure(withoutHost, [blockerFinding()]);
    expect(await advance(withoutHost)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(withoutHost.briefRequests).toHaveLength(0);
    expect(withoutHost.fixRequests).toHaveLength(0);
  });

  it('n) journals a fixed detail when the dispatch refuses on the worktree head (KF-16)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed' });

    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);

    harness.setDispatchAnswer(async () => ({
      outcome: 'refused' as const,
      reason: 'Worktree /example/wt does not match the base commit (checked out abc)',
    }));
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });

    const entries = await harness.runJournal.listForRun(RUN_ID);
    const refusedResult = entries.find((entry) => entry.kind === 'result' && entry.key === dispatchKey(1, 0, 2));
    expect(refusedResult).toMatchObject({
      outcome: 'refused',
      reasonCode: 'dispatch-refused',
      detail: 'worktree-head-mismatch',
    });
  });

  it('o) a refused fix dispatch recovers in the same round after resume (KF-17)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);

    // Fixing prepares a2 under the round-1 key; the run's round is still 0
    // until dispatch.
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared',
    });
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);

    // The dispatch refuses with the attempt untouched: the round is raised to
    // 1 BEFORE the call, the key is spent, and the run parks step-refused
    // dispatch with round 1.
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: 'refused by the example runner' }));
    const key = dispatchKey(1, 0, 2);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    const parked = await harness.runRepo.get(RUN_ID);
    expect(parked?.parked).toMatchObject({ reason: 'step-refused', qualifier: 'dispatch' });
    expect(parked?.round).toBe(1);

    // Resume: clear the park and re-conduct `fixing` (the park's parkedFrom).
    const saved = await harness.deps.runRepo.save(
      { ...parked!, parked: null, revision: parked!.revision + 1 },
      { holderId: HOLDER, fence: 1, nowIso: LATER },
    );
    expect(saved.outcome).toBe('saved');
    await conduct(harness, 'fixing', LATER);

    // The next advance cancels a2, releases its reservation and never re-sends
    // the spent dispatch key.
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'dispatch-pending' });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.cancelRequests).toEqual([{ attemptId: fixAttemptId, nowIso: LATER }]);
    expect((await harness.attemptRepo.findAttemptById(fixAttemptId as string))?.state).toBe('cancelled');
    expect(
      (await harness.executionJournal.listActiveReservations()).some(
        (reservation) => reservation.attemptId === fixAttemptId && reservation.held,
      ),
    ).toBe(false);
    expect((await harness.runJournal.listForKey(key)).filter((entry) => entry.kind === 'intent')).toHaveLength(1);

    // The next advance prepares a3 at round 1 with the collected a1 as prior
    // (the next fix seat, after seat 0's spent dispatch).
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'prepare', key: prepareKey(1, 1, 3), result: 'completed', reasonCode: 'prepared',
    });
    expect(harness.fixRequests[1]?.priorAttemptId).toBe('attempt-example-1');
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.round).toBe(1);

    // The next advance dispatches a3.
    const a3 = record?.attemptIds[2];
    expect(typeof a3).toBe('string');
    await admit(harness, a3 as string);
    harness.setDispatchAnswer(async (request) => ({
      outcome: 'started',
      attempt: buildFixAttempt({ fixAttemptId: request.attemptId, workOrderId: record!.workOrderId, priorAttemptId: 'attempt-example-1', numberedFixes: [] }, 0),
      sessionId: 'session-example-2',
    }));
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'dispatch', key: dispatchKey(1, 1, 3), result: 'completed', reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(2);
  });

  it('p) a crash between the round raise and the dispatch reconciles not-started and prepares again at round 1 (KF-17)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed' });
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);

    // Crash between the raise save and the dispatch: the dispatch intent is
    // pending, the run's round is already 1, and the runner was never called.
    const key = dispatchKey(1, 0, 2);
    await appendIntent(harness, key, fixAttemptId as string, NOW);
    const raised = await harness.runRepo.get(RUN_ID);
    const saved = await harness.deps.runRepo.save(
      { ...raised!, round: 1, cursors: { ...raised!.cursors, fix: 0 }, revision: raised!.revision + 1 },
      { holderId: HOLDER, fence: 1, nowIso: LATER },
    );
    expect(saved.outcome).toBe('saved');

    // The reconcile reads the idle worktree, cancels a2 and closes the key
    // not-started; the dispatch is never sent.
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'dispatch', key, result: 'not-started', reasonCode: 'worktree-idle',
    });
    expect(harness.dispatchRequests).toHaveLength(0);
    expect((await harness.attemptRepo.findAttemptById(fixAttemptId as string))?.state).toBe('cancelled');

    // The next prepare is at round 1, from the collected a1 (the next fix seat).
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'prepare', key: prepareKey(1, 1, 3), result: 'completed', reasonCode: 'prepared',
    });
    expect(harness.fixRequests[1]?.priorAttemptId).toBe('attempt-example-1');
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.round).toBe(1);
  });

  it('s) a gate failure fills the handover with failed gate checks, proof commands and the original brief', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedGateFailure(harness);
    // Seed the stored predicate results of the prior's gate: one failed
    // command (exit 1) and one skipped command. Only fail/unknown pass the
    // projection; detail text never reaches the handover.
    await harness.executionJournal.appendJournalEntry({
      id: 'attempt-example-1:accept:' + COMMIT_A + ':0',
      attemptId: 'attempt-example-1',
      workOrderId: 'wo-example-1',
      action: 'accept',
      baseCommit: COMMIT_A,
      recordedAtIso: NOW,
      status: 'completed',
      sessionId: null,
      detail: JSON.stringify({
        predicate: 'command 1',
        kind: 'command',
        verdict: 'fail',
        exitCode: 1,
        durationMs: 10,
        detail: 'gate detail text that must never appear',
      }),
    });
    await harness.executionJournal.appendJournalEntry({
      id: 'attempt-example-1:accept:' + COMMIT_A + ':1',
      attemptId: 'attempt-example-1',
      workOrderId: 'wo-example-1',
      action: 'accept',
      baseCommit: COMMIT_A,
      recordedAtIso: NOW,
      status: 'completed',
      sessionId: null,
      detail: JSON.stringify({
        predicate: 'command 2',
        kind: 'command',
        verdict: 'skipped',
        exitCode: null,
        durationMs: 10,
        detail: 'skip detail',
      }),
    });

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });

    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(prose).toContain('[gate] command 1 — fail, exit 1');
    expect(prose).not.toContain('command 2');
    expect(prose).not.toContain('gate detail text that must never appear');
    expect(prose).not.toContain('skip detail');
    // Every proof-command argv from the frozen acceptance spec is present.
    expect(prose).toContain('corepack yarn build');
    // Round 1 carries the original prose after the marker.
    expect(prose.indexOf(ORIGINAL_BRIEF_MARKER)).toBeGreaterThan(-1);
    expect(originalBriefOf(prose)).toBe(DEFAULT_PROSE);
  });

  it('t) a review failure also carries the proof commands and the original brief', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });

    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(prose).toContain('[blocker] src/ex.ts:4 — blocks the acceptance check');
    expect(prose).toContain('corepack yarn build');
    expect(prose).toContain(DEFAULT_PROSE);
    expect(originalBriefOf(prose)).toBe(DEFAULT_PROSE);
  });

  it('u) round 2 carries the same original brief when the prior is a fix attempt', async () => {
    const harness = await makeHarness(
      runRecord({ round: 1, attemptIds: ['attempt-example-1', 'attempt-fix-prior'] }),
      [collectedAttempt()],
    );
    // The prior is a collected fix attempt whose prose is a round-1 handover.
    const roundOne = renderHandoverBrief({
      runId: RUN_ID,
      round: 1,
      branchName: WORKTREE.split('/').pop() ?? '',
      head12: HEAD12_A,
      source: 'review',
      findings: [blockerFinding()],
      gateReasonCodes: [],
      gatePredicates: [],
      proofCommands: [['corepack', 'yarn', 'build']],
      originalBrief: DEFAULT_PROSE,
    });
    expect(roundOne.ok).toBe(true);
    if (!roundOne.ok) {
      throw new Error('fixture must render a round-1 handover');
    }
    const fixPrior: AttemptRecord = {
      ...buildFixAttempt(
        { fixAttemptId: 'attempt-fix-prior', workOrderId: 'wo-example-1', priorAttemptId: 'attempt-example-1', numberedFixes: [] },
        0,
      ),
      state: 'collected',
      briefDigest: simpleDeterministicHexDigest(roundOne.text + '\n' + FULL_MANIFEST_JSON),
      artifacts: { headCommit: COMMIT_A, commitsSinceBase: [COMMIT_A], collectedArtifactPaths: [], notes: 'present' },
    };
    await harness.attemptRepo.saveAttempt(fixPrior);
    harness.setProse(roundOne.text);
    await seedReviewFailure(harness, [blockerFinding()]);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(2, 1, 3),
      result: 'completed',
      reasonCode: 'prepared',
    });

    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(originalBriefOf(prose)).toBe(DEFAULT_PROSE);
    expect(prose).toContain('corepack yarn build');
  });

  it('v) refuses prepare-refused when the prior prose does not match its digest, placing nothing', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    // The lane edited .lane/brief.md: the prose no longer matches the prior's
    // recorded digest, so the handover refuses and nothing is placed.
    harness.setProse('# tampered prose\n');

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    expect(harness.briefRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
  });

  it('w) refuses prepare-refused when the prior prose read is null, placing nothing', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    // The prior's `.lane/brief.md` is missing: the fix prepare refuses instead
    // of preparing with `originalBrief: null`.
    harness.setProse(null);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    expect(harness.briefRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'prepare-refused')).toBe(true);
  });

  it('x) refuses prepare-refused when the prior manifest read is null, placing nothing', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    // The prior's frozen manifest is missing: the fix prepare refuses.
    harness.setManifest(null);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    expect(harness.briefRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
  });

  it('y) a throwing readBriefFile refuses the prepare and no exception escapes', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    harness.setBriefFileError('boom');

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    expect(harness.briefRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1']);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'prepare-refused')).toBe(true);
  });

  it('z) round 2 whose prior prose has no original-brief marker refuses prepare-refused', async () => {
    const harness = await makeHarness(
      runRecord({ round: 1, attemptIds: ['attempt-example-1', 'attempt-fix-prior'] }),
      [collectedAttempt()],
    );
    // The prior is a collected fix attempt whose prose has NO original-brief
    // marker; its digest still matches, so only the marker extraction refuses.
    const fixPrior: AttemptRecord = {
      ...buildFixAttempt(
        { fixAttemptId: 'attempt-fix-prior', workOrderId: 'wo-example-1', priorAttemptId: 'attempt-example-1', numberedFixes: [] },
        0,
      ),
      state: 'collected',
      briefDigest: simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON),
      artifacts: { headCommit: COMMIT_A, commitsSinceBase: [COMMIT_A], collectedArtifactPaths: [], notes: 'present' },
    };
    await harness.attemptRepo.saveAttempt(fixPrior);
    harness.setProse(DEFAULT_PROSE);
    await seedReviewFailure(harness, [blockerFinding()]);

    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(2, 1, 3),
      result: 'refused',
      reasonCode: 'prepare-refused',
    });
    expect(harness.fixRequests).toHaveLength(0);
    expect(harness.briefRequests).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toEqual(['attempt-example-1', 'attempt-fix-prior']);
  });
});

describe('AdvanceLaneRunUseCase dispatch seat override (KF-18)', () => {
  it('q) a fix attempt dispatches on its own fix seat through a seat override (KF-18)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailure(harness, [blockerFinding()]);
    // The fix port selects the plan's fix seat (`fx-1` / `fix-model-1` at
    // index 0, per the fixture plan): the override names that seat and the
    // dispatch would be refused on the seat binding without it.
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared',
    });
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'dispatch', result: 'completed', reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.dispatchRequests[0]?.seatOverride).toEqual({
      model: 'fix-model-1',
      reason: 'fix seat fx-1',
      setBy: 'conductor',
      expiresAtIso: new Date(Date.parse(LATER) + 2700 * 1000).toISOString(),
    });
  });

  it('r) an initial pivot attempt still dispatches with the seat-plan pivot override (KF-18)', async () => {
    const pivotAttempt: AttemptRecord = {
      ...collectedAttempt(),
      id: 'attempt-example-2',
      priorAttemptId: 'attempt-example-1',
      state: 'intent-recorded',
      completionReceipt: null,
      artifacts: null,
    };
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [collectedAttempt(), pivotAttempt],
    );
    await admit(harness, 'attempt-example-2');
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'dispatch', result: 'completed', reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.dispatchRequests[0]?.seatOverride).toMatchObject({
      model: 'model-example-1',
      reason: 'seat-plan pivot to fp-1',
      setBy: 'conductor',
    });
  });

  it('s) a first attempt dispatches without a seat override (KF-18)', async () => {
    const firstAttempt: AttemptRecord = {
      ...collectedAttempt(),
      state: 'intent-recorded',
      completionReceipt: null,
      artifacts: null,
    };
    const harness = await makeHarness(runRecord(), [firstAttempt]);
    await admit(harness, 'attempt-example-1');
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'dispatch', result: 'completed', reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.dispatchRequests[0]?.seatOverride).toBeUndefined();
  });

  /** Seed a review failure, prepare a fix attempt carrying `overrides` on its record, and dispatch it. */
  async function prepareAndDispatchFixWith(harness: Harness, overrides: Partial<AttemptRecord>): Promise<void> {
    await seedReviewFailure(harness, [blockerFinding()]);
    harness.setFixAnswer(async (request) => ({
      outcome: 'prepared',
      attempt: { ...buildFixAttempt(request, 0), ...overrides },
    }));
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared',
    });
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'dispatch', result: 'completed', reasonCode: 'dispatch-started',
    });
  }

  /** Seed a review failure, prepare a fix attempt carrying `overrides`, and expect its dispatch to park unsent. */
  async function prepareAndRefuseFixWith(harness: Harness, overrides: Partial<AttemptRecord>, detail: string): Promise<void> {
    await seedReviewFailure(harness, [blockerFinding()]);
    harness.setFixAnswer(async (request) => ({
      outcome: 'prepared',
      attempt: { ...buildFixAttempt(request, 0), ...overrides },
    }));
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared',
    });
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);
    await advance(harness);
    expect(harness.dispatchRequests).toHaveLength(0);
    const parked = await harness.runRepo.get(RUN_ID);
    expect(parked?.parked).toMatchObject({ reason: 'step-refused', qualifier: 'dispatch' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const refused = entries.find((entry) => entry.kind === 'result' && entry.outcome === 'refused');
    expect(refused).toMatchObject({ reasonCode: 'dispatch-refused', detail });
  }

  it('t) a fix selection naming a seat id outside the frozen plan parks unsent (KF-18)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await prepareAndRefuseFixWith(harness, {
      seatSelection: {
        role: 'fix',
        seatIndex: 0,
        seatId: 'fx-example',
        model: 'example-provider/fix-model',
        tool: 'opencode',
        variant: 'low',
        agent: 'lane-fix',
      },
    }, 'seat-not-in-plan');
  });

  it('u) a fix selection whose model differs from its frozen-plan seat parks unsent (KF-18)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await prepareAndRefuseFixWith(harness, {
      seatSelection: {
        role: 'fix',
        seatIndex: 0,
        seatId: 'fx-1',
        model: 'different-model',
        tool: 'opencode',
        variant: null,
        agent: null,
      },
    }, 'seat-not-in-plan');
  });

  it('v) a fix selection with no frozen plan to check it against parks unsent (KF-18)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await prepareAndRefuseFixWith(harness, { seatPlan: null }, 'seat-not-in-plan');
  });

  it('w) a fix attempt without a seat selection keeps no override (KF-18)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await prepareAndDispatchFixWith(harness, { seatSelection: null });
    expect(harness.dispatchRequests[0]?.seatOverride).toBeUndefined();
  });
});

describe('fixSeatForDispatch names a fix seat only when an override can express it (KF-18)', () => {
  const FIX_PLAN = {
    version: 1 as const,
    'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode', agent: 'lane' }],
    fix: [
      { id: 'fx-a', model: 'fix-model-a', tool: 'opencode', agent: 'lane-fix', variant: 'low' },
      { id: 'fx-b', model: 'fix-model-b', tool: 'agy' },
      { id: 'fx-c', model: 'fix-model-c', tool: 'opencode' },
    ],
    review: [{ id: 'rev-1', model: 'review-model-1', tool: 'opencode' }],
  };
  function fixAttempt(seatIndex: number): AttemptRecord {
    const seat = FIX_PLAN.fix[seatIndex]!;
    return {
      ...collectedAttempt(),
      kind: 'fix',
      seatPlan: FIX_PLAN,
      seatSelection: {
        role: 'fix',
        seatIndex,
        seatId: seat.id,
        model: seat.model,
        tool: seat.tool,
        variant: 'variant' in seat ? (seat.variant as string) : null,
        agent: 'agent' in seat ? (seat.agent as string) : null,
      },
    } as AttemptRecord;
  }
  const manifest = (assignment: Record<string, unknown>) => ({ modelAssignment: assignment });

  it('names a plan seat whose tool, agent and variant the override can carry', () => {
    expect(fixSeatForDispatch(fixAttempt(0), manifest({ model: 'model-example-1', agent: 'lane' }))).toMatchObject({
      kind: 'seat',
    });
  });
  it('refuses a fix seat on another tool than the frozen assignment (the override cannot change the tool)', () => {
    expect(fixSeatForDispatch(fixAttempt(1), manifest({ model: 'model-example-1' }))).toEqual({
      kind: 'refused', detail: 'seat-not-expressible',
    });
  });
  it('refuses a fix seat with no agent when the assignment sets one (it would inherit the first-pass agent)', () => {
    expect(fixSeatForDispatch(fixAttempt(2), manifest({ model: 'model-example-1', agent: 'lane' }))).toEqual({
      kind: 'refused', detail: 'seat-not-expressible',
    });
  });
  it('refuses a fix seat with no variant when the assignment sets one', () => {
    expect(fixSeatForDispatch(fixAttempt(2), manifest({ model: 'model-example-1', variant: 'high' }))).toEqual({
      kind: 'refused', detail: 'seat-not-expressible',
    });
  });
  it('refuses a fix attempt whose selection is not a fix seat (no first-pass fallback)', () => {
    const attempt = fixAttempt(0);
    const firstPass = { ...attempt, seatSelection: { ...attempt.seatSelection!, role: 'first-pass' as const, seatIndex: 0, seatId: 'fp-1', model: 'model-example-1', tool: 'opencode', agent: 'lane', variant: null } } as AttemptRecord;
    expect(fixSeatForDispatch(firstPass, manifest({ model: 'model-example-1', agent: 'lane' }))).toEqual({
      kind: 'refused', detail: 'seat-not-in-plan',
    });
  });
  it('is none for a first attempt or a fix attempt with no selection', () => {
    expect(fixSeatForDispatch({ ...fixAttempt(0), kind: 'initial' } as AttemptRecord, null)).toEqual({ kind: 'none' });
    expect(fixSeatForDispatch({ ...fixAttempt(0), seatSelection: null } as AttemptRecord, null)).toEqual({ kind: 'none' });
  });
});

describe('dispatchRefusalDetail maps every dispatch refusal to a fixed code (KF-16)', () => {
  it.each([
    ['Worktree /example/wt does not match the base commit (checked out abc)', 'worktree-head-mismatch'],
    [`Worktree /example/wt does not match the prior attempt's head (checked out def)`, 'worktree-head-mismatch'],
    ['Worktree /example/wt has uncommitted changes: src/ex.ts', 'worktree-uncommitted'],
    ['Worktree /example/wt has untracked files: src/new.ts', 'worktree-untracked'],
    ['Worktree /example/wt contains residue from earlier attempts: old.txt', 'worktree-residue'],
    ['No active capacity reservation for attempt', 'no-reservation'],
    [
      'Reservation host host-a is not the configured runner host host-b; several lane-runner hosts need H9b/H10',
      'reservation-host-mismatch',
    ],
    ['Worktree path does not match the path allocated by the capacity reservation', 'reservation-worktree-mismatch'],
    ['Runner capabilities do not satisfy required isolation', 'capabilities-missing'],
    [
      'Prior attempt attempt-1 is ended; a fix attempt starts only after it is collected or cancelled',
      'prior-not-settled',
    ],
    ['Prior attempt not found for work order', 'prior-not-found'],
    ['Prior attempt attempt-1 is collected but has no sealed head commit', 'prior-head-missing'],
    ['Work order not found: wo-1', 'work-order-missing'],
    ['runner-not-available', 'runner-unavailable'],
    ['No runner port can be described for dispatch', 'runner-unavailable'],
    [
      'Frozen brief model assignment example-model does not match seat fx-example (example-provider/fix-model) selected for attempt attempt-1',
      'seat-mismatch',
    ],
    ['Seat override example-provider/fix-model shares underlying model family with recorded reviewer seat rev-1', 'seat-family-conflict'],
    ['something new', 'other'],
    // A path with spaces still maps by its phrase.
    ['Worktree /example/work tree does not match the base commit (checked out abc)', 'worktree-head-mismatch'],
    ['Worktree /example/work tree has untracked files: a.ts', 'worktree-untracked'],
    // A listed file name never changes the code: the phrase after the path decides.
    ['Worktree /example/wt has untracked files: does not match the base commit.txt', 'worktree-untracked'],
    ['Worktree /example/wt has uncommitted changes: No active capacity reservation.md', 'worktree-uncommitted'],
  ])('maps %s to %s', (reason, expected) => {
    expect(dispatchRefusalDetail(reason)).toBe(expected);
    expect(expected).toMatch(LANE_RUN_JOURNAL_REASON_CODE_PATTERN);
    expect(dispatchRefusalDetail(reason)).not.toBe(reason);
  });
});

describe('KF-20: the gate and the review open the evidence assessment with the model that ran the attempt', () => {
  const FIX_GATE_RESULT: GatePredicateResult = {
    name: 'command 1: check-1',
    kind: 'command',
    verdict: 'pass',
    exitCode: 0,
    durationMs: 1,
    detail: 'exit 0',
  };

  it('a fix attempt the fix seat ran passes the gate and the brief-check opens the same assessment, so the review is requested', async () => {
    const fixAttempt: AttemptRecord = {
      ...collectedAttempt(),
      id: 'attempt-fix-1',
      kind: 'fix',
      fixNumber: 1,
      priorAttemptId: 'attempt-example-1',
      // The fix seat ran the attempt: the runner model is the fix seat's model.
      runner: { ...CONDUCTED_RUNNER, model: 'fix-model-1' },
      seatSelection: {
        role: 'fix',
        seatIndex: 0,
        seatId: 'fx-1',
        model: 'fix-model-1',
        tool: 'opencode',
        variant: null,
        agent: null,
      },
    };
    const harness = await makeHarness(
      runRecord({ round: 1, attemptIds: ['attempt-example-1', 'attempt-fix-1'] }),
      [collectedAttempt(), fixAttempt],
      { wireGate: true, wireReviewAssessment: true, wireGateReceipts: true },
    );
    harness.setGateAnswer({ verdict: 'passed', results: [FIX_GATE_RESULT] });
    await conduct(harness, 'gating', NOW);

    // The gate opens the evidence assessment with the model that ran the
    // attempt — the fix seat's model, not the manifest's first-pass model.
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'gate', result: 'completed', reasonCode: 'gate-passed',
    });
    expect(harness.reviewOpenRequests).toHaveLength(1);
    expect(harness.reviewOpenRequests[0]).toMatchObject({
      attemptId: 'attempt-fix-1',
      candidateHeadSha: COMMIT_A,
      policyRevision: 'policy-example-1',
      implementerModel: 'fix-model-1',
      requiredChecks: ['check-1'],
    });
    expect(harness.gateReceiptRequests).toHaveLength(1);

    // The brief-check opens the SAME assessment: the same implementerModel,
    // head and policy — never a `head-mismatch` refusal.
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'brief-check' });
    const reviewAct = await advance(harness);
    expect(reviewAct).toMatchObject({
      outcome: 'acted', step: 'brief-check', result: 'completed', reasonCode: 'review-passed',
    });
    expect(harness.reviewOpenRequests).toHaveLength(2);
    const [gateOpen, reviewOpen] = harness.reviewOpenRequests;
    expect(reviewOpen!.implementerModel).toBe(gateOpen!.implementerModel);
    expect(reviewOpen).toMatchObject({
      attemptId: 'attempt-fix-1',
      candidateHeadSha: COMMIT_A,
      policyRevision: 'policy-example-1',
      implementerModel: 'fix-model-1',
      requiredChecks: ['check-1'],
    });
    // The review is requested, not refused `assessment-unavailable`.
    expect(harness.reviewRequests).toHaveLength(1);
    expect(harness.reviewRequests[0]).toMatchObject({ kind: 'brief-check', implementerModel: 'fix-model-1' });
  });
});
