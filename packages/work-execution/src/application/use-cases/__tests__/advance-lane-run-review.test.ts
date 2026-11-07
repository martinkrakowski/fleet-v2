/**
 * Unit tests for K5-4a: the conductor's `act brief-check` and `act code-review`
 * steps. Each writes its keyed intent (the minted request id) before any port
 * call, opens the evidence assessment, runs the review through
 * `ReviewRequestPort` and appends a reason-code result; reply text and findings
 * are never journalled. Every store is in-memory; no runner, no subprocess, no
 * network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
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
import {
  nextLaneRunAction,
  REVIEW_SEAT_UNAVAILABLE_MAX_PASSES,
  type LaneRunDecision,
} from '../../../domain/lane-run-decider.js';
import type { SameModelFamily } from '../../../domain/seat-selection.js';
import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  FindReviewReceiptRequest,
  FindReviewReceiptResult,
  RecordOutOfScopeRequest,
  RecordOutOfScopeResult,
  ReviewRequest,
  ReviewReceiptSummary,
  ReviewRequestFinding,
  ReviewRequestResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type { OpenReviewAssessmentRequest, OpenReviewAssessmentResult } from '../../ports/out/ReviewAssessmentPort.out-port.js';
import type { AcceptanceAssessmentRequest } from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import { reviewFactsOf } from '../advance-lane-run/review-fix.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../advance-lane-run/step-context.js';
import { ReviewRequestAdapter } from '../../../infrastructure/adapters/ReviewRequestAdapter.adapter.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from '../../../domain/lane-run-journal.js';
import { SECRET_PATTERNS } from '@fleet/shared';
import type {
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewReceiptRecord,
  ReviewUnknownReason,
} from '@fleet/evidence-and-acceptance';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
const HEAD12_B = 'b'.repeat(12);
// SEC-5b: the review's frozen manifest is read digest-verified. The served
// manifest and the recorded digest are frozen together so every default read
// verifies.
const PROSE = '# brief\n';
const DEFAULT_MANIFEST_JSON = JSON.stringify({ acceptanceChecks: ['check-1'] });
const digestFor = (json: string): string => simpleDeterministicHexDigest(PROSE + '\n' + json);
const SHA = digestFor(DEFAULT_MANIFEST_JSON);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

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

const REVIEW_SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [
    { id: 'rev-1', model: 'review-model-1', tool: 'opencode' },
    { id: 'rev-2', model: 'review-model-2', tool: 'opencode' },
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

/** A collected attempt whose head is `headCommit`; it is the run's latest attempt. */
function collectedAttempt(headCommit: string = COMMIT_A): AttemptRecord {
  const artifacts: CollectedAttemptArtifacts = {
    headCommit,
    commitsSinceBase: [headCommit],
    collectedArtifactPaths: [],
    notes: 'present',
  };
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
    briefDigest: SHA,
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
    artifacts,
    runner: CONDUCTED_RUNNER,
    seatPlan: REVIEW_SEAT_PLAN,
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

function receiptFor(request: ReviewRequest, verdict: 'passed' | 'failed' | 'unknown', findings: readonly ReviewRequestFinding[] = []): ReviewReceiptSummary {
  return {
    receiptId: 'rcpt-' + request.requestId,
    requestId: request.requestId,
    kind: request.kind,
    reviewerModel: request.reviewerModel,
    candidateHeadSha: request.candidateHeadSha,
    verdict,
    findings,
  };
}

/** A run record via the domain entity, like the K4 fixtures. */
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

function acceptKey(): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'accept',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: HEAD12_A,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build an accept key');
  }
  return built.key;
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly reviewRequests: ReviewRequest[];
  readonly openRequests: OpenReviewAssessmentRequest[];
  readonly workOrderLookups: string[];
  readonly deps: AdvanceLaneRunDependencies;
  readonly journalLengthWhenCalled: number;
  readonly journalLengthWhenOpened: number;
  setManifest(json: string | null): Promise<void>;
  /** Serves a changed manifest on disk without re-freezing any attempt digest (SEC-5b digest-mismatch tests). */
  setChangedManifestOnDisk(json: string | null): void;
  /** Serves changed prose on disk without re-freezing any attempt digest (SEC-3b prose-mismatch tests). */
  setChangedProseOnDisk(text: string): void;
  /** Serves changed prose from the second read on: the first read of the step still returns the frozen bytes (SEC-3b race test). */
  setProseAfterFirstRead(text: string): void;
  readonly readBriefFileCalls: number;
  setReviewAnswer(answer: (request: ReviewRequest) => Promise<ReviewRequestResult>): void;
  setFindReceiptAnswer(answer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult>): void;
  setOpenAnswer(answer: OpenReviewAssessmentResult): void;
  setWorkOrderAnswer(answer: WorkOrderRecord | null): void;
  setSameFamily(fn: SameModelFamily): void;
  setJournalBaseline(length: number): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
  options: {
    readonly wireReviewRequest?: boolean;
    readonly wireReviewAssessment?: boolean;
    readonly wireWorkOrder?: boolean;
    readonly wireSameFamily?: boolean;
  } = {},
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const reviewRequests: ReviewRequest[] = [];
  const openRequests: OpenReviewAssessmentRequest[] = [];
  const workOrderLookups: string[] = [];
  let manifestJson: string | null = DEFAULT_MANIFEST_JSON;
  let prose = PROSE;
  let proseAfterFirstRead: string | null = null;
  let readBriefFileCalls = 0;
  let openAnswer: OpenReviewAssessmentResult = { outcome: 'open' };
  let workOrderAnswer: WorkOrderRecord | null = WORK_ORDER;
  let journalLengthWhenCalled = 0;
  let journalLengthWhenOpened = 0;
  let journalLengthBeforeAdvance = 0;
  let sameFamilyImpl: SameModelFamily = (left, right) => left === right;
  let reviewAnswer: (request: ReviewRequest) => Promise<ReviewRequestResult> = async (request) => {
    // The intent (with the minted request id) must already be journalled before
    // any port call: the journal held `journalLengthBeforeAdvance` entries and
    // the act appended exactly one (the intent) before reaching this fake.
    journalLengthWhenCalled = (await runJournal.listForRun(RUN_ID)).length;
    expect(journalLengthWhenCalled).toBe(journalLengthBeforeAdvance + 1);
    return { outcome: 'receipt', receipt: receiptFor(request, 'passed') };
  };
  let findReceiptAnswer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult> = async () => ({
    outcome: 'not-found',
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
      readBriefManifest: async () => manifestJson,
      // SEC-3b: the frozen prose is served from a single value regardless of
      // path; the review's digest read and any brief text both come from it.
      readBriefFile: async () => {
        readBriefFileCalls += 1;
        if (proseAfterFirstRead !== null && readBriefFileCalls === 1) {
          return PROSE;
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
    newUlid: makeUlidMinter(),
    ...(options.wireSameFamily === false ? {} : { sameModelFamily: (left: string, right: string) => sameFamilyImpl(left, right) }),
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
    ...(options.wireReviewAssessment === false
      ? {}
      : {
          reviewAssessment: {
            openReviewAssessment: async (request) => {
              // The intent must precede the assessment call as well (Luna minor, K5-4a review).
              journalLengthWhenOpened = (await runJournal.listForRun(RUN_ID)).length;
              expect(journalLengthWhenOpened).toBe(journalLengthBeforeAdvance + 1);
              openRequests.push(request);
              return openAnswer;
            },
          },
        }),
    ...(options.wireWorkOrder === false
      ? {}
      : {
          workOrderRepo: {
            findWorkOrderById: async (id) => {
              workOrderLookups.push(id);
              return workOrderAnswer;
            },
          },
        }),
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    reviewRequests,
    openRequests,
    workOrderLookups,
    deps,
    get journalLengthWhenCalled() {
      return journalLengthWhenCalled;
    },
    get journalLengthWhenOpened() {
      return journalLengthWhenOpened;
    },
    setManifest: async (json) => {
      manifestJson = json;
      // SEC-5b: a re-frozen manifest re-freezes the stored attempts' digests
      // too, so every read of the served manifest verifies against it.
      if (json !== null) {
        const digest = digestFor(json);
        for (const attempt of await attemptRepo.listAllAttempts()) {
          if (attempt.briefDigest !== digest) {
            await attemptRepo.saveAttempt({
              ...attempt,
              revision: (attempt.revision ?? 0) + 1,
              briefDigest: digest,
            });
          }
        }
      }
    },
    // The changed-on-disk path (SEC-5b): the served manifest changes without
    // any attempt digest being re-frozen — every digest read then mismatches.
    setChangedManifestOnDisk: (json) => {
      manifestJson = json;
    },
    setChangedProseOnDisk: (text) => {
      prose = text;
    },
    setProseAfterFirstRead: (text) => {
      proseAfterFirstRead = text;
      prose = text;
    },
    get readBriefFileCalls() {
      return readBriefFileCalls;
    },
    setReviewAnswer: (answer) => {
      reviewAnswer = answer;
    },
    setFindReceiptAnswer: (answer) => {
      findReceiptAnswer = answer;
    },
    setOpenAnswer: (answer) => {
      openAnswer = answer;
    },
    setWorkOrderAnswer: (answer) => {
      workOrderAnswer = answer;
    },
    setSameFamily: (fn) => {
      sameFamilyImpl = fn;
    },
    setJournalBaseline: (length) => {
      journalLengthBeforeAdvance = length;
    },
  };
}

type PerformDecisionFn = (
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: LaneRunDecision,
  request: AdvanceLaneRunRequest,
) => Promise<AdvanceLaneRunResult>;

async function advance(
  harness: Harness,
  overrides: Record<string, unknown> & { readonly reviewSeatUnavailablePasses?: number } = {},
) {
  harness.setJournalBaseline((await harness.runJournal.listForRun(RUN_ID)).length);
  const { reviewSeatUnavailablePasses, ...requestOverrides } = overrides;
  const useCase = new AdvanceLaneRunUseCase(harness.deps);
  if (reviewSeatUnavailablePasses !== undefined) {
    const target = useCase as unknown as { performDecision: PerformDecisionFn };
    const origPerformDecision = target.performDecision.bind(useCase);
    target.performDecision = (record, gathered, _decision, request) => {
      const facts = { ...gathered.facts, reviewSeatUnavailablePasses };
      return origPerformDecision(
        record,
        { ...gathered, facts },
        nextLaneRunAction(record, facts, request.nowIso),
        request,
      );
    };
  }
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...requestOverrides,
  });
}

