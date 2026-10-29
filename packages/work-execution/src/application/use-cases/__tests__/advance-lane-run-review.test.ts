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
import type { SameModelFamily } from '../../../domain/seat-selection.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type {
  ReviewRequest,
  ReviewReceiptSummary,
  ReviewRequestFinding,
  ReviewRequestResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type { OpenReviewAssessmentRequest, OpenReviewAssessmentResult } from '../../ports/out/ReviewAssessmentPort.out-port.js';
import { reviewFactsOf } from '../advance-lane-run/review-fix.js';
import type { AdvanceStepContext } from '../advance-lane-run/step-context.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
const HEAD12_B = 'b'.repeat(12);
const SHA = 'c'.repeat(64);
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
  setManifest(json: string | null): void;
  setBriefText(text: string | null): void;
  setReviewAnswer(answer: (request: ReviewRequest) => Promise<ReviewRequestResult>): void;
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
  let manifestJson: string | null = JSON.stringify({ acceptanceChecks: ['check-1'] });
  let briefText: string | null = null;
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
      readBriefFile: async () => briefText,
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
            findReviewReceipt: async () => ({ outcome: 'not-found' }),
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
    setManifest: (json) => {
      manifestJson = json;
    },
    setBriefText: (text) => {
      briefText = text;
    },
    setReviewAnswer: (answer) => {
      reviewAnswer = answer;
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
    harness.setReviewAnswer(async () => ({ outcome: 'no-receipt', reason: 'review-unavailable' }));
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
    const fourth = await advance(harness);
    expect(fourth).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 1, HEAD12_A, 1),
      result: 'completed',
      reasonCode: 'review-no-receipt',
    });
    const fifth = await advance(harness);
    expect(fifth).toEqual({ outcome: 'parked', reason: 'review-seat-unavailable', qualifier: null });
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
    harness.setManifest(JSON.stringify({ acceptanceChecks: ['check-a', 'check-b'] }));
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
    hEmpty.setManifest(JSON.stringify({ acceptanceChecks: [] }));
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

  it('forwards briefText only for brief-check from readBriefFile', async () => {
    const hBrief = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(hBrief, 'brief-check', NOW);
    hBrief.setBriefText('the frozen brief prose');
    await advance(hBrief);
    expect(hBrief.reviewRequests[0]!.briefText).toBe('the frozen brief prose');

    const hCode = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(hCode, 'code-review', NOW);
    hCode.setBriefText('the frozen brief prose');
    await advance(hCode);
    expect(hCode.reviewRequests).toHaveLength(1);
    expect(hCode.reviewRequests[0]!.kind).toBe('code-review');
    expect(hCode.reviewRequests[0]!.briefText).toBeUndefined();
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
