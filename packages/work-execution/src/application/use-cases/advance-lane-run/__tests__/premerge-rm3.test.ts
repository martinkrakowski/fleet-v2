/**
 * RM3: a Tier 2 run never publishes a `premerge` success while parked
 * `owner-merge` or without the exact-head owner pre-merge receipt
 * (`requestId === null`, read via `findLatestReceiptOfKind`). The Tier 2
 * `released` hold publishes `success` only when the run is not parked
 * `owner-merge`, the automated pre-merge review either did not run or passed
 * (correction 8: `preMergeReview.verdict` `none` or `passed`), and the owner
 * receipt's `candidateHeadSha` equals the candidate head and its head equals
 * the PR's current head. Tier 1 is unchanged. Every untrusted input is
 * validated in `O(1)` through property descriptors without invoking getters:
 * unknown or malformed input never posts `success`. Every store is in-memory;
 * no forge, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../../domain/execution-records.js';
import { LaneRun } from '../../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../../domain/lane-run-records.js';
import { buildLaneRunStepKey, laneRunPremergeKey } from '../../../../domain/lane-run-keys.js';
import { decideConductorReviewOutcome } from '../../../../domain/lane-run-decider.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../../domain/lane-run-step-facts.js';
import type { AdvanceLaneRunDependencies } from '../../AdvanceLaneRunUseCase.use-case.js';
import { AdvanceLaneRunUseCase } from '../../AdvanceLaneRunUseCase.use-case.js';
import type { AcceptanceReceiptsResult } from '../../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type {
  ConductorForgeGrantRequest,
  ConductorForgeGrantResult,
} from '../../../ports/out/ConductorForgeGrantPort.out-port.js';
import type {
  ExecuteAuthorizedForgeActionRequest,
  ExecuteAuthorizedForgeActionResult,
} from '../../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { FindLatestReceiptOfKindResult, ReviewRequestFinding } from '../../../ports/out/ReviewRequestPort.out-port.js';
import type { PremergeMode } from '../../../../domain/lane-run-transitions.js';
import { LaneRunRepositoryAdapter } from '../../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-11-25T10:00:00.000Z';
const LATER = '2026-11-25T10:00:01.000Z';
const LEASE_UNTIL = '2026-11-25T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const HEAD12 = 'a'.repeat(12);
const OTHER_COMMIT = 'b'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const PROJECT_ID = 'project-example';
const WORK_ORDER_ID = 'wo-example-1';
const DECISION_REVISION = 'policy:conductor@0123456789ab';
const RECEIPT_ID = 'rcp-example-1';
const BRANCH = 'fleet/run-01JB0000000000000000000000';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: WORK_ORDER_ID,
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
  branchName: BRANCH,
};

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [],
};

const SEAT_SELECTION = {
  role: 'first-pass' as const,
  seatIndex: 0,
  seatId: 'fp-1',
  model: 'model-example-1',
  tool: 'opencode',
  variant: null,
  agent: null,
};

const COLLECTED_ARTIFACTS: CollectedAttemptArtifacts = {
  headCommit: COMMIT,
  commitsSinceBase: [COMMIT],
  collectedArtifactPaths: [],
  notes: 'present',
};

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: PROJECT_ID,
    taskId: 'task-example-1',
    laneId: 'lane-example',
    repository: 'repo-example',
    baseCommit: COMMIT,
    ownedPaths: ['src/example.ts'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'ready-to-merge',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
    ...overrides,
  };
}

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: COLLECTED_ARTIFACTS,
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: 'lane-alias-example',
      hostName: 'lane-host-example',
      agent: null,
      model: null,
      variant: null,
    },
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
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

function premergeKey(head12: string = HEAD12): string {
  const built = laneRunPremergeKey(RUN_ID, 0, head12);
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a premerge key');
  }
  return built.key;
}

function acceptKey(): string {
  return `${RUN_ID}/r0/accept/0@${HEAD12}`;
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly grantRequests: readonly ConductorForgeGrantRequest[];
  readonly forgeRequests: readonly ExecuteAuthorizedForgeActionRequest[];
  readonly receiptRequests: readonly { attemptId: string; candidateHeadSha: string; kind: string }[];
  readonly deps: AdvanceLaneRunDependencies;
  setReceiptAnswer(answer: FindLatestReceiptOfKindResult | 'throw'): void;
  setForgeAnswer(answer: ExecuteAuthorizedForgeActionResult | 'throw'): void;
  setGrantAnswer(answer: ConductorForgeGrantResult | 'throw'): void;
  setReceiptsAnswer(answer: AcceptanceReceiptsResult | 'throw'): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
  options: { readonly premergeMode?: unknown; readonly prHeadSha?: string } = {},
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const grantRequests: ConductorForgeGrantRequest[] = [];
  const forgeRequests: ExecuteAuthorizedForgeActionRequest[] = [];
  const receiptRequests: { attemptId: string; candidateHeadSha: string; kind: string }[] = [];
  let receiptAnswer: FindLatestReceiptOfKindResult | 'throw' = { outcome: 'not-found' };
  let forgeAnswer: ExecuteAuthorizedForgeActionResult | 'throw' = {
    outcome: 'executed',
    headSha: COMMIT,
  };
  let grantAnswer: ConductorForgeGrantResult | 'throw' = {
    outcome: 'issued',
    grantId: 'grant-conductor-example-1',
    decisionRevision: DECISION_REVISION,
  };
  let receiptsAnswer: AcceptanceReceiptsResult | 'throw' = {
    outcome: 'passed',
    receiptsId: RECEIPT_ID,
    assessedHeadSha: COMMIT,
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
      readBriefManifest: async () => JSON.stringify({}),
      readBriefFile: async () => '# brief\n',
      verifyArtifactManifest: async () => ({ outcome: 'missing' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({
        outcome: 'active',
        attempt: attempts[attempts.length - 1] ?? attemptFixture(),
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
    acceptanceAssessment: {
      assessHeadAcceptance: async () => ({ outcome: 'accepted', receiptId: RECEIPT_ID, assessedHeadSha: COMMIT }),
      assessHeadReceipts: async (_request) => {
        if (
          receiptAnswer !== 'throw' &&
          receiptAnswer.outcome === 'found' &&
          receiptAnswer.receipt.kind === 'pre-merge' &&
          // RV3: only a receipt with a blocking finding blocks the receipts
          // assessment; a minor-only failed receipt passes (like the evidence
          // decider does).
          decideConductorReviewOutcome(receiptAnswer.receipt).outcome === 'failed'
        ) {
          return { outcome: 'rejected', reason: 'review-blocker' };
        }
        if (receiptsAnswer === 'throw') {
          throw new Error('receipts assessment unavailable');
        }
        return receiptsAnswer;
      },
    },
    conductorForgeGrant: {
      issueConductorForgeGrant: async (request) => {
        grantRequests.push(request);
        if (grantAnswer === 'throw') {
          throw new Error('grant unavailable');
        }
        return grantAnswer;
      },
    },
    executeForgeAction: {
      executeAuthorizedForgeAction: async (request) => {
        forgeRequests.push(request);
        if (forgeAnswer === 'throw') {
          throw new Error('forge unavailable');
        }
        return forgeAnswer;
      },
    },
    workOrderRepo: {
      findWorkOrderById: async (workOrderId) => makeWorkOrder({ id: workOrderId }),
    },
    reviewRequest: {
      requestReview: async () => ({ outcome: 'unknown', reason: 'delegate-failed' }),
      findReviewReceipt: async () => ({ outcome: 'not-found' }),
      findLatestReceiptOfKind: async (request) => {
        receiptRequests.push({
          attemptId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
          kind: request.kind,
        });
        if (receiptAnswer === 'throw') {
          throw new Error('receipt unavailable');
        }
        return receiptAnswer;
      },
    },
    forgeRead: {
      readPullRequest: async () => ({
        outcome: 'found',
        pullRequest: {
          number: 7,
          state: 'open',
          mergeState: 'clean',
          headSha: options.prHeadSha ?? COMMIT,
          headRef: BRANCH,
          isCrossRepository: false,
          headRepositoryOwner: 'owner-example',
          baseRef: 'main',
          mergedAtIso: null,
          closedAtIso: null,
          mergeCommitSha: null,
        },
      }),
      isConfigured: () => true,
      listOpenPullRequestsByBase: async () => ({ outcome: 'unavailable' as const, reason: 'not-used' }),
    },
    ciState: {
      readHeadCiState: async (request) => ({ headSha: request.headSha, state: 'passed', reason: 'read' }),
    },
    enqueueMerge: {
      enqueue: async () => ({ outcome: 'refused', reason: 'invalid-head' }),
    },
    mergeQueue: { listMergeEntries: async () => [] },
    forgeRepository: { owner: 'owner-example', repo: 'repo-example' },
    ...(options.premergeMode !== undefined
      ? { premergeMode: options.premergeMode as PremergeMode }
      : {}),
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    grantRequests,
    forgeRequests,
    receiptRequests,
    deps,
    setReceiptAnswer: (answer) => {
      receiptAnswer = answer;
    },
    setForgeAnswer: (answer) => {
      forgeAnswer = answer;
    },
    setGrantAnswer: (answer) => {
      grantAnswer = answer;
    },
    setReceiptsAnswer: (answer) => {
      receiptsAnswer = answer;
    },
  };
}

function advance(harness: Harness, overrides: Record<string, unknown> = {}) {
  const useCase = new AdvanceLaneRunUseCase(harness.deps);
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...overrides,
  });
}

async function conduct(harness: Harness, state: Parameters<typeof laneRunConductEntry>[2], nowIso: string): Promise<void> {
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
  outcome: Parameters<typeof laneRunResultEntry>[3],
  reasonCode: Parameters<typeof laneRunResultEntry>[4],
  recordedAtIso: string,
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

/** A `merging` run accepted at the collected head, PR open at the head. */
async function mergingHarness(
  options: { readonly premergeMode?: unknown; readonly prHeadSha?: string } = {},
  record: LaneRunRecord = runRecord(),
): Promise<Harness> {
  const harness = await makeHarness(record, [attemptFixture()], options);
  await conduct(harness, 'merging', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  return harness;
}

function finding(index: number, severity: ReviewRequestFinding['severity']): ReviewRequestFinding {
  return { findingId: `f-${index}`, severity, summary: 'untrusted reviewer prose', filePath: null, line: null };
}

/** The owner receipt object: `requestId === null` at the exact head (manual receipts carry no request id). */
function ownerReceiptObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptId: RECEIPT_ID,
    requestId: null,
    kind: 'pre-merge',
    reviewerModel: 'owner',
    candidateHeadSha: COMMIT,
    verdict: 'passed',
    findings: [],
    ...overrides,
  };
}