async function conduct(harness: Harness, state: LaneRunStateValue, nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendIntent(harness: Harness, key: string, mintedId: string | null, recordedAtIso: string): Promise<void> {
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

describe('AdvanceLaneRunUseCase review acts (K5-4a)', () => {
  it('act brief-check passes: the intent with the request id is journalled first, then review-passed, and the next advance enters code-review', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    const result = await advance(harness);
    const key = reviewKey('brief-check', 0, HEAD12_A);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'completed',
      reasonCode: 'review-passed',
    });
    expect(harness.reviewRequests).toHaveLength(1);
    const request = harness.reviewRequests[0]!;
    expect(request).toEqual({
      requestId: request.requestId,
      kind: 'brief-check',
      attemptId: 'attempt-example-1',
      projectId: 'project-example-1',
      candidateHeadSha: COMMIT_A,
      policyRevision: 'policy-example-1',
      implementerModel: 'model-example-1',
      reviewerModel: 'review-model-1',
      briefText: PROSE,
      nowIso: LATER,
    });
    expect(harness.openRequests).toHaveLength(1);
    expect(harness.openRequests[0]).toEqual({
      attemptId: 'attempt-example-1',
      projectId: 'project-example-1',
      candidateHeadSha: COMMIT_A,
      policyRevision: 'policy-example-1',
      implementerModel: 'model-example-1',
      requiredChecks: ['check-1'],
    });
    // The intent was appended before any port call, minting the request id.
    expect(harness.journalLengthWhenCalled).toBe(2);
    expect(harness.journalLengthWhenOpened).toBe(2);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intent = entries.find((entry) => entry.kind === 'intent' && entry.key === key);
    expect(intent?.mintedId).toBe(request.requestId);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'review-passed' });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
  });

  it('act brief-check with a denying start gate waits session-stagger: no intent and requestReview is never called (KF-34a1)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    const result = await advance(harness, {
      startGate: { tryStart: () => ({ ok: false, retryAfterMs: 12_345 }) },
    });
    expect(result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(harness.reviewRequests).toHaveLength(0);
    expect(harness.openRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'intent')).toBe(false);
  });

  it('act brief-check fails: the next advance enters fixing', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', [
        { findingId: 'finding-1', severity: 'blocker', summary: 'blocks', filePath: 'src/ex.ts', line: 4 },
      ]),
    }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-failed',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'fixing' });
  });

  it('no-receipt retries the same seat once, then moves to the next seat, then parks when the plan is exhausted', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => ({ outcome: 'no-receipt', reason: 'review-unavailable', detail: null }));
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-no-receipt',
    });
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A, 1),
      result: 'completed',
      reasonCode: 'review-no-receipt',
    });
    // Block the first review seat so selection moves to the next seat.
    harness.setSameFamily((left, right) => left === 'review-model-1' && right === 'model-example-1');
    const third = await advance(harness);
    expect(third).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 1, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-no-receipt',
    });
    // RV4 + PT1d: retries count every remaining review intent of the generation
    // (`remaining.length - 1`), so after the one budget retry on the first
    // seat the switched seat's no-receipt gets no second retry; with the seat
    // plan exhausted the step waits review-seat-unavailable until
    // reviewSeatUnavailablePasses reaches REVIEW_SEAT_UNAVAILABLE_MAX_PASSES,
    // and only then parks.
    const fourth = await advance(harness);
    expect(fourth).toEqual({ outcome: 'waiting', reason: 'review-seat-unavailable' });
    const fifth = await advance(harness, {
      reviewSeatUnavailablePasses: REVIEW_SEAT_UNAVAILABLE_MAX_PASSES - 1,
    });
    expect(fifth).toEqual({ outcome: 'waiting', reason: 'review-seat-unavailable' });
    const sixth = await advance(harness, {
      reviewSeatUnavailablePasses: REVIEW_SEAT_UNAVAILABLE_MAX_PASSES,
    });
    expect(sixth).toEqual({ outcome: 'parked', reason: 'review-seat-unavailable', qualifier: null });
  });

  it('journals the fixed detail of a no-receipt result end to end', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => ({
      outcome: 'no-receipt',
      reason: 'review-unavailable',
      detail: 'route-no-auth-file',
    }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-no-receipt',
      detail: 'route-no-auth-file',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter(
      (entry) => entry.kind === 'result' && entry.key === reviewKey('brief-check', 0, HEAD12_A),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'completed',
      reasonCode: 'review-no-receipt',
      detail: 'route-no-auth-file',
    });
  });

  it('D10: a recorded fail for the kind keeps its seat on the next head, and a seat index gone from the plan reads { ok: false }', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt(COMMIT_B)]);
    await conduct(harness, 'brief-check', NOW);
    const oldKey = reviewKey('brief-check', 0, HEAD12_A);
    await appendIntent(harness, oldKey, null, NOW);
    await appendResult(harness, oldKey, 'completed', 'review-failed', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_B),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    expect(harness.reviewRequests[0]!.reviewerModel).toBe('review-model-1');

    const ctx = { deps: { sameModelFamily: (left: string, right: string) => left === right } } as unknown as AdvanceStepContext;
    const record = runRecord();
    const codeKey = reviewKey('code-review', 5, HEAD12_A);
    const mint = makeUlidMinter();
    const entries = [
      laneRunConductEntry(mint(), RUN_ID, 'code-review', NOW),
      laneRunIntentEntry(mint(), RUN_ID, codeKey, null, NOW),
      laneRunResultEntry(mint(), RUN_ID, codeKey, 'completed', 'review-failed', NOW),
    ];
    const facts = reviewFactsOf(ctx, record, 'code-review', entries, HEAD12_B, [collectedAttempt(COMMIT_B)]);
    expect(facts.reviewSeat).toEqual({ ok: false });
  });

  it('D10: the pin holds when sameModelFamily is unbound; without a recorded fail the seat is { ok: false }', async () => {
    const ctx = { deps: {} } as unknown as AdvanceStepContext;
    const codeKey = reviewKey('code-review', 0, HEAD12_A);
    const mint = makeUlidMinter();
    const failed = [
      laneRunConductEntry(mint(), RUN_ID, 'code-review', NOW),
      laneRunIntentEntry(mint(), RUN_ID, codeKey, null, NOW),
      laneRunResultEntry(mint(), RUN_ID, codeKey, 'completed', 'review-failed', NOW),
    ];
    const pinned = reviewFactsOf(ctx, runRecord(), 'code-review', failed, HEAD12_B, [collectedAttempt(COMMIT_B)]);
    expect(pinned.reviewSeat).toEqual({ ok: true, seatIndex: 0 });

    const noFail = [laneRunConductEntry(mint(), RUN_ID, 'code-review', NOW)];
    const unpinned = reviewFactsOf(ctx, runRecord(), 'code-review', noFail, HEAD12_B, [collectedAttempt(COMMIT_B)]);
    expect(unpinned.reviewSeat).toEqual({ ok: false });
  });

  it('reviewRequest unbound is not-wired and writes nothing', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()], { wireReviewRequest: false });
    await conduct(harness, 'brief-check', NOW);
    expect(await advance(harness)).toEqual({ outcome: 'not-wired', step: 'brief-check' });
    expect(await harness.runJournal.listForRun(RUN_ID)).toHaveLength(1);
  });

  it('an unavailable assessment refuses assessment-unavailable and never calls requestReview', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setOpenAnswer({ outcome: 'unavailable', reason: 'terminal' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'refused',
      reasonCode: 'assessment-unavailable',
    });
    expect(harness.reviewRequests).toHaveLength(0);
    expect(harness.openRequests).toHaveLength(1);
  });

  it('forwards the frozen manifest acceptanceChecks as requiredChecks and refuses an empty list without opening or requesting', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    await harness.setManifest(JSON.stringify({ acceptanceChecks: ['check-a', 'check-b'] }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    expect(harness.openRequests[0]!.requiredChecks).toEqual(['check-a', 'check-b']);

    const hEmpty = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(hEmpty, 'brief-check', NOW);
    await hEmpty.setManifest(JSON.stringify({ acceptanceChecks: [] }));
    const refused = await advance(hEmpty);
    expect(refused).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'refused',
      reasonCode: 'assessment-unavailable',
    });
    expect(hEmpty.openRequests).toHaveLength(0);
    expect(hEmpty.reviewRequests).toHaveLength(0);
  });

  it('a changed frozen manifest refuses assessment-unavailable, read digest-verified (SEC-5b)', async () => {
    // The served manifest is a legitimate re-freeze whose bytes no attempt
    // recorded: the review must refuse on the digest itself, before the
    // assessment is opened (the changed-on-disk path, never `setManifest`,
    // which re-freezes the digests).
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setChangedManifestOnDisk(JSON.stringify({ acceptanceChecks: ['check-a', 'check-b'] }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'refused',
      reasonCode: 'assessment-unavailable',
    });
    expect(harness.openRequests).toHaveLength(0);
    expect(harness.reviewRequests).toHaveLength(0);
  });

  it('forwards the digest-verified prose as briefText only for brief-check (SEC-3b)', async () => {
    // The brief text is no longer read separately: it is the prose the
    // verified frozen-brief read already covered.
    const hBrief = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(hBrief, 'brief-check', NOW);
    await advance(hBrief);
    expect(hBrief.reviewRequests[0]!.briefText).toBe(PROSE);

    const hCode = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(hCode, 'code-review', NOW);
    await advance(hCode);
    expect(hCode.reviewRequests).toHaveLength(1);
    expect(hCode.reviewRequests[0]!.kind).toBe('code-review');
    expect(hCode.reviewRequests[0]!.briefText).toBeUndefined();
  });

  it('regression guard: prose changed on disk after dispatch refuses assessment-unavailable before opening or requesting (SEC-3b)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setChangedProseOnDisk('# changed brief\n');
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'refused',
      reasonCode: 'assessment-unavailable',
    });
    expect(harness.openRequests).toHaveLength(0);
    expect(harness.reviewRequests).toHaveLength(0);
  });

  it('a prose race between the verified read and the reviewer text is impossible: one read feeds both (SEC-3b)', async () => {
    // The harness serves the frozen bytes on the first `readBriefFile` call of
    // the step and changed bytes on every later call. After SEC-3b the review
    // act reads the brief once, so the reviewer gets the verified bytes; the
    // pre-change act read twice and handed the reviewer the changed bytes.
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setProseAfterFirstRead('# changed brief\n');
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    expect(harness.reviewRequests[0]!.briefText).toBe(PROSE);
    expect(harness.readBriefFileCalls).toBe(1);
  });

  it('regression guard: no recorded brief package path reads absent and refuses assessment-unavailable (SEC-3b)', async () => {
    const harness = await makeHarness(runRecord(), [{ ...collectedAttempt(), briefPackagePath: null }]);
    await conduct(harness, 'brief-check', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'refused',
      reasonCode: 'assessment-unavailable',
    });
    expect(harness.openRequests).toHaveLength(0);
    expect(harness.reviewRequests).toHaveLength(0);
  });

  it('never journals the review reply finding summary text', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', [
        { findingId: 'finding-1', severity: 'major', summary: 'SECRET-FINDING-SUMMARY', filePath: 'src/ex.ts', line: 4 },
      ]),
    }));
    await advance(harness);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(JSON.stringify(entries)).not.toContain('SECRET-FINDING-SUMMARY');
  });

  it('an unknown outcome leaves the intent pending without a result', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => ({ outcome: 'unknown', reason: 'delegate-failed' }));
    const result = await advance(harness);
    const key = reviewKey('brief-check', 0, HEAD12_A);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === key);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
    expect(intents).toHaveLength(1);
    expect(results).toHaveLength(0);
    expect(harness.reviewRequests).toHaveLength(1);
  });
});

