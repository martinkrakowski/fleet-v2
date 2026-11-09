/**
 * Unit tests for K6-5: the conductor's `act accept` through
 * `AcceptanceAssessmentPort` and the read-only `preMerge`, `ci` and `pr`
 * facts. The assessment maps by reason code only — never a blocker's text —
 * and the facts read the ports only past acceptance and never while halted.
 * Every store is in-memory; no forge, no CI, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type {
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
  AcceptanceReceiptsResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { ReadHeadCiStateRequest, HeadCiStateRead } from '../../ports/out/CiStatePort.out-port.js';
import type { ReadPullRequestRequest, ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import type {
  FindLatestReceiptOfKindRequest,
  FindLatestReceiptOfKindResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
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
const MOVED_COMMIT = 'b'.repeat(40);
const SHA = 'c'.repeat(64);
const HEAD12 = 'a'.repeat(12);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const BLOCKER_TEXT = 'blocker text example 1';

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

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'intent-recorded',
    outcome: null,
    briefDigest: SHA,
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
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

function collectedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS, ...overrides });
}

/** A run record via the domain entity, like the earlier K4 fixtures. */
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

function stepKey(parts: {
  readonly round: number;
  readonly step: 'prepare' | 'accept';
  readonly seatIndex: number;
  readonly attemptOrdinal: number | null;
  readonly head12: string | null;
}): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: parts.round,
    step: parts.step,
    seatIndex: parts.seatIndex,
    attemptOrdinal: parts.attemptOrdinal,
    head12: parts.head12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a step key');
  }
  return built.key;
}

function acceptKey(): string {
  return stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

/** A failed brief-check receipt at the collected head with one blocking (major) finding (RV3). */
const FAILED_BRIEF_CHECK_RECEIPT: FindLatestReceiptOfKindResult = {
  outcome: 'found',
  receipt: {
    receiptId: 'receipt-example-1',
    requestId: null,
    kind: 'brief-check',
    reviewerModel: 'reviewer-example-1',
    candidateHeadSha: COMMIT,
    verdict: 'failed',
    findings: [
      { findingId: 'finding-1', severity: 'major', summary: 'blocking review finding', filePath: 'src/ex.ts', line: 4 },
    ],
  },
};

/** A failed brief-check receipt at the collected head with one minor finding only (RV3: a pass). */
const MINOR_ONLY_BRIEF_CHECK_RECEIPT: FindLatestReceiptOfKindResult = {
  outcome: 'found',
  receipt: {
    receiptId: 'receipt-example-1',
    requestId: null,
    kind: 'brief-check',
    reviewerModel: 'reviewer-example-1',
    candidateHeadSha: COMMIT,
    verdict: 'failed',
    findings: [
      { findingId: 'finding-1', severity: 'minor', summary: 'minor review finding', filePath: 'src/ex.ts', line: 4 },
    ],
  },
};

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly acceptanceRequests: readonly AcceptanceAssessmentRequest[];
  readonly receiptsRequests: readonly AcceptanceAssessmentRequest[];
  readonly ciRequests: readonly ReadHeadCiStateRequest[];
  readonly forgeRequests: readonly ReadPullRequestRequest[];
  readonly receiptRequests: readonly FindLatestReceiptOfKindRequest[];
  readonly portCalls: readonly string[];
  readonly deps: AdvanceLaneRunDependencies;
  setAcceptanceAnswer(answer: AcceptanceAssessmentResult | 'throw'): void;
  setReceiptsAnswer(answer: AcceptanceReceiptsResult | 'throw'): void;
  setCiAnswer(answer: HeadCiStateRead | 'throw'): void;
  setForgeAnswer(answer: ReadPullRequestResult | 'throw'): void;
  setReceiptAnswer(answer: FindLatestReceiptOfKindResult): void;
}

