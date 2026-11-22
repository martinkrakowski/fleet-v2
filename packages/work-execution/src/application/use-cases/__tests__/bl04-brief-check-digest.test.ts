/**
 * BL04: `performReview` binds the digest-verified frozen brief — the prose,
 * the raw manifest bytes and the attempt's recorded `briefDigest` — into the
 * brief-check request, and refuses `assessment-unavailable` when the
 * recorded digest is missing or blank. A verified brief that still fails the
 * adapter's digest or blank-prose checks journals the permanent `review-refused`
 * (the intended divergence: the frozen read applies no such checks). All
 * stores are in-memory; no runner, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
} from '../../../domain/lane-run-step-facts.js';
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
  ReviewRequest,
  ReviewRequestFinding,
  ReviewRequestResult,
  ReviewReceiptSummary,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type { OpenReviewAssessmentRequest, OpenReviewAssessmentResult } from '../../ports/out/ReviewAssessmentPort.out-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
const PROSE = '# brief\n';
const DEFAULT_MANIFEST_JSON = JSON.stringify({ acceptanceChecks: ['check-1'] });
const SHA = simpleDeterministicHexDigest(PROSE + '\n' + DEFAULT_MANIFEST_JSON);
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

const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

function collectedAttempt(briefDigest: string = SHA): AttemptRecord {
  const artifacts: CollectedAttemptArtifacts = {
    headCommit: COMMIT_A,
    commitsSinceBase: [COMMIT_A],
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
    briefDigest,
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

function reviewKey(step: 'brief-check' | 'code-review' | 'pre-merge', seatIndex: number, head12: string, retry: number | null = null): string {
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
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly reviewRequests: ReviewRequest[];
  readonly openRequests: OpenReviewAssessmentRequest[];
  readonly deps: AdvanceLaneRunDependencies;
  /** Serves `prose` and re-freezes the attempts' recorded digests to cover it. */
  setProseAndRefreeze(prose: string): Promise<void>;
  /** Serves changed prose on disk without re-freezing any attempt digest. */
  setChangedProseOnDisk(prose: string): void;
  setReviewAnswer(answer: (request: ReviewRequest) => Promise<ReviewRequestResult>): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const reviewRequests: ReviewRequest[] = [];
  const openRequests: OpenReviewAssessmentRequest[] = [];
  const manifestJson: string | null = DEFAULT_MANIFEST_JSON;
  let prose = PROSE;
  let reviewAnswer: (request: ReviewRequest) => Promise<ReviewRequestResult> = async (request) => ({
    outcome: 'receipt',
    receipt: receiptFor(request, 'passed'),
  });
  const findReceiptAnswer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult> = async () => ({
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
    newUlid: makeUlidMinter(),
    sameModelFamily: (left: string, right: string) => left === right,
    reviewRequest: {
      requestReview: async (request) => {
        reviewRequests.push(request);
        return reviewAnswer(request);
      },
      findReviewReceipt: async (request) => findReceiptAnswer(request),
      findLatestReceiptOfKind: async () => ({ outcome: 'not-found' }),
    },
    reviewAssessment: {
      openReviewAssessment: async (request) => {
        openRequests.push(request);
        return { outcome: 'open' } satisfies OpenReviewAssessmentResult;
      },
    },
    workOrderRepo: {
      findWorkOrderById: async () => WORK_ORDER,
    },
  };

  return {
    attemptRepo,
    runJournal,
    reviewRequests,
    openRequests,
    deps,
    setProseAndRefreeze: async (nextProse) => {
      prose = nextProse;
      const digest = simpleDeterministicHexDigest(nextProse + '\n' + manifestJson);
      for (const attempt of await attemptRepo.listAllAttempts()) {
        if (attempt.briefDigest !== digest) {
          await attemptRepo.saveAttempt({
            ...attempt,
            revision: (attempt.revision ?? 0) + 1,
            briefDigest: digest,
          });
        }
      }
    },
    setChangedProseOnDisk: (changed) => {
      prose = changed;
    },
    setReviewAnswer: (answer) => {
      reviewAnswer = answer;
    },
  };
}

async function advance(harness: Harness) {
  const useCase = new AdvanceLaneRunUseCase(harness.deps);
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
  });
}

async function conduct(harness: Harness, state: LaneRunStateValue, nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

describe('AdvanceLaneRunUseCase brief-check digest binding (BL04)', () => {
  it('a brief-check request carries the prose, the raw manifest bytes and the recorded digest', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
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
      briefManifestRaw: DEFAULT_MANIFEST_JSON,
      briefPackageDigest: SHA,
      nowIso: LATER,
    });
  });

  it('a code-review request carries no brief fields', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'code-review', NOW);
    await advance(harness);
    expect(harness.reviewRequests).toHaveLength(1);
    const request = harness.reviewRequests[0]!;
    expect(request.kind).toBe('code-review');
    expect('briefText' in request).toBe(false);
    expect('briefManifestRaw' in request).toBe(false);
    expect('briefPackageDigest' in request).toBe(false);
  });

  it('performReview refuses assessment-unavailable when readFrozenBriefVerified is unverified', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    // The served prose changes without any digest re-freeze: the verified read fails.
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

  it('performReview refuses assessment-unavailable when the recorded digest is missing or blank', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt('')]);
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

  it('performReview journals permanent review-refused when a verified brief fails adapter digest or blank-prose checks', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'brief-check', NOW);
    // A blank prose still verifies against its own frozen digest (the frozen
    // read applies no blank-prose check — the intended divergence), but the
    // adapter refuses it before any reviewer runs.
    await harness.setProseAndRefreeze('   ');
    harness.setReviewAnswer(async () => ({ outcome: 'refused', reason: 'invalid-request', detail: null }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 0, HEAD12_A),
      result: 'refused',
      reasonCode: 'review-refused',
    });
    expect(harness.openRequests).toHaveLength(1);
    expect(harness.reviewRequests).toHaveLength(1);
    const entry = (await harness.runJournal.listForRun(RUN_ID)).find(
      (candidate) => candidate.kind === 'result' && candidate.key === reviewKey('brief-check', 0, HEAD12_A),
    );
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error('fixture must find the result entry');
    }
    expect(entry.outcome).toBe('refused');
    expect(entry.reasonCode).toBe('review-refused');
  });
});