describe('AdvanceLaneRunUseCase minors-only brief-check override (GB1)', () => {
  /** One minor and one nit finding: the smallest minors-only receipt. */
  const MINOR_ONLY_FINDINGS: readonly ReviewRequestFinding[] = [
    { findingId: 'finding-1', severity: 'minor', summary: 'a minor note', filePath: 'src/ex.ts', line: 4 },
    { findingId: 'finding-2', severity: 'nit', summary: 'a nit', filePath: null, line: null },
  ];

  function receiptWith(request: ReviewRequest, findings: readonly ReviewRequestFinding[]): ReviewRequestResult {
    return { outcome: 'receipt', receipt: receiptFor(request, 'failed', findings) };
  }

  /** The override receipt the reconcile reads back for the seeded request id. */
  async function foundMinorsOnlyReceipt(request: FindReviewReceiptRequest): Promise<FindReviewReceiptResult> {
    return {
      outcome: 'found',
      receipt: {
        receiptId: 'rcpt-1',
        requestId: request.requestId,
        kind: 'brief-check',
        reviewerModel: 'review-model-1',
        candidateHeadSha: COMMIT_A,
        verdict: 'failed',
        findings: MINOR_ONLY_FINDINGS,
      },
    };
  }

  it('a minors-only failed brief-check journals review-passed with the fixed detail and enters code-review', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => receiptWith(request, MINOR_ONLY_FINDINGS));
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'review-passed', detail: 'minor-only-findings' });
    expect(JSON.stringify(entries)).not.toContain('a minor note');
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
  });

  it('a crashed brief-check whose minors-only receipt is in evidence reconciles review-passed with the fixed detail', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => {
      throw new Error('delegate-failed');
    });
    harness.setFindReceiptAnswer(foundMinorsOnlyReceipt);
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const first = await advance(harness);
    expect(first).toEqual({ outcome: 'acted', step: 'brief-check', key, result: 'ambiguous', reasonCode: 'review-unknown' });
    const second = await advance(harness);
    expect(second).toEqual({ outcome: 'acted', step: 'brief-check', key, result: 'reconciled', reasonCode: 'review-passed', detail: 'minor-only-findings' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'review-passed', detail: 'minor-only-findings' });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
  });

  it('a code-review fail with only minors journals review-passed with the minor-only detail and enters accepting (RV3)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'code-review', NOW);
    harness.setReviewAnswer(async (request) => receiptWith(request, MINOR_ONLY_FINDINGS));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'accepting' });
  });

  it('a brief-check fail carrying a major finding still journals review-failed and enters fixing', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => receiptWith(request, [
      { findingId: 'finding-1', severity: 'major', summary: 'a major', filePath: 'src/ex.ts', line: 4 },
    ]));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-failed',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'fixing' });
  });

  it('a failed brief-check receipt with zero findings is an unparseable verdict: review-unknown, retried once on the same seat (RV3)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => receiptWith(request, []));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
      detail: 'unparseable-verdict',
    });
    // V7: the unknown verdict retries once on the same seat at the same head —
    // never `fixing`, never `code-review`.
    const next = await advance(harness);
    expect(next).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A) + '/retry1',
      result: 'completed',
      reasonCode: 'review-unknown',
      detail: 'unparseable-verdict',
    });
    expect(JSON.stringify(next)).not.toContain('fixing');
  });

  it('a brief-check receipt with an unreadable verdict still maps review-unknown (fail closed)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'unknown', MINOR_ONLY_FINDINGS),
    }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
  });

  it('a minor-only fail never records out-of-scope dispositions and journals the minor-only detail (RV3)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => receiptWith(request, [
      { findingId: 'finding-1', severity: 'minor', summary: 'a minor note', filePath: 'src/ex.ts', line: 4 },
      { findingId: 'finding-2', severity: 'nit', summary: 'a nit', filePath: 'src/ex-2.ts', line: 9 },
    ]));
    let outOfScopeCalls = 0;
    Object.assign(harness.deps, {
      artifactPort: {
        ...harness.deps.artifactPort,
        readChangedPaths: async () => ['src/other.ts'],
      },
      reviewRequest: {
        ...harness.deps.reviewRequest,
        recordOutOfScope: async () => {
          outOfScopeCalls += 1;
          return { outcome: 'recorded' } as const;
        },
      },
    });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
    });
    // A minor-only receipt never records any out-of-scope disposition.
    expect(outOfScopeCalls).toBe(0);
  });
});

