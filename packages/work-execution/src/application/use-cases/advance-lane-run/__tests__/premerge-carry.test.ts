/**
 * U6: a Tier 2 premerge release carries across a base-merge head move. When the
 * merge train merges `main` into the PR (strict up-to-date ruleset) the PR head
 * moves off the reviewed lane head; the run carries the owner receipt's release
 * to the new head only when the new head is the reviewed head plus a clean merge
 * of the base, the PR's own paths equal the lane's, and CI on it is green. Every
 * other move is refused (the run parks `branch-behind`), and unanswered evidence
 * keeps waiting. Every store is in-memory; no forge, no subprocess, no network.
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
const NEW_HEAD = OTHER_COMMIT;
const NEW_HEAD12 = NEW_HEAD.slice(0, 12);
const MAIN_PARENT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const BASE_SHA = 'e'.repeat(40);
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


import type {
  ReceiptCarryEvidencePort,
  ReceiptCarryEvidenceResult,
} from '../../../ports/out/ReceiptCarryEvidencePort.out-port.js';

type Evidence = Extract<ReceiptCarryEvidenceResult, { ok: true }>;

function cleanEvidence(overrides: Partial<Evidence> = {}): ReceiptCarryEvidenceResult {
  return {
    ok: true,
    newHeadParents: [COMMIT, MAIN_PARENT],
    secondParentOnBase: true,
    mainRangeBaseSha: BASE_SHA,
    automaticMergeTreeSha: TREE,
    newHeadTreeSha: TREE,
    prChangedPaths: ['src/example.ts'],
    ...overrides,
  };
}

interface CarryRig {
  readonly harness: Harness;
  readonly evidenceCalls: { count: number };
  run(): ReturnType<typeof advance>;
}

/** A merging Tier 2 run whose PR head moved to NEW_HEAD, with the owner receipt at the reviewed head. */
async function carryRig(options: {
  readonly evidence?: ReceiptCarryEvidenceResult | 'throw' | 'absent';
  readonly ci?: 'passed' | 'failed' | 'pending' | 'unknown';
  readonly lanePaths?: readonly string[] | null;
} = {}): Promise<CarryRig> {
  const harness = await mergingHarness({ premergeMode: 'auto-attest', prHeadSha: NEW_HEAD });
  harness.setReceiptAnswer(ownerReceipt());
  const evidenceCalls = { count: 0 };
  const evidence = options.evidence ?? cleanEvidence();
  const port: ReceiptCarryEvidencePort = {
    readCarryEvidence: async () => {
      evidenceCalls.count += 1;
      if (evidence === 'throw') {
        throw new Error('mirror unavailable');
      }
      return evidence === 'absent' ? cleanEvidence() : evidence;
    },
  };
  const ci = options.ci ?? 'passed';
  const lanePaths = options.lanePaths === undefined ? ['src/example.ts'] : options.lanePaths;
  const deps: AdvanceLaneRunDependencies = {
    ...harness.deps,
    ...(evidence === 'absent' ? {} : { receiptCarryEvidence: port, repositoryDigest: '0123456789ab' }),
    artifactPort: { ...harness.deps.artifactPort, readChangedPaths: async () => lanePaths },
    ciState: { readHeadCiState: async (request) => ({ headSha: request.headSha, state: ci, reason: 'read' }) },
  };
  return {
    harness,
    evidenceCalls,
    run: () =>
      new AdvanceLaneRunUseCase(deps).advanceLaneRun({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        halted: false,
        nowIso: LATER,
      }),
  };
}

const carriedKey = (): string => premergeKey(NEW_HEAD12);

