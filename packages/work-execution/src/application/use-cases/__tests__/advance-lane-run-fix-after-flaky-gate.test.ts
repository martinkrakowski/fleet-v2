/**
 * CB9: a fix round triggered by a review failure (`brief-check`/`code-review`
 * `review-failed`) after a gate whose first run failed and whose retry on the
 * same head passed must not be refused with `prepare-no-gate-checks`. A
 * `gate-passed` recorded later than a `gate-failed`, on the same
 * `(round, head12)`, supersedes that failure: the fix source is the review
 * failure, and no gate predicate is demanded. The harness follows the
 * in-memory adapter pattern of `advance-lane-run-fix-round.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { performFixPrepare } from '../advance-lane-run/review-fix.js';
import { appendRunIntent, appendRunResult } from '../advance-lane-run/step-context.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../advance-lane-run/step-context.js';
import type { AdvanceLaneRunRequest } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
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
import type { HeadCiStateRead, ReadHeadCiStateRequest } from '../../ports/out/CiStatePort.out-port.js';
import type {
  PrepareFixAttemptRequest,
  PrepareFixAttemptResult,
} from '../../ports/in/PrepareFixAttemptPort.in-port.js';
import type {
  PrepareBriefPackageResult,
} from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  DispatchAttemptRequest,
  DispatchAttemptResult,
} from '../../ports/in/DispatchAttemptPort.in-port.js';
import type {
  CancelPreparedAttemptRequest,
} from '../../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);

const HEAD12_A = 'a'.repeat(12);
const HEAD12_B = 'b'.repeat(12);
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

/** First-pass one seat; fix one seat; review one seat. */
const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
  ],
  fix: [
    { id: 'fx-1', model: 'fix-model-1', tool: 'opencode' },
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

/** The fix attempt the prepare port returns: a full attempt bound to the fix seat. */
function buildFixAttempt(request: PrepareFixAttemptRequest): AttemptRecord {
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
      seatIndex: 0,
      seatId: 'fx-1',
      model: 'fix-model-1',
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

function buildKey(
  step: 'collect' | 'gate' | 'brief-check',
  round: number,
  head12: string | null,
  retry: number | null,
): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round,
    step,
    seatIndex: 0,
    attemptOrdinal: step === 'collect' ? 1 : null,
    head12,
    retry,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a step key');
  }
  return built.key;
}

function collectKey(): string {
  return buildKey('collect', 0, null, null);
}

function gateKey(head12: string, retry: number | null = null, round = 0): string {
  return buildKey('gate', round, head12, retry);
}

