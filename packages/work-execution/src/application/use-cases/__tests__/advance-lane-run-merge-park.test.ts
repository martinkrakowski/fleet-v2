/**
 * Unit tests for K6-7: the conductor's `act merge` through `AutoMergeAttemptPort`,
 * the merge facts (`oneWayDoor`, `branchBehind`, `trainFree`, `policyGrant`), the
 * merge reconcile by PR state, and the park notices raised through
 * `LaneRunParkNoticePort` (attention for every park; one keyed owner question for
 * the four owner reasons). The reason codes `notice-recorded` and `notice-refused`
 * stay unused by this lane: the notice is never journalled (the park key is not a
 * journal key shape), and a failed notice never blocks the park. Every store is
 * in-memory; no forge, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type {
  AutoMergeAttemptRequest,
  AutoMergeAttemptResult,
} from '../../ports/in/AutoMergeAttemptPort.in-port.js';
import type {
  LaneRunParkNoticeResult,
  LaneRunParkRequest,
} from '../../ports/out/LaneRunParkNoticePort.out-port.js';
import type {
  ContainsCommitRequest,
  ContainsCommitResult,
} from '../../ports/out/ForgeAncestryPort.out-port.js';
import type {
  PullRequestMergeState,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../ports/out/ForgeReadPort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const OTHER_RUN_ID = 'run-01JB0000000000000000000001';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const MOVED_COMMIT = 'b'.repeat(40);
const SHA = 'c'.repeat(64);
const HEAD12 = 'a'.repeat(12);
const MOVED_HEAD12 = 'b'.repeat(12);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const PROJECT_ID = 'project-example';
const WORK_ORDER_ID = 'wo-example-1';
const OTHER_WO_ID = 'wo-example-2';
const AUTO_MERGE_DECISION = 'policy:autoMerge@0123456789ab';
const QUESTION_ID = 'question-example-1';
const FORGE_DETAIL = 'forge smoke detail example 1';

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
    state: 'intent-recorded',
    outcome: null,
    briefDigest: SHA,
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
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
  readonly step: 'prepare' | 'accept' | 'open-pr' | 'push' | 'merge';
  readonly seatIndex: number;
  readonly attemptOrdinal: number | null;
  readonly head12: string | null;
  readonly retry?: number | null;
}): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: parts.round,
    step: parts.step,
    seatIndex: parts.seatIndex,
    attemptOrdinal: parts.attemptOrdinal,
    head12: parts.head12,
    retry: parts.retry ?? null,
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

function mergeKey(): string {
  return stepKey({ round: 0, step: 'merge', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly autoMergeRequests: readonly AutoMergeAttemptRequest[];
  readonly recordParkAttentionCalls: readonly LaneRunParkRequest[];
  readonly askParkQuestionCalls: readonly LaneRunParkRequest[];
  readonly forgeReadRequests: readonly ReadPullRequestRequest[];
  readonly ancestryRequests: readonly ContainsCommitRequest[];
  readonly portCalls: readonly string[];
  readonly deps: AdvanceLaneRunDependencies;
  setAutoMergeAnswer(answer: AutoMergeAttemptResult | 'throw'): void;
  setAttentionAnswer(answer: LaneRunParkNoticeResult | 'throw'): void;
  setQuestionAnswer(answer: LaneRunParkNoticeResult | 'throw'): void;
  setForgeReadAnswer(answer: ReadPullRequestResult | 'throw'): void;
  setAncestryAnswer(answer: ContainsCommitResult | 'throw'): void;
  updateAttempt(attempt: AttemptRecord): Promise<void>;
  addWorkOrder(workOrder: WorkOrderRecord): void;
  addOtherRun(options: {
    readonly runId: string;
    readonly workOrderId: string;
    readonly repository: string;
    readonly state: 'merging';
  }): Promise<void>;
}

interface HarnessOptions {
  readonly wireAutoMerge?: boolean;
  readonly wireParkNotice?: boolean;
  readonly wireForgeRead?: boolean;
  readonly wireForgeAncestry?: boolean;
  readonly wireWorkOrder?: boolean;
  readonly autoMergeEnabled?: boolean;
}

function openPullRequestAtHead(number: number, mergeState: PullRequestMergeState = 'clean'): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number,
      state: 'open',
      mergeState,
      headSha: COMMIT,
      headRef: 'wt-example-1',
      baseRef: 'main',
      mergedAtIso: null,
      closedAtIso: null,
      mergeCommitSha: null,
    },
  };
}

function mergedPullRequestAtHead(number: number): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number,
      state: 'merged',
      mergeState: 'clean',
      headSha: COMMIT,
      headRef: 'wt-example-1',
      baseRef: 'main',
      mergedAtIso: LATER,
      closedAtIso: null,
      mergeCommitSha: COMMIT,
    },
  };
}

/** A merged PR whose head is ANOTHER head (the merge train's merge commit): head12 differs. */
function mergedPullRequestAtOtherHead(number: number): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number,
      state: 'merged',
      mergeState: 'clean',
      headSha: MOVED_COMMIT,
      headRef: 'wt-example-1',
      baseRef: 'main',
      mergedAtIso: LATER,
      closedAtIso: null,
      mergeCommitSha: MOVED_COMMIT,
    },
  };
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
  const autoMergeRequests: AutoMergeAttemptRequest[] = [];
  const recordParkAttentionCalls: LaneRunParkRequest[] = [];
  const askParkQuestionCalls: LaneRunParkRequest[] = [];
  const forgeReadRequests: ReadPullRequestRequest[] = [];
  const ancestryRequests: ContainsCommitRequest[] = [];
  const portCalls: string[] = [];
  const workOrders = new Map<string, WorkOrderRecord>([[WORK_ORDER_ID, makeWorkOrder()]]);
  let autoMergeAnswer: AutoMergeAttemptResult | 'throw' = {
    outcome: 'merged',
    attemptId: 'attempt-example-1',
    headSha: COMMIT,
    decisionRevision: AUTO_MERGE_DECISION,
  };
  const autoMergeEnabled = options.autoMergeEnabled ?? true;
  let attentionAnswer: LaneRunParkNoticeResult | 'throw' | undefined;
  let questionAnswer: LaneRunParkNoticeResult | 'throw' | undefined;
  let forgeReadAnswer: ReadPullRequestResult | 'throw' = openPullRequestAtHead(7);
  let ancestryAnswer: ContainsCommitResult | 'throw' = { outcome: 'answered', contains: false };
  const attentionStore = new Map<string, LaneRunParkNoticeResult>();
  const questionStore = new Map<string, LaneRunParkNoticeResult>();

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
    autoMergeEnabled,
    ...(options.wireAutoMerge === false
      ? {}
      : {
          autoMergeAttempt: {
            autoMergeAttempt: async (request) => {
              autoMergeRequests.push(request);
              portCalls.push('auto-merge');
              if (autoMergeAnswer === 'throw') {
                throw new Error('merge unavailable');
              }
              return autoMergeAnswer;
            },
          },
        }),
    ...(options.wireParkNotice === false
      ? {}
      : {
          parkNotice: {
            recordParkAttention: async (request) => {
              recordParkAttentionCalls.push(request);
              portCalls.push('park-attention');
              if (attentionAnswer === 'throw') {
                throw new Error('notice unavailable');
              }
              if (attentionAnswer !== undefined) {
                return attentionAnswer;
              }
              if (attentionStore.has(request.key)) {
                return { outcome: 'exists' };
              }
              attentionStore.set(request.key, { outcome: 'recorded' });
              return { outcome: 'recorded' };
            },
            askParkQuestion: async (request) => {
              askParkQuestionCalls.push(request);
              portCalls.push('park-question');
              if (questionAnswer === 'throw') {
                throw new Error('question unavailable');
              }
              if (questionAnswer !== undefined) {
                return questionAnswer;
              }
              if (questionStore.has(request.key)) {
                return { outcome: 'exists', questionId: QUESTION_ID };
              }
              questionStore.set(request.key, { outcome: 'recorded', questionId: QUESTION_ID });
              return { outcome: 'recorded', questionId: QUESTION_ID };
            },
            findParkQuestion: async () => ({ outcome: 'not-found' }),
          },
        }),
    ...(options.wireForgeRead === false
      ? {}
      : {
          forgeRead: {
            readPullRequest: async (request) => {
              forgeReadRequests.push(request);
              portCalls.push('forge-read');
              if (forgeReadAnswer === 'throw') {
                throw new Error('forge read unavailable');
              }
              return forgeReadAnswer;
            },
            isConfigured: () => true,
          },
          ...(options.wireForgeAncestry === false
            ? {}
            : {
                forgeAncestry: {
                  containsCommit: async (request) => {
                    ancestryRequests.push(request);
                    portCalls.push('forge-ancestry');
                    if (ancestryAnswer === 'throw') {
                      throw new Error('ancestry unavailable');
                    }
                    return ancestryAnswer;
                  },
                },
              }),
        }),
    ...(options.wireWorkOrder === false
      ? {}
      : {
          workOrderRepo: {
            findWorkOrderById: async (workOrderId) => {
              portCalls.push('work-order');
              return workOrders.get(workOrderId) ?? null;
            },
          },
        }),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    autoMergeRequests,
    recordParkAttentionCalls,
    askParkQuestionCalls,
    forgeReadRequests,
    ancestryRequests,
    portCalls,
    deps,
    setAutoMergeAnswer: (answer) => {
      autoMergeAnswer = answer;
    },
    setAttentionAnswer: (answer) => {
      attentionAnswer = answer;
    },
    setQuestionAnswer: (answer) => {
      questionAnswer = answer;
    },
    setForgeReadAnswer: (answer) => {
      forgeReadAnswer = answer;
    },
    setAncestryAnswer: (answer) => {
      ancestryAnswer = answer;
    },
    updateAttempt: async (attempt) => {
      await attemptRepo.saveAttempt(attempt);
    },
    addWorkOrder: (workOrder) => {
      workOrders.set(workOrder.id, workOrder);
    },
    addOtherRun: async ({ runId, workOrderId, repository, state }) => {
      const other = await runRepo.create(runRecord({ runId, workOrderId }));
      expect(other.outcome).toBe('saved');
      workOrders.set(workOrderId, makeWorkOrder({ id: workOrderId, repository }));
      const entry = laneRunConductEntry(deps.newUlid(), runId, state, NOW);
      const appended = await runJournal.append(entry);
      expect(appended.outcome).toBe('appended');
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
async function mergingHarness(options: HarnessOptions = {}, record: LaneRunRecord = runRecord()): Promise<Harness> {
  const harness = await makeHarness(record, [collectedAttempt()], {
    wireForgeRead: true,
    wireWorkOrder: true,
    wireAutoMerge: true,
    ...options,
  });
  await conduct(harness, 'merging', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  return harness;
}

describe('AdvanceLaneRunUseCase merge act and merge facts (K6-7)', () => {
  it('test 1: a merge at the head journals merged, the next advance enters merged and the one after is done', async () => {
    const harness = await mergingHarness();
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'completed',
      reasonCode: 'merged',
    });
    expect(harness.autoMergeRequests).toEqual([{ attemptId: 'attempt-example-1' }]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === mergeKey() && entry.outcome === 'completed' && entry.reasonCode === 'merged')).toBe(true);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(await advance(harness)).toEqual({ outcome: 'done' });
  });

  it('passes the recorded branch to the merge port (KF-5b)', async () => {
    const harness = await mergingHarness({}, runRecord({ branchName: 'fleet/' + RUN_ID }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'completed',
      reasonCode: 'merged',
    });
    expect(harness.autoMergeRequests).toEqual([
      { attemptId: 'attempt-example-1', branchName: 'fleet/' + RUN_ID },
    ]);
  });

  it('test 2: waiting refuses merge-waiting; after the head moves and acceptance re-establishes, the next merge acts at the new head', async () => {
    const harness = await mergingHarness();
    harness.setAutoMergeAnswer({ outcome: 'waiting', reason: 'ci-pending-first-look', headSha: COMMIT, firstLookAtIso: NOW });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'refused',
      reasonCode: 'merge-waiting',
    });
    expect(harness.autoMergeRequests).toHaveLength(1);
    // `waiting` is refused: a one-way key cannot wait. The PR read still shows open,
    // so the next merge needs a fresh head. The branch moves, acceptance is
    // re-established at the new head, and the PR read still shows open there.
    await harness.updateAttempt(collectedAttempt({
      revision: 1,
      artifacts: { ...COLLECTED_ARTIFACTS, headCommit: MOVED_COMMIT },
    }));
    await appendIntent(harness, stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: MOVED_HEAD12 }), null, LATER);
    await appendResult(harness, stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: MOVED_HEAD12 }), 'completed', 'accepted', LATER);
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    harness.setAutoMergeAnswer({
      outcome: 'merged',
      attemptId: 'attempt-example-1',
      headSha: MOVED_COMMIT,
      decisionRevision: AUTO_MERGE_DECISION,
    });
    const movedKey = stepKey({ round: 0, step: 'merge', seatIndex: 0, attemptOrdinal: null, head12: MOVED_HEAD12 });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: movedKey,
      result: 'completed',
      reasonCode: 'merged',
    });
    expect(harness.autoMergeRequests).toHaveLength(2);
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'merged',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: LATER,
        closedAtIso: null,
        mergeCommitSha: MOVED_COMMIT,
      },
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
  });

  it('test 3: a port off with autoMergeEnabled false parks owner-merge before any merge call and raises attention and a keyed question', async () => {
    const harness = await mergingHarness({ autoMergeEnabled: false, wireParkNotice: true });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(harness.autoMergeRequests).toEqual([]);
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.recordParkAttentionCalls[0]).toMatchObject({
      key: RUN_ID + '/park@1',
      projectId: PROJECT_ID,
      workOrderId: WORK_ORDER_ID,
      runId: RUN_ID,
      reason: 'owner-merge',
    });
    expect(harness.askParkQuestionCalls).toHaveLength(1);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toMatchObject({ reason: 'owner-merge', questionId: QUESTION_ID });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.reasonCode === 'notice-recorded' || entry.reasonCode === 'notice-refused')).toBe(false);
  });

  it('test CT-2a: an owner-merge-parked run reads the PR while parked and enters merged once its PR merges at the lane head', async () => {
    const parkedRecord = runRecord({
      parked: { reason: 'owner-merge', qualifier: null, parkedFrom: 'merging', questionId: null },
      parkCount: 1,
    });
    const harness = await makeHarness(parkedRecord, [collectedAttempt()], {
      wireForgeRead: true,
      wireWorkOrder: true,
      wireAutoMerge: false,
    });
    await conduct(harness, 'merging', NOW);
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
    await conduct(harness, 'parked', NOW);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'merged')).toBe(true);
    expect(harness.forgeReadRequests).toHaveLength(1);
  });

  it('test CT-2a-b: an owner-merge park whose PR read throws stays parked, and a halted pass reads nothing', async () => {
    const parkedRecord = runRecord({
      parked: { reason: 'owner-merge', qualifier: null, parkedFrom: 'merging', questionId: null },
      parkCount: 1,
    });
    const harness = await makeHarness(parkedRecord, [collectedAttempt()], {
      wireForgeRead: true,
      wireWorkOrder: true,
      wireAutoMerge: false,
    });
    await conduct(harness, 'merging', NOW);
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
    await conduct(harness, 'parked', NOW);
    harness.setForgeReadAnswer('throw');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.forgeReadRequests).toHaveLength(1);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toMatchObject({ reason: 'owner-merge' });

    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness, { halted: true })).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.forgeReadRequests).toHaveLength(1);
  });

  it('test 4: oneWayDoor (acceptance not accepted) parks one-way-door with a question; accepted does not park it', async () => {
    const harness = await mergingHarness({ wireParkNotice: true, autoMergeEnabled: false });
    // Re-assess the accepted head as rejected: the head stays the accepted head (so
    // the decider reaches mergingRules), while acceptance at the head is rejected,
    // so the merge fact oneWayDoor is true.
    const reassessKey = stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: HEAD12, retry: 1 });
    await appendIntent(harness, reassessKey, null, NOW);
    await appendResult(harness, reassessKey, 'completed', 'acceptance-rejected', NOW);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'one-way-door', qualifier: null });
    expect(harness.askParkQuestionCalls).toHaveLength(1);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked?.reason).toBe('one-way-door');
    expect(record?.parked?.questionId).toBe(QUESTION_ID);
    // Accepted at the head (the merging harness default): no one-way-door park — the
    // decider acts merge instead (covered by test 1).
  });

  it('test 5: a PR mergeState behind parks branch-behind with attention only and no question', async () => {
    const harness = await mergingHarness({ wireParkNotice: true });
    harness.setForgeReadAnswer(openPullRequestAtHead(7, 'behind'));
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'branch-behind', qualifier: null });
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.askParkQuestionCalls).toHaveLength(0);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked?.questionId).toBeNull();
  });

  it('test 6: another run of the same repository in merging waits merge-train; a run of another repository does not', async () => {
    const sameRepo = await mergingHarness({ wireParkNotice: true });
    await sameRepo.addOtherRun({ runId: OTHER_RUN_ID, workOrderId: OTHER_WO_ID, repository: 'repo-example', state: 'merging' });
    expect(await advance(sameRepo)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(sameRepo.autoMergeRequests).toEqual([]);

    const otherRepo = await mergingHarness();
    await otherRepo.addOtherRun({ runId: OTHER_RUN_ID, workOrderId: OTHER_WO_ID, repository: 'other-repo', state: 'merging' });
    expect(await advance(otherRepo)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'completed',
      reasonCode: 'merged',
    });
  });

  it('test 7: a crash after the merge intent reconciles by PR state; the merge port is never called twice', async () => {
    const merged = await mergingHarness();
    await appendIntent(merged, mergeKey(), null, NOW);
    merged.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(merged)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'completed',
      reasonCode: 'merged',
    });
    expect(merged.autoMergeRequests).toHaveLength(0);

    const open = await mergingHarness();
    await appendIntent(open, mergeKey(), null, NOW);
    open.setForgeReadAnswer(openPullRequestAtHead(7));
    expect(await advance(open)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'refused',
      reasonCode: 'merge-not-merged',
    });
    expect(open.autoMergeRequests).toHaveLength(0);
    // The refused merge is the state's step: the next advance parks step-refused merge.
    expect(await advance(open)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge' });
  });

  it('test 8: not-merged journals merge-not-merged and off journals merge-off; detail text is never journalled', async () => {
    const notMerged = await mergingHarness();
    notMerged.setAutoMergeAnswer({
      outcome: 'not-merged',
      reason: 'forge-refused',
      route: 'owner-question',
      routeOutcome: 'refused',
      detail: FORGE_DETAIL,
    });
    expect(await advance(notMerged)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'refused',
      reasonCode: 'merge-not-merged',
    });
    const entries = await notMerged.runJournal.listForRun(RUN_ID);
    expect(JSON.stringify(entries)).not.toContain(FORGE_DETAIL);

    const off = await mergingHarness();
    off.setAutoMergeAnswer({ outcome: 'off' });
    expect(await advance(off)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'refused',
      reasonCode: 'merge-off',
    });
  });

  it('test 9: an absent autoMergeAttempt wiring is not-wired; a throw is forge-ambiguous', async () => {
    const unwired = await mergingHarness({ wireAutoMerge: false });
    expect(await advance(unwired)).toEqual({ outcome: 'not-wired', step: 'merge' });

    const thrown = await mergingHarness();
    thrown.setAutoMergeAnswer('throw');
    expect(await advance(thrown)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'ambiguous',
      reasonCode: 'forge-ambiguous',
    });
  });
});