describe('AdvanceLaneRunUseCase review reconcile (K5-4b)', () => {
  it('a throwing request with a receipt already in evidence is reconciled from that receipt into review-passed, then code-review', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => {
      throw new Error('delegate-failed');
    });
    harness.setFindReceiptAnswer(async (request) => ({
      outcome: 'found',
      receipt: {
        receiptId: 'rcpt-1',
        requestId: request.requestId,
        kind: 'brief-check',
        reviewerModel: 'review-model-1',
        candidateHeadSha: COMMIT_A,
        verdict: 'passed',
        findings: [],
      },
    }));
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'reconciled',
      reasonCode: 'review-passed',
    });
    // The reconcile read the receipt; it never called requestReview again.
    expect(harness.reviewRequests).toHaveLength(1);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
  });

  it('not-found closes the key as review-no-receipt and the decider retries once under the /retry1 key', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => ({ outcome: 'unknown', reason: 'delegate-failed' }));
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    expect(harness.reviewRequests).toHaveLength(1);
    const firstRequestId = harness.reviewRequests[0]!.requestId;
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'completed',
      reasonCode: 'review-no-receipt',
    });
    // The reconcile never called requestReview again under the first key.
    expect(harness.reviewRequests).toHaveLength(1);
    harness.setReviewAnswer(async (request) => ({ outcome: 'receipt', receipt: receiptFor(request, 'passed') }));
    const third = await advance(harness);
    expect(third).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A, 1),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    expect(harness.reviewRequests).toHaveLength(2);
    expect(harness.reviewRequests[0]!.requestId).toBe(firstRequestId);
    expect(harness.reviewRequests[1]!.requestId).not.toBe(firstRequestId);
  });

  it('a receipt with an unknown verdict retries the same seat once at the same head, then a passed receipt enters accepting', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    // The brief-check passes so the run reaches code-review; the review under test is code-review.
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'brief-check', key: reviewKey('brief-check', 0, HEAD12_A), result: 'completed', reasonCode: 'review-passed',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
    harness.setReviewAnswer(async (r) => ({ outcome: 'receipt', receipt: receiptFor(r, 'unknown') }));
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    // One brief-check request (its answer defaults to passed) plus the code-review request under test.
    expect(harness.reviewRequests).toHaveLength(2);
    const firstRequestId = harness.reviewRequests[1]!.requestId;
    harness.setReviewAnswer(async (r) => ({ outcome: 'receipt', receipt: receiptFor(r, 'passed') }));
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A, 1),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    // Brief-check (default passed) plus the two code-review requests under test.
    expect(harness.reviewRequests).toHaveLength(3);
    expect(harness.reviewRequests[2]!.requestId).not.toBe(firstRequestId);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'accepting' });
  });

  it('a receipt with an unknown verdict twice parks ambiguous with the review step as qualifier after the one retry', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    // The brief-check passes so the run reaches code-review; the review under test is code-review.
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'brief-check', key: reviewKey('brief-check', 0, HEAD12_A), result: 'completed', reasonCode: 'review-passed',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
    harness.setReviewAnswer(async (r) => ({ outcome: 'receipt', receipt: receiptFor(r, 'unknown') }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A, 1),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    expect(harness.reviewRequests).toHaveLength(3);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'code-review' });
  });

  it('an unavailable receipt parks the run ambiguous with the review step as qualifier', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => ({ outcome: 'unknown', reason: 'delegate-failed' }));
    harness.setFindReceiptAnswer(async () => ({ outcome: 'unavailable', reason: 'unreadable' }));
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'brief-check' });
  });

  it('a reconcile decision with no minted request id on the intent stays ambiguous and then parks', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    const key = reviewKey('brief-check', 0, HEAD12_A);
    await appendIntent(harness, key, null, NOW);
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'brief-check' });
  });

  it('the journal never carries a second intent under the same review key', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => {
      throw new Error('delegate-failed');
    });
    harness.setFindReceiptAnswer(async (request) => ({
      outcome: 'found',
      receipt: {
        receiptId: 'rcpt-1',
        requestId: request.requestId,
        kind: 'brief-check',
        reviewerModel: 'review-model-1',
        candidateHeadSha: COMMIT_A,
        verdict: 'passed',
        findings: [],
      },
    }));
    const key = reviewKey('brief-check', 0, HEAD12_A);
    await advance(harness);
    await advance(harness);
    await advance(harness);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === key);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
    expect(intents).toHaveLength(1);
    expect(results).toHaveLength(1);
  });
});