function reviewKey(step: 'brief-check', round: number, head12: string): string {
  return buildKey(step, round, head12, null);
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
  readonly changedPathReads: { worktreePath: string; baseCommit: string; headCommit: string; recordedHost: AttemptRunnerRecord | null | undefined }[];
  readonly deps: AdvanceLaneRunDependencies;
  setFindReceiptAnswer(answer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult>): void;
  setChangedPaths(paths: readonly string[] | null): void;
  setJournalBaseline(length: number): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const fixRequests: PrepareFixAttemptRequest[] = [];
  const briefRequests: PrepareBriefPackageUseCaseRequest[] = [];
  const dispatchRequests: DispatchAttemptRequest[] = [];
  const changedPathReads: { worktreePath: string; baseCommit: string; headCommit: string; recordedHost: AttemptRunnerRecord | null | undefined }[] = [];
  const manifestJson: string | null = FULL_MANIFEST_JSON;
  let prose: string | null = DEFAULT_PROSE;
  let journalLengthBeforeAdvance = 0;
  let changedPathsAnswer: readonly string[] | null = null;
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
  const prepareAnswer: (request: PrepareFixAttemptRequest) => Promise<PrepareFixAttemptResult> = async (request) => ({
    outcome: 'prepared',
    attempt: buildFixAttempt(request),
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
  const dispatchAnswer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult> = async (request) => ({
    outcome: 'started',
    attempt: buildFixAttempt({
      fixAttemptId: request.attemptId,
      workOrderId: record.workOrderId,
      priorAttemptId: 'attempt-example-1',
      numberedFixes: [],
    }),
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
      readChangedPaths: async (worktreePath, baseCommit, headCommit, recordedHost) => {
        changedPathReads.push({ worktreePath, baseCommit, headCommit, recordedHost });
        return changedPathsAnswer;
      },
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
    // KF-17: the record-only cancel of a never-dispatched attempt, releasing
    // its held reservation, exactly as the real use case does.
    cancelPreparedAttempt: {
      cancelPreparedAttempt: async (request: CancelPreparedAttemptRequest) => {
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
    sameModelFamily: ((left: string, right: string) => left === right) as SameModelFamily,
    workOrderRepo: {
      findWorkOrderById: async () => WORK_ORDER,
    },
    reviewRequest: {
      requestReview: reviewAnswer,
      findReviewReceipt: async (request) => findReceiptAnswer(request),
      findLatestReceiptOfKind: async () => ({ outcome: 'not-found' }),
    },
    prepareFixAttempt: {
      prepareFixAttempt: async (request) => {
        // The intent (with the minted fix attempt id) must already be
        // journalled before any port call: the journal held
        // `journalLengthBeforeAdvance` entries and the act appended
        // exactly one (the intent) before reaching this fake.
        fixRequests.push(request);
        const journalLengthWhenPrepared = (await runJournal.listForRun(RUN_ID)).length;
        expect(journalLengthWhenPrepared).toBe(journalLengthBeforeAdvance + 1);
        const prepared = await prepareAnswer(request);
        if (prepared.outcome === 'prepared') {
          // The port saves the attempt itself; the conductor appends its id to the run record.
          await attemptRepo.saveAttempt(prepared.attempt);
        }
        return prepared;
      },
    },
    // KF-6: the recording `prepareBrief` fake; a fix round places its brief
    // package before preparing the fix attempt.
    prepareBrief: {
      prepareBriefPackage: async (request) => {
        briefRequests.push(request);
        const answer = await prepareBriefAnswer(request);
        // SEC-5b-2: a prepared package is written to the worktree, so later
        // verified reads of the brief serve the prose that was just frozen.
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
    dispatchAttempt: {
      dispatchAttempt: async (request) => {
        dispatchRequests.push(request);
        return dispatchAnswer(request);
      },
    },
    // GB4: the recording CI read; the fact reader answers the exact head.
    ciState: {
      readHeadCiState: async (_request: ReadHeadCiStateRequest): Promise<HeadCiStateRead> => ({
        headSha: COMMIT_A,
        state: 'passed',
        reason: 'read',
      }),
    },
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    fixRequests,
    briefRequests,
    dispatchRequests,
    changedPathReads,
    deps,
    setFindReceiptAnswer: (answer) => {
      findReceiptAnswer = answer;
    },
    setChangedPaths: (paths) => {
      changedPathsAnswer = paths;
    },
    setJournalBaseline: (length) => {
      journalLengthBeforeAdvance = length;
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
  // A result may only follow an intent; fixture seeds append the key's
  // intent when the caller has not already placed one.
  const existing = await harness.runJournal.listForKey(key);
  if (!existing.some((entry) => entry.kind === 'intent')) {
    await appendIntent(harness, key, null, recordedAtIso);
  }
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso, detail);
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

/**
 * The CB9 journal: the round-0 collect at the head, a `brief-check` review
 * failure, a gate failure on that head, and the retried gate pass on the SAME
 * head. The run ends `fixing`, and the review failure is the only unresolved
 * trigger. The receipt walk answers the failed brief-check receipt.
 */
async function seedReviewFailureAfterRetriedGatePass(harness: Harness, step: 'brief-check' = 'brief-check'): Promise<void> {
  await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
  const briefKey = reviewKey(step, 0, HEAD12_A);
  const requestId = 'review-' + harness.deps.newUlid();
  await appendIntent(harness, briefKey, requestId, NOW);
  await appendResult(harness, briefKey, 'completed', 'review-failed', NOW);
  await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
  await appendResult(harness, gateKey(HEAD12_A, 1), 'completed', 'gate-passed', NOW);
  await conduct(harness, 'fixing', NOW);
  harness.setChangedPaths(['src/ex.ts']);
  harness.setFindReceiptAnswer(async (request) => ({
    outcome: 'found',
    receipt: {
      receiptId: 'rcpt-' + request.requestId,
      requestId: request.requestId,
      kind: step,
      reviewerModel: 'review-model-1',
      candidateHeadSha: COMMIT_A,
      verdict: 'failed',
      findings: [blockerFinding()],
    },
  }));
}

/** The stored gate predicate results of the prior's gate: one failed command and one skipped command. */
async function seedFailingGatePredicate(harness: Harness, headCommit: string = COMMIT_A): Promise<void> {
  await harness.executionJournal.appendJournalEntry({
    id: 'attempt-example-1:accept:' + headCommit + ':0',
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
    id: 'attempt-example-1:accept:' + headCommit + ':1',
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
}

describe('AdvanceLaneRunUseCase fix prepare after a retried gate pass (CB9)', () => {
  it('replays a retried gate pass over a gate failure and prepares the review-triggered fix round, then dispatches round 1', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await seedReviewFailureAfterRetriedGatePass(harness);

    // The gate-passed supersession must NOT refuse with prepare-no-gate-checks.
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });

    // The handover carries the review findings and no failing gate predicate.
    expect(harness.fixRequests).toHaveLength(1);
    expect(harness.fixRequests[0]!.numberedFixes).toEqual([
      '[blocker] src/ex.ts:4 — blocks the acceptance check',
    ]);
    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(prose).toContain('[blocker] src/ex.ts:4 — blocks the acceptance check');
    expect(prose).not.toContain('[gate]');

    // The next advance dispatches round 1 instead of parking.
    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    await admit(harness, fixAttemptId as string);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect((await harness.runRepo.get(RUN_ID))?.round).toBe(1);
  });

  it('a retried gate failure with no later gate pass on the same head still prepares a gate fix round with the exact non-passing predicates', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, 1), 'completed', 'gate-failed', NOW);
    await conduct(harness, 'fixing', NOW);
    await seedFailingGatePredicate(harness);

    expect(await advance(harness)).toEqual({
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
  });

  it('refuses prepare-no-gate-checks when a gate-failed is the trigger and no stored gate run predicates exist', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await conduct(harness, 'fixing', NOW);
    // No accept predicate entries at all in the execution journal.

    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', result: 'refused', reasonCode: 'prepare-refused' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter(
      (entry) => entry.kind === 'result' && entry.key === (result as { key: string }).key,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'refused', reasonCode: 'prepare-refused', detail: 'prepare-no-gate-checks' });
    expect(harness.fixRequests).toHaveLength(0);
  });

  it('refuses prepare-no-failure-source when gate-passed supersedes gate-failed and no review failure exists', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, 1), 'completed', 'gate-passed', NOW);
    await conduct(harness, 'fixing', NOW);

    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', result: 'refused', reasonCode: 'prepare-refused' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter(
      (entry) => entry.kind === 'result' && entry.key === (result as { key: string }).key,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'refused',
      reasonCode: 'prepare-refused',
      detail: 'prepare-no-failure-source',
    });
    expect(harness.fixRequests).toHaveLength(0);
  });

  it('a gate pass on a different head does not supersede the gate failure on the failed head', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt(COMMIT_A)]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_B, 1), 'completed', 'gate-passed', NOW);
    await conduct(harness, 'fixing', NOW);
    await seedFailingGatePredicate(harness, COMMIT_A);

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(prose).toContain('[gate] command 1 — fail, exit 1');
  });

  it('a gate pass on a different round does not supersede the gate failure on the failed round', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt(COMMIT_A)]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, null, 1), 'completed', 'gate-passed', NOW);
    await conduct(harness, 'fixing', NOW);
    await seedFailingGatePredicate(harness, COMMIT_A);

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(prose).toContain('[gate] command 1 — fail, exit 1');
  });

  it('refuses prepare-no-failure-source when the only review-failed is in a later round than the superseded gate-failed', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt(COMMIT_A)]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    // The only review failure sits in round 1; the superseded gate failure is round 0.
    const briefKey = reviewKey('brief-check', 1, HEAD12_A);
    await appendIntent(harness, briefKey, null, NOW);
    await appendResult(harness, briefKey, 'completed', 'review-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, 1), 'completed', 'gate-passed', NOW);
    await conduct(harness, 'fixing', NOW);

    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', result: 'refused', reasonCode: 'prepare-refused' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter(
      (entry) => entry.kind === 'result' && entry.key === (result as { key: string }).key,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'refused',
      reasonCode: 'prepare-refused',
      detail: 'prepare-no-failure-source',
    });
  });

  it('refuses prepare-no-failure-source when two rounds each had a superseded gate failure and only round 0 has a review failure', async () => {
    // Walking backward meets the round-1 superseded failure first; the bound
    // must stay at round 1, so the round-0 review failure is NOT accepted.
    const harness = await makeHarness(runRecord(), [collectedAttempt(COMMIT_A)]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    const briefKey = reviewKey('brief-check', 0, HEAD12_A);
    await appendIntent(harness, briefKey, null, NOW);
    await appendResult(harness, briefKey, 'completed', 'review-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, null, 0), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, 1, 0), 'completed', 'gate-passed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, null, 1), 'completed', 'gate-failed', NOW);
    await appendResult(harness, gateKey(HEAD12_A, 1, 1), 'completed', 'gate-passed', NOW);
    await conduct(harness, 'fixing', NOW);

    const result = await advance(harness);
    expect(result).toMatchObject({ outcome: 'acted', result: 'refused', reasonCode: 'prepare-refused' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter(
      (entry) => entry.kind === 'result' && entry.key === (result as { key: string }).key,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ detail: 'prepare-no-failure-source' });
  });

  it('omits the output tail when the evidence archive is absent or throws while keeping the failing predicate', async () => {
    const evidenceRef = 'evidence://dir/file@' + 'a'.repeat(64);
    const buildHarness = async (): Promise<Harness> => {
      const built = await makeHarness(runRecord(), [collectedAttempt(COMMIT_A)]);
      await appendResult(built, collectKey(), 'completed', 'collected', NOW);
      await appendResult(built, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
      await conduct(built, 'fixing', NOW);
      await built.executionJournal.appendJournalEntry({
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
          outputEvidenceRef: evidenceRef,
        }),
      });
      return built;
    };

    // Absent archive: the predicate hands over without its tail.
    const absent = await buildHarness();
    expect(await advance(absent)).toEqual({
      outcome: 'acted', step: 'prepare', key: prepareKey(1, 0, 2), result: 'completed', reasonCode: 'prepared',
    });
    const absentProse = absent.briefRequests[0]!.proseMarkdown!;
    expect(absentProse).toContain('[gate] command 1 — fail, exit 1');
    expect(absentProse).not.toContain('archived tail line');

    // Throwing archive: the same omission, never a crash.
    const throwing = await buildHarness();
    Object.assign(throwing.deps, {
      evidenceArchive: {
        readArchivedEvidence: async () => {
          throw new Error('archive unreadable');
        },
      },
    });
    expect(await advance(throwing)).toEqual({
      outcome: 'acted', step: 'prepare', key: prepareKey(1, 0, 2), result: 'completed', reasonCode: 'prepared',
    });
    const throwingProse = throwing.briefRequests[0]!.proseMarkdown!;
    expect(throwingProse).toContain('[gate] command 1 — fail, exit 1');
    expect(throwingProse).not.toContain('archived tail line');
  });
});