describe('premerge carry (U6): the Tier 2 release across a base-merge head move', () => {
  it('carries on a clean base merge', async () => {
    const rig = await carryRig();
    const posted = await rig.run();
    expect(posted).toEqual({
      outcome: 'acted',
      step: 'premerge',
      key: carriedKey(),
      result: 'completed',
      reasonCode: 'premerge-success',
    });
    // The status, the grant and the action are all pinned to the PR head; the
    // action names the reviewed head it was carried from.
    expect(rig.harness.forgeRequests).toHaveLength(1);
    expect(rig.harness.forgeRequests[0]).toMatchObject({
      kind: 'post-status',
      expectedHeadSha: NEW_HEAD,
      carriedFromHeadSha: COMMIT,
      status: { context: 'premerge', state: 'success' },
    });
    expect(rig.harness.grantRequests).toHaveLength(1);
    expect(rig.harness.grantRequests[0]!.expectedHeadSha).toBe(NEW_HEAD);
    // The auditable carry fact: on the carried head's premerge intent.
    const entries = await rig.harness.runJournal.listForRun(RUN_ID);
    const intent = entries.find((entry) => entry.kind === 'intent' && entry.key === carriedKey());
    expect(intent?.carry).toMatchObject({
      attemptId: 'attempt-example-1',
      fromHeadSha: COMMIT,
      toHeadSha: NEW_HEAD,
      mainParentSha: MAIN_PARENT,
      mainRangeBaseSha: BASE_SHA,
      changedPaths: ['src/example.ts'],
      reason: 'base-merge-clean',
    });
  });

  it('carry is journalled with from-head and to-head', async () => {
    const rig = await carryRig();
    await rig.run();
    const entries = await rig.harness.runJournal.listForRun(RUN_ID);
    const carried = entries.filter((entry) => entry.carry !== undefined && entry.carry !== null);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.carry!.fromHeadSha).toBe(COMMIT);
    expect(carried[0]!.carry!.toHeadSha).toBe(NEW_HEAD);
  });

  it('refuses a conflict-resolved merge', async () => {
    const rig = await carryRig({ evidence: cleanEvidence({ newHeadTreeSha: 'f'.repeat(40) }) });
    expect(await rig.run()).toMatchObject({ outcome: 'entered', state: 'parked' });
    expect(successStatuses(rig.harness)).toHaveLength(0);
    expect(rig.harness.forgeRequests).toHaveLength(0);
  });

  it('refuses a lane-authored change', async () => {
    const rig = await carryRig({ evidence: cleanEvidence({ prChangedPaths: ['src/example.ts', 'src/lane-authored.ts'] }) });
    expect(await rig.run()).toMatchObject({ outcome: 'entered', state: 'parked' });
    expect(successStatuses(rig.harness)).toHaveLength(0);
    expect(rig.harness.forgeRequests).toHaveLength(0);
  });

  it('refuses a non-merge head move', async () => {
    const rig = await carryRig({ evidence: cleanEvidence({ newHeadParents: [COMMIT] }) });
    expect(await rig.run()).toMatchObject({ outcome: 'entered', state: 'parked' });
    expect(rig.harness.forgeRequests).toHaveLength(0);
  });

  it("refuses when the first parent isn't the reviewed head", async () => {
    const rig = await carryRig({ evidence: cleanEvidence({ newHeadParents: [MAIN_PARENT, COMMIT] }) });
    expect(await rig.run()).toMatchObject({ outcome: 'entered', state: 'parked' });
    expect(rig.harness.forgeRequests).toHaveLength(0);
  });

  it('refuses with red CI', async () => {
    const rig = await carryRig({ ci: 'failed' });
    expect(await rig.run()).toMatchObject({ outcome: 'entered', state: 'parked' });
    expect(rig.harness.forgeRequests).toHaveLength(0);
  });

  it('keeps waiting premerge-pending, not parking, while CI is pending or the evidence is unavailable', async () => {
    for (const rig of [
      await carryRig({ ci: 'pending' }),
      await carryRig({ evidence: 'throw' }),
      await carryRig({ evidence: 'absent' }),
      await carryRig({ evidence: { ok: false, reason: 'refused', code: 'no-mirror' } }),
      await carryRig({ lanePaths: null }),
    ]) {
      expect(await rig.run()).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
      expect(successStatuses(rig.harness)).toHaveLength(0);
    }
  });

  it('idempotent re-post', async () => {
    const rig = await carryRig();
    await rig.run();
    const second = await rig.run();
    // Success is already recorded at the carried head: nothing is posted again,
    // no second grant, no second carry intent, and the git evidence is not read again.
    expect(second).not.toMatchObject({ step: 'premerge' });
    expect(rig.harness.forgeRequests).toHaveLength(1);
    expect(rig.harness.grantRequests).toHaveLength(1);
    expect(rig.evidenceCalls.count).toBe(1);
    const entries = await rig.harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === carriedKey())).toHaveLength(1);
    expect(entries.filter((entry) => entry.carry !== undefined && entry.carry !== null)).toHaveLength(1);
  });

  it('settles a pending post made at the reviewed head as overtaken, then posts at the carried head', async () => {
    // The pending post (made before the owner receipt, at the reviewed head) is
    // the intent that used to wait forever once the train moved the head.
    const harness = await mergingHarness({ premergeMode: 'auto-attest' });
    await advance(harness);
    expect(harness.forgeRequests[0]!.status?.state).toBe('pending');
    const moved = await carryRig();
    // Reuse the pending journal on the moved-head rig: copy its entries.
    for (const entry of await harness.runJournal.listForRun(RUN_ID)) {
      if (entry.kind === 'intent' && entry.key === premergeKey()) {
        await moved.harness.runJournal.append(entry);
      }
    }
    const settled = await moved.run();
    expect(settled).toMatchObject({ outcome: 'acted', step: 'premerge', key: premergeKey(), result: 'overtaken' });
    const posted = await moved.run();
    expect(posted).toMatchObject({ outcome: 'acted', step: 'premerge', key: carriedKey(), reasonCode: 'premerge-success' });
    expect(moved.harness.forgeRequests).toHaveLength(1);
    expect(moved.harness.forgeRequests[0]).toMatchObject({ expectedHeadSha: NEW_HEAD, carriedFromHeadSha: COMMIT });
  });

  it('a carried release without the owner receipt at the reviewed head still waits', async () => {
    const rig = await carryRig();
    rig.harness.setReceiptAnswer(automatedReceipt());
    const result = await rig.run();
    expect(result).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    expect(successStatuses(rig.harness)).toHaveLength(0);
  });
});