describe('AdvanceLaneRunUseCase review acts scope dispositions (KF-33b2)', () => {
  /** Wire the changed-path read and the out-of-scope recording into the harness fakes. */
  function wireScope(
    harness: Harness,
    changed: readonly string[] | null,
    recordAnswer: RecordOutOfScopeResult | 'throw',
  ): RecordOutOfScopeRequest[] {
    const calls: RecordOutOfScopeRequest[] = [];
    Object.assign(harness.deps, {
      artifactPort: {
        ...harness.deps.artifactPort,
        ...(changed === null ? {} : { readChangedPaths: async () => changed }),
      },
      reviewRequest: {
        ...harness.deps.reviewRequest,
        recordOutOfScope: async (request: RecordOutOfScopeRequest): Promise<RecordOutOfScopeResult> => {
          calls.push(request);
          if (recordAnswer === 'throw') {
            throw new Error('recording exploded');
          }
          return recordAnswer;
        },
      },
    });
    return calls;
  }

  const OUT_FINDINGS: readonly ReviewRequestFinding[] = [
    { findingId: 'rcpt-1:f-1', severity: 'blocker', summary: 'blocks another file', filePath: 'src/other-1.ts', line: 4 },
    { findingId: 'rcpt-1:f-2', severity: 'major', summary: 'blocks another file too', filePath: 'src/other-2.ts', line: 6 },
  ];

  it('an all-out-of-scope failed review records the dispositions and journals review-passed with the fixed detail', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', OUT_FINDINGS),
    }));
    const calls = wireScope(harness, ['src/a.ts'], { outcome: 'recorded' });
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'out-of-scope-findings',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      attemptId: 'attempt-example-1',
      candidateHeadSha: COMMIT_A,
      findingIds: ['rcpt-1:f-1', 'rcpt-1:f-2'],
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'review-passed', detail: 'out-of-scope-findings' });
    expect(JSON.stringify(entries)).not.toContain('blocks another file');
  });

  it('a mixed failed review records only the out-of-scope ids and stays review-failed', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', [
        { findingId: 'rcpt-1:f-1', severity: 'blocker', summary: 'this lane', filePath: 'src/a.ts', line: 4 },
        OUT_FINDINGS[1]!,
      ]),
    }));
    const calls = wireScope(harness, ['src/a.ts'], { outcome: 'recorded' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-failed',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.findingIds).toEqual(['rcpt-1:f-2']);
  });

  it('an unknown changed set records nothing and stays review-failed', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', OUT_FINDINGS),
    }));
    const calls = wireScope(harness, null, { outcome: 'recorded' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('a refused out-of-scope recording stays review-failed (fail closed)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', OUT_FINDINGS),
    }));
    const calls = wireScope(harness, ['src/a.ts'], { outcome: 'refused' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-failed',
    });
    expect(calls).toHaveLength(1);
  });

  it('a reconciled failed review is unchanged: no dispositions are recorded', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async () => ({ outcome: 'unknown', reason: 'delegate-failed' }));
    harness.setFindReceiptAnswer(async (request) => ({
      outcome: 'found',
      receipt: {
        receiptId: 'rcpt-1',
        requestId: request.requestId,
        kind: 'brief-check',
        reviewerModel: 'review-model-1',
        candidateHeadSha: COMMIT_A,
        verdict: 'failed',
        findings: OUT_FINDINGS,
      },
    }));
    const calls = wireScope(harness, ['src/a.ts'], { outcome: 'recorded' });
    const key = reviewKey('brief-check', 0, HEAD12_A);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'reconciled',
      reasonCode: 'review-failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('a throwing out-of-scope recording stays review-failed (fail closed)', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', OUT_FINDINGS),
    }));
    wireScope(harness, ['src/a.ts'], 'throw');
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-failed',
    });
  });

  it('a brief-check and code-review whose findings are all out-of-scope reach accepting and the run is accepted, never acceptance-rejected', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: receiptFor(request, 'failed', OUT_FINDINGS),
    }));
    const scopeCalls = wireScope(harness, ['src/a.ts'], { outcome: 'recorded' });

    // The brief-check fails with two findings, both out of scope → review-passed.
    const brief = await advance(harness);
    expect(brief).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'out-of-scope-findings',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });

    // The code-review fails with two findings, both out of scope → review-passed.
    const code = await advance(harness);
    expect(code).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'out-of-scope-findings',
    });
    expect(scopeCalls).toHaveLength(2);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'accepting' });

    // At accepting the receipts-only assessment sees no blocker for the fully
    // dispositioned fail (the rule under test): the run is accepted and never
    // parks acceptance-rejected. The fake assessment port mirrors the evidence
    // side's answer for an all-out-of-scope failed review.
    const receiptsRequests: AcceptanceAssessmentRequest[] = [];
    Object.assign(harness.deps, {
      acceptanceAssessment: {
        assessHeadAcceptance: async () => {
          throw new Error('assessHeadAcceptance is not used by the accept step');
        },
        assessHeadReceipts: async (request: AcceptanceAssessmentRequest) => {
          receiptsRequests.push(request);
          return { outcome: 'passed', receiptsId: 'rcp-kf-33b3', assessedHeadSha: COMMIT_A };
        },
      },
    });

    const accepted = await advance(harness);
    expect(accepted).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(receiptsRequests).toEqual([
      {
        attemptId: 'attempt-example-1',
        workOrderId: 'wo-example-1',
        candidateHeadSha: COMMIT_A,
        policyRevision: 'policy-example-1',
      },
    ]);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'opening-pr' });
  });
});