interface HarnessOptions {
  readonly wireAcceptance?: boolean;
  readonly wireCi?: boolean;
  readonly wireForge?: boolean;
  readonly wireReceiptRead?: boolean;
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
  const acceptanceRequests: AcceptanceAssessmentRequest[] = [];
  const receiptsRequests: AcceptanceAssessmentRequest[] = [];
  const ciRequests: ReadHeadCiStateRequest[] = [];
  const forgeRequests: ReadPullRequestRequest[] = [];
  const receiptRequests: FindLatestReceiptOfKindRequest[] = [];
  const portCalls: string[] = [];
  let acceptanceAnswer: AcceptanceAssessmentResult | 'throw' = { outcome: 'accepted', receiptId: 'receipt-example-1', assessedHeadSha: COMMIT };
  let receiptsAnswer: AcceptanceReceiptsResult | 'throw' = { outcome: 'passed', receiptsId: 'rcp-example-1', assessedHeadSha: COMMIT };
  let ciAnswer: HeadCiStateRead | 'throw' = { headSha: COMMIT, state: 'passed', reason: 'read' };
  let forgeAnswer: ReadPullRequestResult | 'throw' = {
    outcome: 'found',
    pullRequest: {
      number: 7,
      state: 'open',
      mergeState: 'clean',
      headSha: COMMIT,
      headRef: 'wt-example-1',
      isCrossRepository: false,
      headRepositoryOwner: 'example-owner',      baseRef: 'main',
      mergedAtIso: null,
      closedAtIso: null,
      mergeCommitSha: null,
    },
  };
  let receiptAnswer: FindLatestReceiptOfKindResult = { outcome: 'not-found' };

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
      readBriefManifest: async () => null,
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
    ...(options.wireAcceptance === false
      ? {}
      : {
          acceptanceAssessment: {
            assessHeadAcceptance: async (request) => {
              acceptanceRequests.push(request);
              portCalls.push('acceptance');
              if (acceptanceAnswer === 'throw') {
                throw new Error('assessment unavailable');
              }
              return acceptanceAnswer;
            },
            assessHeadReceipts: async (request) => {
              receiptsRequests.push(request);
              portCalls.push('receipts');
              if (receiptsAnswer === 'throw') {
                throw new Error('receipts assessment unavailable');
              }
              return receiptsAnswer;
            },
          },
        }),
    ...(options.wireCi === false
      ? {}
      : {
          ciState: {
            readHeadCiState: async (request) => {
              ciRequests.push(request);
              portCalls.push('ci');
              if (ciAnswer === 'throw') {
                throw new Error('ci unavailable');
              }
              return ciAnswer;
            },
          },
        }),
    ...(options.wireForge === false
      ? {}
      : {
          forgeRead: {
            readPullRequest: async (request) => {
              forgeRequests.push(request);
              portCalls.push('forge');
              if (forgeAnswer === 'throw') {
                throw new Error('forge unavailable');
              }
              return forgeAnswer;
            },
            isConfigured: () => true,
            listOpenPullRequestsByBase: async () => ({ outcome: "unavailable" as const, reason: "not-used" }),
          },
        }),
    ...(options.wireReceiptRead === false
      ? {}
      : {
          reviewRequest: {
            requestReview: async () => {
              throw new Error('not used by K6-5');
            },
            findReviewReceipt: async () => ({ outcome: 'not-found' }),
            findLatestReceiptOfKind: async (request) => {
              receiptRequests.push(request);
              portCalls.push('receipt');
              return receiptAnswer;
            },
          },
        }),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    acceptanceRequests,
    receiptsRequests,
    ciRequests,
    forgeRequests,
    receiptRequests,
    portCalls,
    deps,
    setAcceptanceAnswer: (answer) => {
      acceptanceAnswer = answer;
    },
    setReceiptsAnswer: (answer) => {
      receiptsAnswer = answer;
    },
    setCiAnswer: (answer) => {
      ciAnswer = answer;
    },
    setForgeAnswer: (answer) => {
      forgeAnswer = answer;
    },
    setReceiptAnswer: (answer) => {
      receiptAnswer = answer;
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
  detail: string | null = null,
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso, detail);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

/** Simulate a conductor resume of a parked run: clear the park and enter accepting (KF-23). */
async function resumeAccepting(harness: Harness, nowIso: string): Promise<void> {
  const current = await harness.runRepo.get(RUN_ID);
  expect(current).not.toBeNull();
  if (current === null) {
    throw new Error('run missing');
  }
  const saved = await harness.runRepo.save(
    { ...current, parked: null, revision: current.revision + 1 },
    { holderId: HOLDER, fence: 1, nowIso },
  );
  expect(saved.outcome).toBe('saved');
  await conduct(harness, 'accepting', nowIso);
}

/** A collected attempt in `accepting`, placed by the run's round-0 seat 0. */
async function acceptingHarness(options: HarnessOptions = {}): Promise<Harness> {
  const harness = await makeHarness(runRecord(), [collectedAttempt()], options);
  await conduct(harness, 'accepting', NOW);
  return harness;
}

/** A collected attempt in a post-acceptance state, accepted at the collected head. */
async function acceptedHarness(
  state: 'awaiting-premerge' | 'pushing' | 'watching-ci',
  recordOverrides: Record<string, unknown> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const harness = await makeHarness(runRecord(recordOverrides), [collectedAttempt()], options);
  await conduct(harness, state, NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  return harness;
}

describe('AdvanceLaneRunUseCase accept act (K6-5)', () => {
  it('test 1: a passed receipts answer at the head journals accepted and the next advance enters opening-pr (Tier 2); assessHeadAcceptance is never called', async () => {
    const harness = await acceptingHarness();
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(harness.receiptsRequests).toEqual([
      {
        attemptId: 'attempt-example-1',
        workOrderId: 'wo-example-1',
        candidateHeadSha: COMMIT,
        policyRevision: 'policy-example-1',
      },
    ]);
    expect(harness.acceptanceRequests).toEqual([]);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'opening-pr' });
  });

  it('test 1b: Tier 1 with no PR enters opening-pr', async () => {
    const tier1 = await makeHarness(runRecord({ tier: 1 }), [collectedAttempt()]);
    await conduct(tier1, 'accepting', NOW);
    expect(await advance(tier1)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(await advance(tier1)).toEqual({ outcome: 'entered', state: 'opening-pr' });
  });

  it('test 2: a rejected receipts answer journals completed/acceptance-rejected and the next advance parks acceptance-rejected', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({ outcome: 'rejected', reason: BLOCKER_TEXT });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    expect(harness.acceptanceRequests).toEqual([]);
    expect(await advance(harness)).toEqual({
      outcome: 'parked',
      reason: 'acceptance-rejected',
      qualifier: null,
    });
  });

  it('test 3: an unknown receipts answer is ambiguous and the next advance parks ambiguous accept', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({ outcome: 'unknown', reason: BLOCKER_TEXT });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'ambiguous',
      reasonCode: 'acceptance-unknown',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'accept' });
  });

  it('test 4: a passed receipts answer at a moved head is ambiguous, never a pass', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({ outcome: 'passed', receiptsId: 'rcp-example-1', assessedHeadSha: MOVED_COMMIT });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'ambiguous',
      reasonCode: 'acceptance-unknown',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'accept' });
  });

  it('test 5: a thrown receipts assessment leaves the intent unread; the next advance reconciles by re-running the assessment', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer('throw');
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'ambiguous',
      reasonCode: 'acceptance-unknown',
    });
    // No result was journalled: the intent stays unread for the reconcile.
    const afterThrow = await harness.runJournal.listForRun(RUN_ID);
    expect(afterThrow.filter((entry) => entry.kind === 'result' && entry.key === acceptKey())).toEqual([]);
    // The next advance reconciles by calling the assessment again; when it answers
    // passed, it journals accepted — never a second intent.
    harness.setReceiptsAnswer({ outcome: 'passed', receiptsId: 'rcp-example-1', assessedHeadSha: COMMIT });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(harness.receiptsRequests).toHaveLength(2);
    expect(harness.acceptanceRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey());
    expect(intents).toHaveLength(1);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === acceptKey() && entry.outcome === 'completed' && entry.reasonCode === 'accepted')).toBe(true);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'opening-pr' });
  });

  it('test 6: a pending accept intent from a crash reconciles by re-running the assessment once, with no second intent', async () => {
    const harness = await acceptingHarness();
    await appendIntent(harness, acceptKey(), null, NOW);
    expect(harness.acceptanceRequests).toEqual([]);
    const reconciled = await advance(harness);
    expect(reconciled).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(harness.receiptsRequests).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey());
    expect(intents).toHaveLength(1);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'opening-pr' });
  });

  it('test 7: no acceptance assessment port is not-wired with its step and writes nothing', async () => {
    const harness = await acceptingHarness({ wireAcceptance: false });
    expect(await advance(harness)).toEqual({ outcome: 'not-wired', step: 'accept' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey())).toEqual([]);
  });

  it('test 8: the receipt id and no blocker text reach the journal; reason codes only', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [{ kind: 'ci-failed', text: BLOCKER_TEXT }],
    });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.reasonCode === 'acceptance-rejected')).toBe(true);
    expect(entries.some((entry) => JSON.stringify(entry).includes(BLOCKER_TEXT))).toBe(false);
    expect(entries.some((entry) => JSON.stringify(entry).includes('rcp-example-1'))).toBe(false);
  });

  it('AR1: a rejection with other blockers and a failed review receipt journals the review-findings detail', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [
        { kind: 'other', text: BLOCKER_TEXT },
        { kind: 'other', text: 'second blocker text example' },
      ],
    });
    harness.setReceiptAnswer(FAILED_BRIEF_CHECK_RECEIPT);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
      detail: 'review-findings',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const result = entries.find((entry) => entry.kind === 'result' && entry.key === acceptKey());
    expect(result).toMatchObject({ outcome: 'completed', reasonCode: 'acceptance-rejected', detail: 'review-findings' });
    expect(harness.receiptRequests).toEqual([
      { attemptId: 'attempt-example-1', candidateHeadSha: COMMIT, kind: 'brief-check' },
    ]);
  });

  it('AR1 (RV3): a minor-only failed brief-check receipt never carries the review-findings detail', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [
        { kind: 'other', text: BLOCKER_TEXT },
        { kind: 'other', text: 'second blocker text example' },
      ],
    });
    harness.setReceiptAnswer(MINOR_ONLY_BRIEF_CHECK_RECEIPT);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const result = entries.find((entry) => entry.kind === 'result' && entry.key === acceptKey());
    expect(result).toMatchObject({ outcome: 'completed', reasonCode: 'acceptance-rejected', detail: null });
  });

  it('AR1: a rejection with a door blocker never carries the review-findings detail', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [{ kind: 'door', text: BLOCKER_TEXT }],
    });
    harness.setReceiptAnswer(FAILED_BRIEF_CHECK_RECEIPT);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const result = entries.find((entry) => entry.kind === 'result' && entry.key === acceptKey());
    expect(result).toMatchObject({ outcome: 'completed', reasonCode: 'acceptance-rejected', detail: null });
    expect(harness.receiptRequests).toEqual([]);
  });

  it('AR1: a rejection whose receipts passed carries no review-findings detail', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [{ kind: 'other', text: BLOCKER_TEXT }],
    });
    // The receipt fake answers a found, passed receipt (F61 correction of the
    // AR1 fixture: the receipts "passed" case is not a not-found receipt).
    harness.setReceiptAnswer({
      outcome: 'found',
      receipt: {
        receiptId: 'receipt-example-1',
        requestId: null,
        kind: 'brief-check',
        reviewerModel: 'reviewer-example-1',
        candidateHeadSha: COMMIT,
        verdict: 'passed',
        findings: [],
      },
    });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const result = entries.find((entry) => entry.kind === 'result' && entry.key === acceptKey());
    expect(result).toMatchObject({ outcome: 'completed', reasonCode: 'acceptance-rejected', detail: null });
  });

  it('AR1: a rejected acceptance parks, resumes, and parks at once with no new accept intent', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({ outcome: 'rejected', reason: BLOCKER_TEXT });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'acceptance-rejected', qualifier: null });
    await resumeAccepting(harness, LATER);
    const receiptsBefore = harness.receiptsRequests.length;
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'acceptance-rejected', qualifier: null });
    // F61: the null-detail rejection is classified from the assessment once per
    // advance in accepting; the accept act itself did not run again.
    expect(harness.receiptsRequests.length - receiptsBefore).toBe(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey());
    expect(intents).toHaveLength(1);
  });

  it('AR1: a review-blocked rejection in accepting enters fixing with no new accept intent', async () => {
    const harness = await acceptingHarness();
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'acceptance-rejected', NOW, 'review-findings');
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'fixing' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey());
    expect(intents).toHaveLength(1);
  });

  it('F61: a pre-AR1 rejection with a null detail and review blockers enters fixing', async () => {
    const harness = await acceptingHarness();
    // Journal the pre-AR1 rejection by hand: no detail on the accept result.
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'acceptance-rejected', NOW);
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [{ kind: 'other', text: BLOCKER_TEXT }],
    });
    harness.setReceiptAnswer(FAILED_BRIEF_CHECK_RECEIPT);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'fixing' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey());
    expect(intents).toHaveLength(1);
  });

  it('F61: a pre-AR1 rejection with a null detail and a non-review blocker parks acceptance-rejected', async () => {
    const harness = await acceptingHarness();
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'acceptance-rejected', NOW);
    harness.setReceiptsAnswer({
      outcome: 'rejected',
      reason: BLOCKER_TEXT,
      blockerDetails: [{ kind: 'door', text: BLOCKER_TEXT }],
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'acceptance-rejected', qualifier: null });
    // RV3: the acceptance-rejected park reads the review receipts once (ordered
    // by parkedFrom) to attach the causing findings; with no failed review
    // receipt the parked record carries no findings field at all, never [].
    const parkedRecord = await harness.runRepo.get(RUN_ID);
    expect(parkedRecord?.parked?.findings).toBeUndefined();
    expect(harness.receiptRequests.map((request) => request.kind)).toEqual([
      'code-review',
      'brief-check',
      'pre-merge',
    ]);
  });

  it('AR1: a review-blocked rejection at round 2 parks with the accept intents unchanged', async () => {
    const harness = await makeHarness(
      runRecord({ round: 2, attemptIds: ['attempt-example-0', 'attempt-example-0a', 'attempt-example-1'] }),
      [collectedAttempt()],
    );
    await conduct(harness, 'accepting', NOW);
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'acceptance-rejected', NOW, 'review-findings');
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'acceptance-rejected', qualifier: null });
    // A resumed run parks again instead of blocking-after-round-2, and never retries accept.
    await resumeAccepting(harness, LATER);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'acceptance-rejected', qualifier: null });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === acceptKey());
    expect(intents).toHaveLength(1);
  });

  it('KF-23: a journal whose rejected result has no park after it still parks (no retry)', async () => {
    const harness = await acceptingHarness();
    harness.setReceiptsAnswer({ outcome: 'rejected', reason: BLOCKER_TEXT });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'acceptance-rejected',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'acceptance-rejected', qualifier: null });
  });
});