describe('AdvanceLaneRunUseCase fix prepare hostile run journals (CB9)', () => {
  /** The detail of the prepare key's single result entry, after the direct prepare call. */
  function refusedDetailOf(result: unknown): string | null {
    expect(result).toMatchObject({ outcome: 'acted', result: 'refused', reasonCode: 'prepare-refused' });
    const detail = (result as { detail?: string }).detail;
    return detail ?? null;
  }

  /**
   * A direct `performFixPrepare` call against the harness's journals, with an
   * optional lying `listForRun`. The real journal backs
   * `append`/`listForKey` so the refusal can be journalled under the prepare
   * key; only `listForRun` (when overridden) lies.
   */
  async function prepareDirect(
    harness: Harness,
    listForRun?: () => unknown,
  ): Promise<unknown> {
    const ctx: AdvanceStepContext = { deps: harness.deps };
    const request: AdvanceLaneRunRequest = {
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    };
    const decision = {
      kind: 'act' as const,
      step: 'prepare' as const,
      key: prepareKey(1, 0, 2),
      round: 1,
      seatIndex: 0,
      head12: null,
      retry: null,
    };
    const refuse = async (reasonCode: LaneRunResultReasonCode, detail: string | null = null) => {
      const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
      expect(intentRefusal).toBeNull();
      const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', reasonCode, detail);
      expect(resultRefusal).toBeNull();
      return {
        outcome: 'acted' as const,
        step: decision.step,
        key: decision.key,
        result: 'refused' as const,
        reasonCode,
        ...(detail ? { detail } : {}),
      };
    };
    const gathered = {
      facts: { state: 'fixing' },
      attemptRecords: [collectedAttempt()],
    } as unknown as GatheredLaneRunFacts;
    const real = harness.deps.runJournal;
    const runJournal =
      listForRun === undefined
        ? real
        : (Object.assign(Object.create(real), { listForRun }) as unknown as AdvanceLaneRunDependencies['runJournal']);
    const deps: AdvanceLaneRunDependencies = { ...harness.deps, runJournal };
    harness.setJournalBaseline((await harness.runJournal.listForRun(RUN_ID)).length);
    const record = (await harness.runRepo.get(RUN_ID))!;
    return performFixPrepare({ deps }, record, gathered, decision, request, refuse);
  }

  async function seededFixingHarness(): Promise<Harness> {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await appendResult(harness, collectKey(), 'completed', 'collected', NOW);
    await appendResult(harness, gateKey(HEAD12_A), 'completed', 'gate-failed', NOW);
    await conduct(harness, 'fixing', NOW);
    return harness;
  }

  it('refuses prepare-no-failure-source when the run journal entries are null or a non-array', async () => {
    const harness = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(harness, () => null))).toBe('prepare-no-failure-source');

    const second = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(second, () => 'nope'))).toBe('prepare-no-failure-source');
  });

  it('never invokes entry getters and refuses prepare-no-failure-source on a sparse hole or accessor entry', async () => {
    const harness = await seededFixingHarness();
    let keyGetterCalls = 0;
    // A sparse array: index 0 and 1 are holes, index 2 carries an entry whose
    // only review-classifying field is a getter. Running the getter would
    // classify the entry as a review source; skipping it yields no source.
    const hostile = new Array(3);
    const entry: Record<string, unknown> = {
      kind: 'result',
      outcome: 'completed',
      runId: RUN_ID,
      reasonCode: 'review-failed',
      detail: null,
    };
    Object.defineProperty(entry, 'key', {
      enumerable: true,
      get: () => {
        keyGetterCalls += 1;
        return reviewKey('brief-check', 0, HEAD12_A);
      },
    });
    hostile[2] = entry;

    const result = await prepareDirect(harness, () => hostile);
    expect(refusedDetailOf(result)).toBe('prepare-no-failure-source');
    expect(keyGetterCalls).toBe(0);
  });

  it('refuses prepare-no-failure-source on an enormous sparse journal length without walking it', async () => {
    // A sparse-length journal whose length is enormous: without a
    // maximum-length bound the backward walk would iterate billions of
    // entries. The walk must refuse such a journal outright — even though
    // one real entry sits at index 0 — and return promptly (the assertion
    // completes, no hang).
    let keyGetterCalls = 0;
    const entry: Record<string, unknown> = {
      kind: 'result',
      outcome: 'completed',
      runId: RUN_ID,
      reasonCode: 'review-failed',
      detail: null,
    };
    Object.defineProperty(entry, 'key', {
      enumerable: true,
      get: () => {
        keyGetterCalls += 1;
        return reviewKey('brief-check', 0, HEAD12_A);
      },
    });
    const hostile = new Array(2 ** 32 - 2) as unknown[];
    hostile[0] = entry;
    // Also hostile: a length that is not a safe non-negative integer (a
    // Proxy over an array target still passes `Array.isArray`).
    const lying = new Proxy(new Array(1), {
      get(target, property, receiver) {
        if (property === 'length') {
          return '999999';
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown[];

    const first = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(first, () => hostile))).toBe('prepare-no-failure-source');
    const second = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(second, () => lying))).toBe('prepare-no-failure-source');
    expect(keyGetterCalls).toBe(0);
  });

  it('refuses prepare-no-failure-source without throwing on a journal or entry whose proxy traps throw', async () => {
    // A Proxy over an array whose `hasOwnProperty` reach throws: the hole
    // check must not propagate the throw; the entry is skipped.
    const throwingIndexProbe = new Proxy(new Array(1), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor trap');
      },
    });
    const first = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(first, () => throwingIndexProbe))).toBe('prepare-no-failure-source');

    // A Proxy whose descriptor traps report plain own data properties but
    // whose `get` trap throws on the first field read: the entry is skipped
    // and the walk refuses instead of throwing.
    const plain = {
      kind: 'result',
      key: reviewKey('brief-check', 0, HEAD12_A),
      outcome: 'completed',
      runId: RUN_ID,
      reasonCode: 'review-failed',
      detail: null,
    };
    const lyingGet = new Proxy(plain, {
      get() {
        throw new Error('hostile get trap');
      },
    });
    const second = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(second, () => [lyingGet]))).toBe('prepare-no-failure-source');
  });

  it('refuses prepare-no-failure-source and never runs an inherited accessor on an entry', async () => {
    let inheritedGetterCalls = 0;
    // The entry itself has plain data fields, but `key` is an inherited
    // accessor: reading it would classify the entry as a review source. Only
    // own data properties are readable, so the entry is skipped and the
    // accessor is never invoked.
    const proto = Object.create(Object.prototype, {
      key: {
        enumerable: true,
        get: () => {
          inheritedGetterCalls += 1;
          return reviewKey('brief-check', 0, HEAD12_A);
        },
      },
    });
    const inherited = Object.create(proto, {
      kind: { enumerable: true, value: 'result' },
      outcome: { enumerable: true, value: 'completed' },
      runId: { enumerable: true, value: RUN_ID },
      reasonCode: { enumerable: true, value: 'review-failed' },
      detail: { enumerable: true, value: null },
    });
    // A throwing `getPrototypeOf` trap is now inert: every field the walk
    // reads was proved to be an own data property, so reads never consult the
    // prototype chain. The entry's own consistent data is honored and the
    // walk proceeds past it (the refusal then comes from the later review
    // step, not from a throw).
    const opaqueProto = new Proxy(Object.prototype, {
      getPrototypeOf() {
        throw new Error('hostile prototype trap');
      },
    });
    const opaque = Object.create(opaqueProto, {
      kind: { enumerable: true, value: 'result' },
      outcome: { enumerable: true, value: 'completed' },
      runId: { enumerable: true, value: RUN_ID },
      reasonCode: { enumerable: true, value: 'review-failed' },
      detail: { enumerable: true, value: null },
      key: { enumerable: true, value: reviewKey('brief-check', 0, HEAD12_A) },
    });

    const first = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(first, () => [inherited]))).toBe('prepare-no-failure-source');
    const second = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(second, () => [opaque]))).toBe('prepare-no-review-request');
    expect(inheritedGetterCalls).toBe(0);
  });

  it('refuses prepare-no-failure-source and never throws on a revoked Proxy entry', async () => {
    // `Array.isArray` on a revoked Proxy throws TypeError: the entry shape
    // check must catch that throw and skip the entry — for both a revoked
    // plain-object proxy and a revoked array proxy — instead of letting the
    // hostile-input throw escape the walk.
    const objectRevocation = Proxy.revocable({ kind: 'result' }, {});
    const arrayRevocation = Proxy.revocable([], {});
    objectRevocation.revoke();
    arrayRevocation.revoke();

    const first = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(first, () => [objectRevocation.proxy]))).toBe(
      'prepare-no-failure-source',
    );
    const second = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(second, () => [arrayRevocation.proxy]))).toBe(
      'prepare-no-failure-source',
    );
  });

  it('refuses prepare-no-failure-source and never throws when the whole journal listing is a revoked Proxy', async () => {
    // `Array.isArray` itself throws TypeError on a revoked Proxy: the listing
    // check must catch that and refuse, not let the throw escape prepare.
    const listingRevocation = Proxy.revocable([] as unknown[], {});
    listingRevocation.revoke();
    const harness = await seededFixingHarness();
    expect(
      refusedDetailOf(await prepareDirect(harness, () => listingRevocation.proxy as unknown as unknown[])),
    ).toBe('prepare-no-failure-source');
  });

  it('refuses prepare-no-failure-source when an entry supplies its fields through inherited data properties', async () => {
    // An entry shaped with `Object.create(proto)`: `kind`, `key`, `outcome`,
    // `runId`, `reasonCode` and `detail` are plain data fields ON THE
    // PROTOTYPE, not accessors. The walk reads only own data properties, so
    // the entry is refused instead of being classified as a review source it
    // never recorded on itself.
    const proto = {
      kind: 'result',
      key: reviewKey('brief-check', 0, HEAD12_A),
      outcome: 'completed',
      runId: RUN_ID,
      reasonCode: 'review-failed',
      detail: null,
    };
    const inheritedData = Object.create(proto);
    // Sanity: the fields really are inherited, not own — the assertion below
    // is about the prototype path, so it must not silently hold for another
    // reason.
    for (const field of ['kind', 'key', 'outcome', 'runId', 'reasonCode', 'detail'] as const) {
      expect(Object.hasOwn(inheritedData, field)).toBe(false);
    }
    const harness = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(harness, () => [inheritedData]))).toBe('prepare-no-failure-source');
  });

  it('refuses prepare-no-failure-source when only some walk fields are inherited from the prototype', async () => {
    // A partial prototype supply: `kind`, `outcome` and `detail` are own data
    // fields, but `key`, `runId` and `reasonCode` come from the prototype and
    // would classify the entry as a gate failure source. No inherited field
    // may be read, so the entry is refused.
    const proto = {
      key: gateKey(HEAD12_A),
      runId: RUN_ID,
      reasonCode: 'gate-failed',
    };
    const partiallyInherited = Object.assign(Object.create(proto), {
      kind: 'result',
      outcome: 'completed',
      detail: null,
    });
    for (const field of ['key', 'runId', 'reasonCode'] as const) {
      expect(Object.hasOwn(partiallyInherited, field)).toBe(false);
    }
    const harness = await seededFixingHarness();
    expect(refusedDetailOf(await prepareDirect(harness, () => [partiallyInherited]))).toBe(
      'prepare-no-failure-source',
    );
  });

  it('refuses prepare-gate-journal-unreadable when the execution journal read throws', async () => {
    const harness = await seededFixingHarness();
    // Driven through performFixPrepare directly: the unreadable journal must
    // be caught INSIDE the prepare, never escaping the advance.
    (
      harness.executionJournal as unknown as { listJournalEntriesForAttempt: () => Promise<never> }
    ).listJournalEntriesForAttempt = async () => {
      throw new Error('execution journal unreadable');
    };

    const result = await prepareDirect(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'refused',
      reasonCode: 'prepare-refused',
      detail: 'prepare-gate-journal-unreadable',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === prepareKey(1, 0, 2));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'refused',
      reasonCode: 'prepare-refused',
      detail: 'prepare-gate-journal-unreadable',
    });
  });

  it('does not treat an ambiguous gate result as gate-passed: the earlier gate failure still triggers a gate fix round', async () => {
    const harness = await seededFixingHarness();
    // An ambiguous non-final result on the retry key is never a pass. The
    // decider parks on such a journal, so the prepare is called directly.
    await appendResult(harness, gateKey(HEAD12_A, 1), 'ambiguous', 'gate-passed', NOW);
    await seedFailingGatePredicate(harness);

    // Were the ambiguous result treated as a pass, the backwards walk would
    // supersede the gate failure and end with no source, refusing
    // prepare-no-failure-source; instead the gate failure stays the trigger
    // and carries its failing predicate.
    const result = await prepareDirect(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(1, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const prose = harness.briefRequests[0]!.proseMarkdown!;
    expect(prose).toContain('[gate] command 1 — fail, exit 1');
  });
});
