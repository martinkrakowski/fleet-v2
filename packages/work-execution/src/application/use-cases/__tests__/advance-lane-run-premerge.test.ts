/**
 * Unit tests for KS7a-2: the conductor's `act premerge` and its reconcile
 * (speed plan §3.3.1, §3.6.2; D20). One run-journal key per head
 * `<runId>/r<round>/premerge@<head12>`; the `premerge` commit status is the
 * merge hold, posted on the exact head by the conductor's forge identity. A
 * pending hold posts once under one intent and one conductor grant with no
 * result; a released or fail hold posts the terminal status and one final
 * result; a moved head, a halted run, an over-999 finding count or a receipt
 * that disagrees with the hold posts nothing. Every store is in-memory; no
 * forge, no subprocess, no network (the harness calls no forge binary).
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunPremergeKey } from '../../../domain/lane-run-keys.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { AcceptanceReceiptsResult } from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type {
  ConductorForgeGrantRequest,
  ConductorForgeGrantResult,
} from '../../ports/out/ConductorForgeGrantPort.out-port.js';
import type {
  ExecuteAuthorizedForgeActionRequest,
  ExecuteAuthorizedForgeActionResult,
} from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { FindLatestReceiptOfKindResult, ReviewRequestFinding } from '../../ports/out/ReviewRequestPort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const HEAD12 = 'a'.repeat(12);
const OTHER_HEAD12 = 'b'.repeat(12);
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
  readonly autoMergeCalls: { readonly count: number };
  readonly deps: AdvanceLaneRunDependencies;
  setReceiptAnswer(answer: FindLatestReceiptOfKindResult | 'throw'): void;
  setForgeAnswer(answer: ExecuteAuthorizedForgeActionResult | 'throw'): void;
  setGrantAnswer(answer: ConductorForgeGrantResult | 'throw'): void;
  setReceiptsAnswer(answer: AcceptanceReceiptsResult | 'throw'): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const grantRequests: ConductorForgeGrantRequest[] = [];
  const forgeRequests: ExecuteAuthorizedForgeActionRequest[] = [];
  const receiptRequests: { attemptId: string; candidateHeadSha: string; kind: string }[] = [];
  const autoMergeCalls = { count: 0 };
  let receiptAnswer: FindLatestReceiptOfKindResult | 'throw' = {
    outcome: 'not-found',
  };
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
          receiptAnswer.receipt.verdict === 'failed'
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
          headSha: COMMIT,
          headRef: BRANCH,
          baseRef: 'main',
          mergedAtIso: null,
          closedAtIso: null,
          mergeCommitSha: null,
        },
      }),
      isConfigured: () => true,
    },
    ciState: {
      readHeadCiState: async (request) => ({ headSha: request.headSha, state: 'passed', reason: 'read' }),
    },
    autoMergeAttempt: {
      autoMergeAttempt: async (request) => {
        autoMergeCalls.count += 1;
        return {
          outcome: 'merged',
          attemptId: request.attemptId,
          headSha: COMMIT,
          pullRequestNumber: 7,
          decisionRevision: 'policy:autoMerge@example',
        };
      },
    },
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    grantRequests,
    forgeRequests,
    receiptRequests,
    autoMergeCalls,
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

/** A collected attempt in `merging`, accepted at the collected head, PR open at the head. */
async function mergingHarness(record: LaneRunRecord = runRecord()): Promise<Harness> {
  const harness = await makeHarness(record, [attemptFixture()]);
  await conduct(harness, 'merging', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  return harness;
}

function finding(summary: string, index: number): ReviewRequestFinding {
  return { findingId: `finding-${index}`, severity: 'major', summary, filePath: null, line: null };
}

function passedReceipt(findings: ReviewRequestFinding[] = []): FindLatestReceiptOfKindResult {
  return {
    outcome: 'found',
    receipt: {
      receiptId: 'pm-example-1',
      requestId: null,
      kind: 'pre-merge',
      reviewerModel: 'reviewer-example-1',
      candidateHeadSha: COMMIT,
      verdict: 'passed',
      findings,
    },
  };
}

function failedReceipt(findings: ReviewRequestFinding[]): FindLatestReceiptOfKindResult {
  return {
    outcome: 'found',
    receipt: {
      receiptId: 'pm-example-2',
      requestId: null,
      kind: 'pre-merge',
      reviewerModel: 'reviewer-example-1',
      candidateHeadSha: COMMIT,
      verdict: 'failed',
      findings,
    },
  };
}

describe('AdvanceLaneRunUseCase premerge act (KS7a-2)', () => {
  it('test 1: a pending hold posts pending once under one intent and one grant with no result; a second advance posts nothing', async () => {
    const harness = await mergingHarness();
    const first = await advance(harness);
    // The pending post returns waiting: the run still waits on the review.
    expect(first).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(harness.forgeRequests).toHaveLength(1);
    const forge = harness.forgeRequests[0]!;
    expect(forge).toMatchObject({
      attemptId: 'attempt-example-1',
      workOrderId: WORK_ORDER_ID,
      kind: 'post-status',
      expectedHeadSha: COMMIT,
      authorizationGrantId: 'grant-conductor-example-1',
      authorizedBy: DECISION_REVISION,
      branchName: BRANCH,
      status: { context: 'premerge', state: 'pending', description: 'waiting for the pre-merge review' },
    });
    expect(harness.grantRequests).toEqual([
      {
        projectId: PROJECT_ID,
        workOrderId: WORK_ORDER_ID,
        attemptId: 'attempt-example-1',
        forgeKind: 'post-status',
        expectedHeadSha: COMMIT,
        policyRevision: 'policy-example-1',
        acceptanceReceiptId: RECEIPT_ID,
      },
    ]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === premergeKey());
    expect(intents).toHaveLength(1);
    expect(intents[0]!.mintedId).toMatch(/^forge-/);
    expect(entries.filter((entry) => entry.kind === 'result' && entry.key === premergeKey())).toEqual([]);
    // A second advance (the reconcile) while the hold stays pending calls neither
    // grant nor execute.
    const second = await advance(harness);
    expect(second).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.grantRequests).toHaveLength(1);
    expect(harness.autoMergeCalls.count).toBe(0);
  });

  it('test 2: once the receipt passes, the reconcile posts success under a NEW action id and appends one premerge-success result', async () => {
    const harness = await mergingHarness();
    await advance(harness);
    const firstActionId = harness.forgeRequests[0]!.actionId;
    harness.setReceiptAnswer(passedReceipt());
    const reconciled = await advance(harness);
    expect(reconciled).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    expect(harness.forgeRequests).toHaveLength(2);
    const terminal = harness.forgeRequests[1]!;
    expect(terminal.status).toEqual({ context: 'premerge', state: 'success', description: 'pre-merge receipt recorded' });
    expect(terminal.actionId).not.toBe(firstActionId);
    expect(harness.grantRequests).toHaveLength(2);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === premergeKey());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'premerge-success' });
    // One intent only; the terminal post never appends a second intent.
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === premergeKey());
    expect(intents).toHaveLength(1);
  });

  it('test 3: a failed receipt with two findings posts failure with findings: 2 and never copies summary text', async () => {
    const harness = await mergingHarness();
    harness.setReceiptAnswer(failedReceipt([
      finding('untrusted reviewer prose alpha', 0),
      finding('untrusted reviewer prose beta', 1),
    ]));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-failure',
    });
    expect(harness.grantRequests).toHaveLength(1);
    expect(harness.grantRequests[0]!.acceptanceReceiptId).toBe('pm-example-2');
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]!.status).toEqual({
      context: 'premerge',
      state: 'failure',
      description: 'findings: 2',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === premergeKey() && entry.reasonCode === 'premerge-failure')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('untrusted reviewer prose');
  });

  it('a failed receipt for another head or of another kind authorises no grant and no post', async () => {
    const answers = failedReceipt([finding('other head', 0)]);
    if (answers.outcome !== 'found') {
      throw new Error('fixture');
    }
    for (const receipt of [
      { ...answers.receipt, candidateHeadSha: 'b'.repeat(40) },
      { ...answers.receipt, kind: 'code-review' as const },
    ]) {
      const harness = await mergingHarness();
      harness.setReceiptAnswer({ outcome: 'found', receipt });
      await advance(harness);
      expect(harness.grantRequests).toHaveLength(0);
      expect(harness.forgeRequests).toHaveLength(0);
    }
  });

  it('test 4: a failure count over 999 calls execute zero times and appends ambiguous review-unknown', async () => {
    const harness = await mergingHarness();
    harness.setReceiptAnswer(failedReceipt(
      Array.from({ length: 1000 }, (_, index) => finding(`finding ${index}`, index)),
    ));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    expect(harness.forgeRequests).toEqual([]);
    expect(harness.grantRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === premergeKey() && entry.outcome === 'ambiguous' && entry.reasonCode === 'review-unknown')).toBe(true);
  });

  it('test 5: a halted run with an unread premerge intent parks halted and calls execute zero times', async () => {
    const harness = await mergingHarness();
    await appendIntent(harness, premergeKey(), 'forge-01JB00000000000000000000', NOW);
    const result = await advance(harness, { halted: true });
    expect(result).toEqual({ outcome: 'parked', reason: 'halted', qualifier: null });
    expect(harness.forgeRequests).toEqual([]);
    expect(harness.grantRequests).toEqual([]);
  });

  it('test 6: an unread key whose head differs from the facts appends overtaken and calls execute zero times', async () => {
    const harness = await mergingHarness();
    // The run's collected head is `a`×40; the pending key names `b`×12.
    await appendIntent(harness, premergeKey(OTHER_HEAD12), 'forge-01JB00000000000000000000', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(OTHER_HEAD12),
      result: 'overtaken',
      reasonCode: 'premerge-overtaken',
    });
    expect(harness.forgeRequests).toEqual([]);
    expect(harness.grantRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === premergeKey(OTHER_HEAD12) && entry.outcome === 'overtaken' && entry.reasonCode === 'premerge-overtaken')).toBe(true);
  });

  it('test 7: after premerge success on a Tier 2 pass with auto-merge off, the next advance parks owner-merge and never calls autoMergeAttempt', async () => {
    const harness = await mergingHarness();
    harness.setReceiptAnswer(passedReceipt());
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    expect(harness.autoMergeCalls.count).toBe(0);
    const second = await advance(harness);
    expect(second).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(harness.autoMergeCalls.count).toBe(0);
    expect(harness.forgeRequests).toHaveLength(1);
  });

  it('test 8: Tier 1 posts success with "not required for tier 1" on the first merging advance', async () => {
    const harness = await mergingHarness(runRecord({ tier: 1 }));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]!.status).toEqual({
      context: 'premerge',
      state: 'success',
      description: 'not required for tier 1',
    });
  });

  it('test 9: a released hold with a rejected receipts assessment still refuses with grant-refused', async () => {
    const harness = await mergingHarness();
    harness.setReceiptAnswer(passedReceipt());
    harness.setReceiptsAnswer({ outcome: 'rejected', reason: 'review-blocker' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: premergeKey(),
      result: 'refused',
      reasonCode: 'grant-refused',
    });
    expect(harness.forgeRequests).toHaveLength(0);
    expect(harness.grantRequests).toHaveLength(0);
  });
});