describe('AdvanceLaneRunUseCase read-only facts (K6-5)', () => {
  it('test 9: in accepting no read port is called', async () => {
    const harness = await acceptingHarness();
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(harness.portCalls).toEqual(['receipts']);
  });

  it('test 10: with every read port unbound the facts keep their hard-coded defaults', async () => {
    const waiting = await acceptedHarness('awaiting-premerge', {}, {
      wireCi: false,
      wireForge: false,
      wireReceiptRead: false,
    });
    expect(await advance(waiting)).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
    const watching = await acceptedHarness('watching-ci', {}, { wireCi: false, wireForge: false, wireReceiptRead: false });
    expect(await advance(watching)).toEqual({ outcome: 'waiting', reason: 'ci-unknown' });
    const pushing = await acceptedHarness('pushing', {}, { wireCi: false, wireForge: false, wireReceiptRead: false });
    expect(await advance(pushing)).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
  });

  it('test 11: a passed pre-merge receipt enters opening-pr; a not-found one waits premerge-pending', async () => {
    const passed = await acceptedHarness('awaiting-premerge');
    passed.setReceiptAnswer({
      outcome: 'found',
      receipt: {
        receiptId: 'receipt-example-1',
        requestId: 'request-example-1',
        kind: 'pre-merge',
        reviewerModel: 'reviewer-example-1',
        candidateHeadSha: COMMIT,
        verdict: 'passed',
        findings: [],
      },
    });
    expect(await advance(passed)).toEqual({ outcome: 'entered', state: 'opening-pr' });
    expect(passed.receiptRequests).toEqual([
      { attemptId: 'attempt-example-1', candidateHeadSha: COMMIT, kind: 'pre-merge' },
    ]);
    const none = await acceptedHarness('awaiting-premerge');
    expect(await advance(none)).toEqual({ outcome: 'waiting', reason: 'premerge-pending' });
  });

  it('test 12: an unknown or unavailable pre-merge receipt parks ambiguous pre-merge; a failed one with a blocking finding at round 2 parks blocker-after-round-2 with non-empty findings; a failed one with zero findings parks ambiguous (RV3)', async () => {
    const unknown = await acceptedHarness('awaiting-premerge');
    unknown.setReceiptAnswer({
      outcome: 'found',
      receipt: {
        receiptId: 'receipt-example-1',
        requestId: 'request-example-1',
        kind: 'pre-merge',
        reviewerModel: 'reviewer-example-1',
        candidateHeadSha: COMMIT,
        verdict: 'unknown',
        findings: [],
      },
    });
    expect(await advance(unknown)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'pre-merge' });
    const unavailable = await acceptedHarness('awaiting-premerge');
    unavailable.setReceiptAnswer({ outcome: 'unavailable', reason: 'unreadable' });
    expect(await advance(unavailable)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'pre-merge' });
    // (i) A failed pre-merge receipt with a blocking finding parks
    // blocker-after-round-2 at round 2 with the causing findings attached.
    const failedBlocking = await acceptedHarness('awaiting-premerge', { round: 2, attemptIds: ['attempt-example-0', 'attempt-example-0a', 'attempt-example-1'] });
    failedBlocking.setReceiptAnswer({
      outcome: 'found',
      receipt: {
        receiptId: 'receipt-example-1',
        requestId: 'request-example-1',
        kind: 'pre-merge',
        reviewerModel: 'reviewer-example-1',
        candidateHeadSha: COMMIT,
        verdict: 'failed',
        findings: [
          { findingId: 'finding-1', severity: 'major', summary: 'a blocking pre-merge finding', filePath: 'src/ex.ts', line: 4 },
        ],
      },
    });
    const blockingPark = await advance(failedBlocking);
    expect(blockingPark).toEqual({ outcome: 'parked', reason: 'blocker-after-round-2', qualifier: null });
    const blockingRecord = await failedBlocking.runRepo.get(RUN_ID);
    expect(blockingRecord?.parked?.findings).toEqual([
      { findingId: 'finding-1', severity: 'major', summary: 'a blocking pre-merge finding', filePath: 'src/ex.ts', line: 4 },
    ]);
    // (ii) A failed pre-merge receipt with zero findings is an unparseable
    // verdict (RV3 req c): it parks ambiguous pre-merge, never a fix round.
    const failedZero = await acceptedHarness('awaiting-premerge', { round: 2, attemptIds: ['attempt-example-0', 'attempt-example-0a', 'attempt-example-1'] });
    failedZero.setReceiptAnswer({
      outcome: 'found',
      receipt: {
        receiptId: 'receipt-example-1',
        requestId: 'request-example-1',
        kind: 'pre-merge',
        reviewerModel: 'reviewer-example-1',
        candidateHeadSha: COMMIT,
        verdict: 'failed',
        findings: [],
      },
    });
    expect(await advance(failedZero)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'pre-merge' });
  });

  it('test 13: CI states pass through at the exact head; a head mismatch reads unknown', async () => {
    const pending = await acceptedHarness('watching-ci');
    pending.setCiAnswer({ headSha: COMMIT, state: 'pending', reason: 'read' });
    expect(await advance(pending)).toEqual({ outcome: 'waiting', reason: 'ci-pending' });
    expect(pending.ciRequests).toEqual([{ headSha: COMMIT }]);
    const passed = await acceptedHarness('watching-ci');
    expect(await advance(passed)).toEqual({ outcome: 'entered', state: 'merging' });
    const mismatch = await acceptedHarness('watching-ci');
    mismatch.setCiAnswer({ headSha: MOVED_COMMIT, state: 'passed', reason: 'read' });
    expect(await advance(mismatch)).toEqual({ outcome: 'waiting', reason: 'ci-unknown' });
    const failed = await acceptedHarness('watching-ci', { round: 2, attemptIds: ['attempt-example-0', 'attempt-example-0a', 'attempt-example-1'] });
    failed.setCiAnswer({ headSha: COMMIT, state: 'failed', reason: 'read' });
    expect(await advance(failed)).toEqual({ outcome: 'parked', reason: 'ci-failed-no-rounds', qualifier: null });
  });

  it('test 14: the PR is read by number when prNumber is set and by branch otherwise; not-found reads null', async () => {
    const byNumber = await acceptedHarness('pushing', { prNumber: 7 });
    expect(await advance(byNumber)).toEqual({ outcome: 'entered', state: 'watching-ci' });
    expect(byNumber.forgeRequests).toEqual([{ ref: { kind: 'number', number: 7 } }]);
    const byBranch = await acceptedHarness('pushing');
    expect(await advance(byBranch)).toEqual({ outcome: 'entered', state: 'watching-ci' });
    expect(byBranch.forgeRequests).toEqual([{ ref: { kind: 'branch', branchName: 'wt-example-1' } }]);
    const notFound = await acceptedHarness('pushing', { prNumber: 7 });
    notFound.setForgeAnswer({ outcome: 'not-found' });
    expect(await advance(notFound)).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
  });

  it('test 15: a halted advance calls no read port and parks halted', async () => {
    const harness = await acceptedHarness('awaiting-premerge');
    expect(await advance(harness, { halted: true })).toEqual({
      outcome: 'parked',
      reason: 'halted',
      qualifier: null,
    });
    expect(harness.portCalls).toEqual([]);
  });
});