/** An owner receipt: `requestId === null` at the exact head (manual receipts carry no request id). */
function ownerReceipt(overrides: Record<string, unknown> = {}): FindLatestReceiptOfKindResult {
  return { outcome: 'found', receipt: ownerReceiptObject(overrides) as never };
}

/** An automated receipt: the review request's own id, never null. */
function automatedReceipt(overrides: Record<string, unknown> = {}): FindLatestReceiptOfKindResult {
  return ownerReceipt({ requestId: 'review-example-1', reviewerModel: 'reviewer-example-1', ...overrides });
}

function reviewRequestKey(seatIndex: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID, round: 0, step: 'pre-merge', seatIndex, attemptOrdinal: null, head12: HEAD12, retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a review key');
  }
  return built.key;
}

/** Journals a passed automated pre-merge review request, so `preMergeReview.verdict` is `passed`. */
async function journalPassedPreMergeReview(harness: Harness): Promise<void> {
  const key = reviewRequestKey(0);
  await appendIntent(harness, key, 'review-example-1', NOW);
  await appendResult(harness, key, 'completed', 'review-passed', NOW);
}

const successStatuses = (harness: Harness): (string | undefined)[] =>
  harness.forgeRequests.map((request) => request.status?.state).filter((state) => state === 'success');