describe('AdvanceLaneRunUseCase park notices (K6-7)', () => {
  it('test 10: a throwing notice port never blocks the park and leaves questionId null', async () => {
    const harness = await mergingHarness({ wireParkNotice: true, autoMergeEnabled: false });
    harness.setAttentionAnswer('throw');
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked?.reason).toBe('owner-merge');
    expect(record?.parked?.questionId).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.reasonCode === 'notice-refused' || entry.reasonCode === 'notice-recorded')).toBe(false);
  });

  it('test 11: a repeated park key that resolves exists is handled like recorded and saves the question id', async () => {
    const harness = await mergingHarness({ wireParkNotice: true, autoMergeEnabled: false });
    harness.setQuestionAnswer({ outcome: 'exists', questionId: QUESTION_ID });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(harness.askParkQuestionCalls).toHaveLength(1);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.questionId).toBe(QUESTION_ID);
  });

  it('test 12: a park without a wired work order raises no notice but still parks', async () => {
    const harness = await mergingHarness({ wireParkNotice: true, wireWorkOrder: false, autoMergeEnabled: false });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(harness.recordParkAttentionCalls).toEqual([]);
    expect(harness.askParkQuestionCalls).toEqual([]);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('owner-merge');
  });

  it('test 13: merge waiting refuses merge-waiting; the next advance parks step-refused merge without a second merge call', async () => {
    const harness = await mergingHarness();
    harness.setAutoMergeAnswer({ outcome: 'waiting', reason: 'ci-pending-first-look', headSha: COMMIT, firstLookAtIso: NOW });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'merge',
      key: mergeKey(),
      result: 'refused',
      reasonCode: 'merge-waiting',
    });
    expect(harness.autoMergeRequests).toHaveLength(1);
    // The merge key is spent: the next advance parks for the owner, never a second merge call.
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge' });
    expect(harness.autoMergeRequests).toHaveLength(1);
  });

  it('test 14: a spent merge key parks step-refused merge without a new intent or a second merge call', async () => {
    // A completed (non-refused) final result: the decider would re-act the same key; the guard parks.
    const completed = await mergingHarness();
    await appendIntent(completed, mergeKey(), null, NOW);
    await appendResult(completed, mergeKey(), 'completed', 'merge-waiting', NOW);
    expect(await advance(completed)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge' });
    expect(completed.autoMergeRequests).toHaveLength(0);
    const completedEntries = await completed.runJournal.listForRun(RUN_ID);
    expect(completedEntries.filter((entry) => entry.kind === 'intent' && entry.key === mergeKey())).toHaveLength(1);

    // A refused final result with the PR still open: same park, still no new intent or merge call.
    const refused = await mergingHarness();
    await appendIntent(refused, mergeKey(), null, NOW);
    await appendResult(refused, mergeKey(), 'refused', 'merge-not-merged', NOW);
    expect(await advance(refused)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge' });
    expect(refused.autoMergeRequests).toHaveLength(0);
    const refusedEntries = await refused.runJournal.listForRun(RUN_ID);
    expect(refusedEntries.filter((entry) => entry.kind === 'intent' && entry.key === mergeKey())).toHaveLength(1);
  });
});