describe('review cause codes reach the run journal (RV2)', () => {
  /** The secret shapes the journal must never echo (the shared registry). */
  const SECRET_REGEXES: readonly RegExp[] = SECRET_PATTERNS;

  function unknownReceipt(
    request: RequestIndependentReviewRequest,
    unknownReason?: string,
  ): ReviewReceiptRecord {
    return {
      id: 'rcpt-' + request.requestId,
      assessmentId: 'asm-1',
      projectId: 'project-example-1',
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      reviewerModel: request.reviewerModel,
      implementerModel: request.implementerModel,
      readOnlyVerified: true,
      result: 'unknown',
      findings: [],
      evidenceRef: 'evidence-ref-1',
      policyRevision: 'policy-example-1',
      completedAtIso: NOW,
      kind: 'brief-check',
      requestId: request.requestId,
      ...(unknownReason !== undefined ? { unknownReason: unknownReason as ReviewUnknownReason } : {}),
    };
  }

  /** An adapter whose evidence delegate answers each request with the given result. */
  function adapterAnswering(
    answer: (request: RequestIndependentReviewRequest) => Promise<RequestIndependentReviewResult>,
  ): ReviewRequestAdapter {
    return new ReviewRequestAdapter({
      requestIndependentReview: (request) => answer(request),
    });
  }

  /** The secret-bearing prose a hostile reviewer answer or transport carries. */
  const HOSTILE_REASON =
    'The reviewer said: use token ghp_' + 'a'.repeat(36) + ' or sk-' + 'a'.repeat(24) +
    ', see /worktrees/wo-example-1/wt/diff.ts for details';

  async function lastResultEntry(harness: Harness) {
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.outcome !== null);
    return results[results.length - 1] ?? null;
  }

  for (const unknownReason of ['empty', 'unparseable-verdict', 'no-findings-on-fail']) {
    it(`journals an unknown receipt with unknownReason '${unknownReason}' as review-unknown detail`, async () => {
      const harness = await makeHarness(runRecord(), [collectedAttempt()]);
      await conduct(harness, 'brief-check', NOW);
      Object.assign(harness.deps, {
        reviewRequest: adapterAnswering(async (request) => ({
          outcome: 'reviewed',
          receipt: unknownReceipt(request, unknownReason),
        })),
      });
      const result = await advance(harness);
      expect(result).toEqual({
        outcome: 'acted',
        step: 'brief-check',
        key: reviewKey('brief-check', 0, HEAD12_A),
        result: 'completed',
        reasonCode: 'review-unknown',
        detail: unknownReason,
      });
      expect(await lastResultEntry(harness)).toMatchObject({
        outcome: 'completed',
        reasonCode: 'review-unknown',
        detail: unknownReason,
      });
    });
  }

  for (const code of ['timeout', 'transport'] as const) {
    it(`journals an unavailable review with code '${code}' as review-no-receipt detail`, async () => {
      const harness = await makeHarness(runRecord(), [collectedAttempt()]);
      await conduct(harness, 'brief-check', NOW);
      Object.assign(harness.deps, {
        reviewRequest: adapterAnswering(async () => ({
          outcome: 'rejected',
          reason: HOSTILE_REASON,
          rejection: 'review-unavailable' as const,
          code,
        })),
      });
      const result = await advance(harness);
      expect(result).toEqual({
        outcome: 'acted',
        step: 'brief-check',
        key: reviewKey('brief-check', 0, HEAD12_A),
        result: 'completed',
        reasonCode: 'review-no-receipt',
        detail: code,
      });
      expect(await lastResultEntry(harness)).toMatchObject({
        outcome: 'completed',
        reasonCode: 'review-no-receipt',
        detail: code,
      });
    });
  }

  it('robustness (3): reconcileReview after a mid-step crash recovers unknownReason into the journal once', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    // The first advance's delegate throws: the intent (with the minted request
    // id) is journalled, nothing is established.
    Object.assign(harness.deps, {
      reviewRequest: adapterAnswering(async () => {
        throw new Error('delegate-failed');
      }),
    });
    const key = reviewKey('brief-check', 0, HEAD12_A);
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });

    // The request id the intent minted before the crash.
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intent = entries.find((entry) => entry.mintedId !== null && entry.key === key);
    expect(intent).toBeDefined();
    const mintedRequestId = intent!.mintedId!;

    // After the crash the receipt (with its unknownReason) is found by request id.
    Object.assign(harness.deps, {
      reviewRequest: new ReviewRequestAdapter({
        inspectAcceptanceEvidence: async (request) => ({
          outcome: 'found',
          assessment: {
            id: request.assessmentId ?? 'asm-1',
            projectId: 'project-example-1',
            attemptId: 'attempt-example-1',
            candidateHeadSha: COMMIT_A,
            policyRevision: 'policy-example-1',
            implementerModel: 'model-example-1',
            requiredChecks: [],
            state: 'pending',
            verificationReceipts: [],
            reviewReceipts: [
              unknownReceipt(
                {
                  assessmentId: 'asm-1',
                  projectId: 'project-example-1',
                  attemptId: 'attempt-example-1',
                  candidateHeadSha: COMMIT_A,
                  policyRevision: 'policy-example-1',
                  implementerModel: 'model-example-1',
                  reviewerModel: 'review-model-1',
                  requestId: mintedRequestId,
                },
                'no-findings-on-fail',
              ),
            ],
            findingDispositions: [],
            acceptanceReceiptId: null,
            blockers: [],
            revision: 1,
            updatedAtIso: NOW,
          },
        }),
        requestIndependentReview: async () => {
          throw new Error('requestReview is never called by the reconcile');
        },
      }),
    });
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key,
      result: 'reconciled',
      reasonCode: 'review-unknown',
      detail: 'no-findings-on-fail',
    });
    // The journal records the recovered cause exactly once as the result entry.
    const allEntries = await harness.runJournal.listForRun(RUN_ID);
    const recovered = allEntries.filter(
      (entry) =>
        entry.outcome !== null &&
        entry.key === key &&
        entry.reasonCode === 'review-unknown' &&
        entry.detail === 'no-findings-on-fail',
    );
    expect(recovered).toHaveLength(1);
  });

  it('robustness (5): journal detail records fixed cause codes only and never echoes answer prose, paths, or secret-shaped strings', async () => {
    // A hostile unknownReason is dropped to a null detail, not echoed.
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    Object.assign(harness.deps, {
      reviewRequest: adapterAnswering(async (request) => ({
        outcome: 'reviewed',
        receipt: unknownReceipt(request, 'Answer: ghp_' + 'a'.repeat(36) + ' /worktrees/x'),
      })),
    });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    expect(await lastResultEntry(harness)).toMatchObject({
      outcome: 'completed',
      reasonCode: 'review-unknown',
      detail: null,
    });

    // An undeclared enum value is dropped too.
    const enumHarness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(enumHarness, 'brief-check', NOW);
    Object.assign(enumHarness.deps, {
      reviewRequest: adapterAnswering(async (request) => ({
        outcome: 'reviewed',
        receipt: unknownReceipt(request, 'unknown-enum'),
      })),
    });
    expect(await advance(enumHarness)).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    expect(await lastResultEntry(enumHarness)).toMatchObject({ detail: null });

    // Across every entry of every run journalled here, no detail ever holds a
    // secret shape, a path, or a non-journal token.
    for (const runHarness of [harness, enumHarness]) {
      const entries = await runHarness.runJournal.listForRun(RUN_ID);
      for (const entry of entries) {
        expect(entry.detail === null || LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(entry.detail)).toBe(true);
        const serialized = JSON.stringify(entry);
        for (const pattern of SECRET_REGEXES) {
          expect(pattern.test(serialized), entry.detail ?? 'null-detail').toBe(false);
        }
        expect(serialized).not.toContain('/worktrees/');
      }
    }
  });

  it('robustness (1): ReviewRequestAdapter refuses null, non-object, wrong-typed fields, sparse arrays, unknown unknownReason, and throwing getters without throwing', async () => {
    const adapter = adapterAnswering(async () => ({
      outcome: 'rejected' as const,
      reason: 'unused',
      rejection: 'review-unavailable' as const,
      code: 'transport-failed' as const,
    }));
    const hostile = Object.defineProperty({}, 'requestId', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const badRequests: unknown[] = [
      null,
      42,
      'x',
      [],
      hostile,
      { requestId: 123, kind: 'brief-check', attemptId: 'a', projectId: 'p', candidateHeadSha: COMMIT_A, policyRevision: 'pol', implementerModel: 'i', reviewerModel: 'r' },
      { requestId: 'ok-id', kind: 'brief-check', attemptId: 'a', projectId: 'p', candidateHeadSha: 'not-a-sha', policyRevision: 'pol', implementerModel: 'i', reviewerModel: 'r' },
    ];
    for (const bad of badRequests) {
      const refused = await adapter.requestReview(bad as never);
      expect(refused).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: null });
      const findRefused = await adapter.findReviewReceipt(bad as never);
      expect(findRefused).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    }

    // A sparse findingIds array is refused, never thrown.
    const sparseIds = ['finding-1'] as unknown as string[];
    delete (sparseIds as unknown as Record<string, unknown>)[0];
    await expect(
      adapter.recordOutOfScope!({
        attemptId: 'attempt-example-1',
        candidateHeadSha: COMMIT_A,
        findingIds: sparseIds,
      }),
    ).resolves.toEqual({ outcome: 'refused' });
    await expect(
      adapter.recordOutOfScope!(null as never),
    ).resolves.toEqual({ outcome: 'refused' });
  });

  it('RV2 fix (Luna 1): a findingIds array with a hole is refused before any disposition is recorded', async () => {
    const recorded: unknown[] = [];
    const adapter = new ReviewRequestAdapter({
      recordFindingDisposition: async (request) => {
        recorded.push(request);
        return { outcome: 'recorded' } as never;
      },
    });
    const holey = new Array(1) as unknown as string[];
    await expect(
      adapter.recordOutOfScope!({ attemptId: 'a', candidateHeadSha: COMMIT_A, findingIds: holey }),
    ).resolves.toEqual({ outcome: 'refused' });
    const mixed = ['finding-1', 'finding-2'] as unknown as string[];
    delete (mixed as unknown as Record<string, unknown>)[1];
    await expect(
      adapter.recordOutOfScope!({ attemptId: 'a', candidateHeadSha: COMMIT_A, findingIds: mixed }),
    ).resolves.toEqual({ outcome: 'refused' });
    await expect(
      adapter.recordOutOfScope!({ attemptId: 'a', candidateHeadSha: COMMIT_A, findingIds: [7 as never] }),
    ).resolves.toEqual({ outcome: 'refused' });
    expect(recorded).toEqual([]);
  });

  it('RV2 fix (Luna 2): a throwing optional field getter is invalid-request on the attempt and the chain path', async () => {
    let delegateCalls = 0;
    const adapter = adapterAnswering(async () => {
      delegateCalls += 1;
      return { outcome: 'rejected' as const, reason: 'unused', rejection: 'review-unavailable' as const, code: 'transport-failed' as const };
    });
    const throwing = (target: object, key: string): object =>
      Object.defineProperty(target, key, {
        get() {
          throw new Error('boom');
        },
        enumerable: true,
      });
    const attempt = {
      requestId: 'req-1', kind: 'brief-check', attemptId: 'a', projectId: 'p', candidateHeadSha: COMMIT_A,
      policyRevision: 'pol', implementerModel: 'i', reviewerModel: 'r',
    };
    const chain = {
      requestId: 'req-2', kind: 'pre-merge', attemptId: 'a', projectId: 'p', candidateHeadSha: COMMIT_A,
      policyRevision: 'pol', implementerModel: 'i', reviewerModel: 'r',
      subject: { kind: 'chain', projectId: 'p', chainName: 'rv2', integrationHeadSha: COMMIT_A },
    };
    for (const request of [
      throwing({ ...attempt }, 'briefText'),
      throwing({ ...attempt }, 'nowIso'),
      throwing({ ...chain }, 'diffSummary'),
      throwing({ ...chain }, 'nowIso'),
      throwing({ ...chain }, 'policyRevision'),
    ]) {
      await expect(adapter.requestReview(request as never)).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
        detail: null,
      });
    }
    expect(delegateCalls).toBe(0);
  });

  it('RV2 fix (Luna 4): a receipt whose findings are not plain objects is a receipt-mismatch', async () => {
    const adapter = adapterAnswering(async (request) => ({
      outcome: 'reviewed' as const,
      receipt: {
        ...unknownReceipt(request, undefined),
        result: 'fail' as const,
        findings: [new Date()] as never,
      },
    }));
    const result = await adapter.requestReview({
      requestId: 'req-3', kind: 'brief-check', attemptId: 'a', projectId: 'p', candidateHeadSha: COMMIT_A,
      policyRevision: 'pol', implementerModel: 'i', reviewerModel: 'r',
    } as never);
    expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
  });

  it('RV4: seat-busy is idempotent under the same key and opens the next free retry key', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    // The seat is busy for the first review, then frees: the retry succeeds.
    let reviewCalls = 0;
    harness.setReviewAnswer(async (request) => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return { outcome: 'no-receipt', reason: 'review-unavailable', detail: 'seat-busy' };
      }
      return { outcome: 'receipt', receipt: receiptFor(request, 'passed') };
    });

    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'seat-busy',
      detail: 'seat-busy',
    });

    // The base key has exactly one intent, never appended twice.
    let entries = await harness.runJournal.listForRun(RUN_ID);
    const baseIntents = entries.filter(
      (entry) => entry.kind === 'intent' && entry.key === reviewKey('brief-check', 0, HEAD12_A),
    );
    expect(baseIntents).toHaveLength(1);

    // The seat-busy result is not a second verdict: the next pass opens the
    // next free retry key instead of parking or reusing the same key.
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A, 1),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    entries = await harness.runJournal.listForRun(RUN_ID);
    const retryIntents = entries.filter(
      (entry) => entry.kind === 'intent' && entry.key === reviewKey('brief-check', 0, HEAD12_A, 1),
    );
    expect(retryIntents).toHaveLength(1);
  });

  it('RV4: unknown worktree status does not dispatch and does not abort', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);

    let inspectCalls = 0;
    let abortCalls = 0;
    const deps: AdvanceLaneRunDependencies = {
      ...harness.deps,
      runnerForAttempt: {
        runnerForAttempt: () => ({
          ok: true,
          runner: {
            inspectWorktreeRun: async () => {
              inspectCalls += 1;
              return { state: 'unknown', reason: 'status unreadable' };
            },
            abortWorktreeRun: async () => {
              abortCalls += 1;
              return { outcome: 'aborted', endedAtIso: LATER };
            },
          } as never,
        }),
      },
    };
    harness.setJournalBaseline((await harness.runJournal.listForRun(RUN_ID)).length);
    const useCase = new AdvanceLaneRunUseCase(deps);
    const result = await useCase.advanceLaneRun({
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    });

    expect(result).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
    expect(inspectCalls).toBe(1);
    expect(abortCalls).toBe(0);
    expect(harness.reviewRequests).toHaveLength(0);
    // Nothing was written: the journal holds only the conduct entry.
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toHaveLength(1);
  });

  it('RV4: a running session matching the collected attempt is aborted; a non-aborted abort waits review-pending', async () => {
    const collected = { ...collectedAttempt(), sessionId: 'session-match' };

    // Matching session, abort succeeds: the review proceeds on the free base key.
    const abortedHarness = await makeHarness(runRecord(), [collected]);
    await conduct(abortedHarness, 'brief-check', NOW);
    const abortedDeps: AdvanceLaneRunDependencies = {
      ...abortedHarness.deps,
      runnerForAttempt: {
        runnerForAttempt: () => ({
          ok: true,
          runner: {
            inspectWorktreeRun: async () => ({ state: 'running', sessionId: 'session-match' }),
            abortWorktreeRun: async () => ({ outcome: 'aborted', endedAtIso: LATER }),
          } as never,
        }),
      },
    };
    abortedHarness.setJournalBaseline((await abortedHarness.runJournal.listForRun(RUN_ID)).length);
    const abortedUseCase = new AdvanceLaneRunUseCase(abortedDeps);
    const aborted = await abortedUseCase.advanceLaneRun({
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    });
    expect(aborted).toMatchObject({ outcome: 'acted', step: 'brief-check', reasonCode: 'review-passed' });
    expect(abortedHarness.reviewRequests).toHaveLength(1);

    // Matching session but the abort stays running: review-pending, nothing written.
    const runningHarness = await makeHarness(runRecord(), [collected]);
    await conduct(runningHarness, 'brief-check', NOW);
    const runningDeps: AdvanceLaneRunDependencies = {
      ...runningHarness.deps,
      runnerForAttempt: {
        runnerForAttempt: () => ({
          ok: true,
          runner: {
            inspectWorktreeRun: async () => ({ state: 'running', sessionId: 'session-match' }),
            abortWorktreeRun: async () => ({ outcome: 'still-running', reason: 'still there' }),
          } as never,
        }),
      },
    };
    runningHarness.setJournalBaseline((await runningHarness.runJournal.listForRun(RUN_ID)).length);
    const runningUseCase = new AdvanceLaneRunUseCase(runningDeps);
    const running = await runningUseCase.advanceLaneRun({
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    });
    expect(running).toEqual({ outcome: 'waiting', reason: 'review-pending' });
    expect(runningHarness.reviewRequests).toHaveLength(0);
    expect(await runningHarness.runJournal.listForRun(RUN_ID)).toHaveLength(1);
  });
});