describe('premerge RM3: Tier 2 never publishes success without the exact-head owner receipt', () => {
  it('publishes success when the automated review passed and the owner receipt matches the current PR head', async () => {
    const harness = await mergingHarness({ premergeMode: 'auto-attest' });
    await journalPassedPreMergeReview(harness);
    harness.setReceiptAnswer(ownerReceipt());
    const posted = await advance(harness);
    expect(posted).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    expect(successStatuses(harness)).toHaveLength(1);
    expect(harness.forgeRequests[0]!.status).toEqual({
      context: 'premerge',
      state: 'success',
      description: 'pre-merge receipt recorded',
    });
  });

  it('publishes success when the owner receipt lands first and the automated review never ran', async () => {
    const harness = await mergingHarness({ premergeMode: 'auto-attest' });
    harness.setReceiptAnswer(ownerReceipt());
    const posted = await advance(harness);
    expect(posted).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    expect(harness.receiptRequests).toHaveLength(2);
    expect(successStatuses(harness)).toHaveLength(1);
  });

  it('keeps Tier 2 pending when the automated review passed without an owner receipt, even under auto-attest', async () => {
    const harness = await mergingHarness({ premergeMode: 'auto-attest' });
    await journalPassedPreMergeReview(harness);
    harness.setReceiptAnswer(automatedReceipt());
    const posted = await advance(harness);
    expect(posted).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(successStatuses(harness)).toHaveLength(0);
    expect(harness.forgeRequests[0]!.status).toEqual({
      context: 'premerge',
      state: 'pending',
      description: 'waiting for the pre-merge review',
    });
    // The reconcile under the same pending intent never posts success either.
    const reconciled = await advance(harness);
    expect(reconciled).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(successStatuses(harness)).toHaveLength(0);
  });

  it('keeps Tier 2 pending when the owner receipt is for an older head or the PR head differs', async () => {
    const olderHead = await mergingHarness({ premergeMode: 'auto-attest' });
    olderHead.setReceiptAnswer(ownerReceipt({ candidateHeadSha: OTHER_COMMIT }));
    const olderResult = await advance(olderHead);
    expect(olderResult).not.toMatchObject({ reasonCode: 'premerge-success' });
    expect(successStatuses(olderHead)).toHaveLength(0);

    const prMoved = await mergingHarness({ premergeMode: 'auto-attest', prHeadSha: OTHER_COMMIT });
    prMoved.setReceiptAnswer(ownerReceipt());
    const movedResult = await advance(prMoved);
    expect(movedResult).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(successStatuses(prMoved)).toHaveLength(0);
  });

  it('keeps Tier 2 pending while parked owner-merge, never posting success', async () => {
    const harness = await makeHarness(
      runRecord({
        parked: { reason: 'owner-merge', qualifier: null, parkedFrom: 'merging', questionId: null },
        parkCount: 1,
      }),
      [attemptFixture()],
    );
    await conduct(harness, 'parked', NOW);
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
    await appendIntent(harness, premergeKey(), 'forge-example-1', NOW);
    harness.setReceiptAnswer(ownerReceipt());
    const reconciled = await advance(harness);
    expect(reconciled).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(harness.forgeRequests).toHaveLength(0);
    expect(successStatuses(harness)).toHaveLength(0);
  });

  it('publishes Tier 1 success without any pre-merge receipt', async () => {
    const tier1 = await makeHarness(
      runRecord({ tier: 1 }),
      [attemptFixture()],
      { premergeMode: 'auto-attest' },
    );
    await conduct(tier1, 'merging', NOW);
    await appendIntent(tier1, acceptKey(), null, NOW);
    await appendResult(tier1, acceptKey(), 'completed', 'accepted', NOW);
    const posted = await advance(tier1);
    expect(posted).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    expect(successStatuses(tier1)).toHaveLength(1);
  });

  it('refuses a throwing reviewRequest port: the act parks ambiguous pre-merge and the reconcile appends ambiguous review-unknown, without calling forge', async () => {
    // The act path: the port throws during the facts read, so the pre-merge
    // fact is `unknown` and the decider parks `ambiguous pre-merge` before
    // any grant or forge call.
    const actHarness = await mergingHarness({ premergeMode: 'auto-attest' });
    actHarness.setReceiptAnswer('throw');
    const parked = await advance(actHarness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'pre-merge' });
    expect(actHarness.receiptRequests).toHaveLength(1);
    expect(actHarness.forgeRequests).toHaveLength(0);
    expect(actHarness.grantRequests).toHaveLength(0);

    // The reconcile path: an unread premerge intent under the same throwing
    // port reconciles and appends `ambiguous` / `review-unknown`, never a
    // forge call.
    const reconcileHarness = await makeHarness(runRecord(), [attemptFixture()]);
    await conduct(reconcileHarness, 'merging', NOW);
    await appendIntent(reconcileHarness, acceptKey(), null, NOW);
    await appendResult(reconcileHarness, acceptKey(), 'completed', 'accepted', NOW);
    await appendIntent(reconcileHarness, premergeKey(), 'forge-example-1', NOW);
    reconcileHarness.setReceiptAnswer('throw');
    const reconciled = await advance(reconcileHarness);
    expect(reconciled).toMatchObject({ result: 'ambiguous', reasonCode: 'review-unknown' });
    expect(reconcileHarness.forgeRequests).toHaveLength(0);
    expect(successStatuses(reconcileHarness)).toHaveLength(0);
  });

  it('refuses a missing acceptanceAssessment port with grant-refused', async () => {
    const harness = await mergingHarness({ premergeMode: 'auto-attest' });
    harness.setReceiptAnswer(ownerReceipt());
    const unwired = { ...harness.deps, acceptanceAssessment: undefined } as AdvanceLaneRunDependencies;
    const posted = await new AdvanceLaneRunUseCase(unwired).advanceLaneRun({
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    });
    expect(posted).toMatchObject({ result: 'refused', reasonCode: 'grant-refused' });
    expect(harness.forgeRequests).toHaveLength(0);
  });

  it('maps a grant refusal and a forge throw to grant-refused and forge-ambiguous', async () => {
    const grantRefused = await mergingHarness({ premergeMode: 'auto-attest' });
    grantRefused.setReceiptAnswer(ownerReceipt());
    grantRefused.setGrantAnswer({ outcome: 'refused', reason: 'policy-revision-mismatch' });
    const refused = await advance(grantRefused);
    expect(refused).toMatchObject({ result: 'refused', reasonCode: 'grant-refused' });
    expect(successStatuses(grantRefused)).toHaveLength(0);

    const forgeThrow = await mergingHarness({ premergeMode: 'auto-attest' });
    forgeThrow.setReceiptAnswer(ownerReceipt());
    forgeThrow.setForgeAnswer('throw');
    const ambiguous = await advance(forgeThrow);
    expect(ambiguous).toMatchObject({ result: 'ambiguous', reasonCode: 'forge-ambiguous' });
    // The forge call was attempted once and failed: no success was ever
    // posted, and the journal carries the ambiguous result under the key.
    expect(forgeThrow.forgeRequests).toHaveLength(1);
    const entries = await forgeThrow.runJournal.listForRun(RUN_ID);
    expect(
      entries.filter((entry) => entry.kind === 'result' && entry.key === premergeKey() && entry.reasonCode === 'forge-ambiguous'),
    ).toHaveLength(1);
  });

  it('refuses null, undefined, primitive, array-like, sparse findings, throwing getter, and __proto__ receipts without throwing or posting success', async () => {
    const hostile: Array<{ readonly name: string; readonly answer: FindLatestReceiptOfKindResult }> = [
      { name: 'null receipt', answer: { outcome: 'found', receipt: null as never } },
      { name: 'array receipt', answer: { outcome: 'found', receipt: [] as never } },
      { name: 'primitive receipt', answer: { outcome: 'found', receipt: 7 as never } },
      {
        name: 'getter-backed verdict',
        answer: {
          outcome: 'found',
          receipt: Object.defineProperty({ ...ownerReceiptObject() }, 'verdict', {
            get() {
              return 'passed';
            },
            enumerable: true,
          }) as never,
        },
      },
      {
        name: 'index 0 getter finding',
        answer: ownerReceipt({
          findings: Object.defineProperty([], 0, {
            get() {
              return finding(0, 'minor');
            },
            enumerable: true,
          }) as never,
        }),
      },
      {
        name: 'sparse findings',
        answer: ownerReceipt({ findings: Object.assign([finding(0, 'minor')], { 1: undefined }) as never }),
      },
      {
        name: '__proto__ receipt',
        answer: { outcome: 'found', receipt: JSON.parse('{"__proto__": {"verdict": "passed"}, "verdict": "passed"}') as never },
      },
      {
        name: 'throwing prototype getter',
        answer: {
          outcome: 'found',
          receipt: Object.create(
            Object.defineProperty({}, 'verdict', {
              get() {
                throw new Error('hostile getter');
              },
              enumerable: true,
            }),
          ) as never,
        },
      },
    ];
    for (const { name, answer } of hostile) {
      const harness = await mergingHarness({ premergeMode: 'auto-attest' });
      harness.setReceiptAnswer(answer);
      const posted = await advance(harness);
      expect(posted, name).not.toMatchObject({ reasonCode: 'premerge-success' });
      expect(successStatuses(harness), name).toHaveLength(0);
    }
  });

  it('keeps Tier 2 pending when the automated review verdict is neither none nor passed', async () => {
    const harness = await mergingHarness({ premergeMode: 'auto-attest' });
    const key = reviewRequestKey(0);
    await appendIntent(harness, key, 'review-example-1', NOW);
    await appendResult(harness, key, 'completed', 'review-unknown', NOW);
    harness.setReceiptAnswer(ownerReceipt());
    const posted = await advance(harness);
    expect(posted).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(successStatuses(harness)).toHaveLength(0);
  });
});