/**
 * CT-2b: the merge train's `update-branch` adds a merge commit, so a merged
 * PR's head is rarely the lane's collected head. `forgeAncestry` answers
 * whether the PR head contains the lane head; no answer is false, never a
 * guess: the run parks `ambiguous merge` or stays parked for the owner.
 */
async function ownerMergeParkedHarness(options: HarnessOptions = {}): Promise<Harness> {
  const parkedRecord = runRecord({
    parked: { reason: 'owner-merge', qualifier: null, parkedFrom: 'merging', questionId: null },
    parkCount: 1,
  });
  const harness = await makeHarness(parkedRecord, [collectedAttempt()], {
    wireForgeRead: true,
    wireWorkOrder: true,
    wireAutoMerge: false,
    ...options,
  });
  await conduct(harness, 'merging', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  await conduct(harness, 'parked', NOW);
  return harness;
}

describe('AdvanceLaneRunUseCase forge ancestry of a merged PR head (CT-2b)', () => {
  it('test (a): a merged PR at ANOTHER head whose ancestry answers contains: true enters merged with one ancestry request', async () => {
    const harness = await ownerMergeParkedHarness();
    harness.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
    harness.setAncestryAnswer({ outcome: 'answered', contains: true });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    expect(harness.ancestryRequests).toEqual([
      { ancestorSha: COMMIT, descendantSha: MOVED_COMMIT },
    ]);
  });

  it('test (b): ancestry answers contains: false and the run stays waiting parked', async () => {
    const harness = await ownerMergeParkedHarness();
    harness.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
    harness.setAncestryAnswer({ outcome: 'answered', contains: false });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toMatchObject({ reason: 'owner-merge' });
    expect(harness.ancestryRequests).toEqual([
      { ancestorSha: COMMIT, descendantSha: MOVED_COMMIT },
    ]);
  });

  it('test (c): an unavailable answer or a throw stays waiting parked', async () => {
    const unavailable = await ownerMergeParkedHarness();
    unavailable.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
    unavailable.setAncestryAnswer({ outcome: 'unavailable', reason: 'gh api compare failed (exit 1)' });
    expect(await advance(unavailable)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await unavailable.runRepo.get(RUN_ID))?.parked).toMatchObject({ reason: 'owner-merge' });
    expect(unavailable.ancestryRequests).toEqual([
      { ancestorSha: COMMIT, descendantSha: MOVED_COMMIT },
    ]);

    const thrown = await ownerMergeParkedHarness();
    thrown.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
    thrown.setAncestryAnswer('throw');
    expect(await advance(thrown)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await thrown.runRepo.get(RUN_ID))?.parked).toMatchObject({ reason: 'owner-merge' });
    expect(thrown.ancestryRequests).toEqual([
      { ancestorSha: COMMIT, descendantSha: MOVED_COMMIT },
    ]);
  });

  it('test (d): a merged PR at the lane head makes NO ancestry request', async () => {
    const harness = await ownerMergeParkedHarness();
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.ancestryRequests).toEqual([]);
  });

  it('test (e): an open PR at another head makes NO ancestry request', async () => {
    const harness = await ownerMergeParkedHarness();
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.ancestryRequests).toEqual([]);
  });

  it('test (f): no forgeAncestry dep keeps the CT-2a head-equality behaviour unchanged', async () => {
    const harness = await ownerMergeParkedHarness({ wireForgeAncestry: false });
    harness.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.ancestryRequests).toEqual([]);
    expect((await harness.runRepo.get(RUN_ID))?.parked).toMatchObject({ reason: 'owner-merge' });
  });
});

describe('AdvanceLaneRunUseCase park notice re-raise (KF-4)', () => {
  it('test 13: a park whose notice threw the first time gets its attention item and question on the next advance', async () => {
    const harness = await mergingHarness({ wireParkNotice: true, autoMergeEnabled: false });
    harness.setAttentionAnswer('throw');
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.askParkQuestionCalls).toHaveLength(0);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.questionId).toBeNull();

    // The next advance re-raises under the saved park key: the fake succeeds,
    // the question lands and its id is saved on the record.
    harness.setAttentionAnswer(undefined as unknown as LaneRunParkNoticeResult);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.recordParkAttentionCalls).toHaveLength(2);
    expect(harness.recordParkAttentionCalls[1]).toMatchObject({
      key: RUN_ID + '/park@1',
      reason: 'owner-merge',
      runId: RUN_ID,
    });
    expect(harness.askParkQuestionCalls).toHaveLength(1);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.questionId).toBe(QUESTION_ID);
  });

  it('test 14: once the question id is saved, further advances raise nothing', async () => {
    const harness = await mergingHarness({ wireParkNotice: true, autoMergeEnabled: false });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    const attentionCalls = harness.recordParkAttentionCalls.length;
    const questionCalls = harness.askParkQuestionCalls.length;
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.recordParkAttentionCalls).toHaveLength(attentionCalls);
    expect(harness.askParkQuestionCalls).toHaveLength(questionCalls);
  });

  it('test 15: the park-repair path (record parked, conduct missing) raises on repair', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()], {
      wireParkNotice: true,
      wireWorkOrder: true,
      wireForgeRead: true,
      autoMergeEnabled: false,
    });
    // A crash between the park save and the conduct append: the record is
    // parked but the journal has no `parked` conduct yet.
    const current = await harness.runRepo.get(RUN_ID);
    expect(current).not.toBeNull();
    const saved = await harness.runRepo.save({
      ...current!,
      parked: { reason: 'owner-merge', qualifier: null, parkedFrom: 'merging', questionId: null },
      parkCount: current!.parkCount + 1,
      revision: current!.revision + 1,
    }, { holderId: HOLDER, fence: 1, nowIso: LATER });
    expect(saved.outcome).toBe('saved');
    expect(await advance(harness)).toEqual({ outcome: 'repaired', state: 'parked' });
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.recordParkAttentionCalls[0]).toMatchObject({
      key: RUN_ID + '/park@1',
      reason: 'owner-merge',
    });
    expect(harness.askParkQuestionCalls).toHaveLength(1);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.questionId).toBe(QUESTION_ID);
  });

  it('test 16: an attention-only reason re-raises idempotently and never asks a question', async () => {
    const harness = await mergingHarness({ wireParkNotice: true });
    harness.setForgeReadAnswer(openPullRequestAtHead(7, 'behind'));
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'branch-behind', qualifier: null });
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.askParkQuestionCalls).toHaveLength(0);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    // The repeat answers `exists` under the same key; one call per advance.
    expect(harness.recordParkAttentionCalls).toHaveLength(2);
    expect(harness.recordParkAttentionCalls[1].key).toBe(RUN_ID + '/park@1');
    expect(harness.askParkQuestionCalls).toHaveLength(0);
    // A park other than owner-merge reads no PR while parked (CT-2a).
    expect(harness.forgeReadRequests).toHaveLength(1);
  });

  it('test 17: no parkNotice wired means no raise and the parked wait is unchanged', async () => {
    const harness = await mergingHarness({ wireParkNotice: false, autoMergeEnabled: false });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.recordParkAttentionCalls).toEqual([]);
    expect(harness.askParkQuestionCalls).toEqual([]);
    expect(harness.portCalls.filter((call) => call.startsWith('park'))).toHaveLength(0);
  });

  it('test 18: the reconcile after a landed notice re-raise saves at the fresh revision (KF-9)', async () => {
    // A parked run whose owner question lands on THIS advance saves the
    // question id at revision + 1; the unread prepare intent's reconcile (G3a)
    // must then append its attempt id at the FRESH revision, never refusing
    // once as `save-refused` on the stale one.
    const harness = await makeHarness(
      runRecord({
        parked: { reason: 'owner-merge', qualifier: null, parkedFrom: 'merging', questionId: null },
        parkCount: 1,
      }),
      [attemptFixture({ id: 'attempt-fix-1', kind: 'fix', fixNumber: 1, priorAttemptId: 'attempt-example-1' })],
      { wireParkNotice: true, wireWorkOrder: true },
    );
    await conduct(harness, 'parked', NOW);
    const prepareKey = stepKey({ round: 1, step: 'prepare', seatIndex: 0, attemptOrdinal: 2, head12: null });
    await appendIntent(harness, prepareKey, 'attempt-fix-1', NOW);

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey,
      result: 'reconciled',
      reasonCode: 'prepared',
    });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.attemptIds).toContain('attempt-fix-1');
    expect(record?.parked?.questionId).toBe(QUESTION_ID);
  });
});
