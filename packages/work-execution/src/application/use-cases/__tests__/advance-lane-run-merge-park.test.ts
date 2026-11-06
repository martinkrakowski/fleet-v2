/**
 * Unit tests for K6-7 and KS7b: the conductor's `act merge-enqueue` through
 * `EnqueueMergePort` and its reconcile through `ListMergeQueuePort` (KS7b replaced the
 * one-way `act merge`), the merge facts (`oneWayDoor`, `policyGrant`), the reconcile of
 * a pre-KS7b `merge` intent by PR state, and the park notices raised through
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
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey, laneRunMergeEnqueueKey, laneRunPremergeKey } from '../../../domain/lane-run-keys.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { MergeQueueEnqueueCommand, MergeQueueListQuery } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { MergeEnqueueDecision } from '../../../domain/merge-queue-operations.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
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
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import { EnqueueMergeUseCase } from '../EnqueueMergeUseCase.use-case.js';
import { MergeQueueRepositoryAdapter } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
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
const REPOSITORY = { owner: 'owner-example', repo: 'repo-example' } as const;
const QUESTION_ID = 'question-example-1';

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

/** The merge-enqueue key at a round and head (no seat index, KS7b). */
function enqueueKey(head12: string = HEAD12, round = 0): string {
  const built = laneRunMergeEnqueueKey(RUN_ID, round, head12);
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a merge-enqueue key');
  }
  return built.key;
}

/** A queue entry for the run's PR at the collected head; overrides set its state, ids and links. */
function queueEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  const merged = overrides.state === 'merged';
  return {
    version: 1,
    entryId: '01JB00000000000000000000EN',
    repository: REPOSITORY,
    repoDigest: '0'.repeat(12),
    pullRequest: 7,
    headOid: COMMIT,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: NOW,
    enqueuedBy: 'conductor',
    supersedes: null,
    runId: RUN_ID,
    attemptId: null,
    workOrderId: null,
    tier: 2,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: merged ? COMMIT : null,
    mergedAtIso: merged ? LATER : null,
    revision: 1,
    ...overrides,
  };
}

/** The premerge key at a head (no seat index, KS7a-2). */
function premergeKey(head12: string = HEAD12): string {
  const built = laneRunPremergeKey(RUN_ID, 0, head12);
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a premerge key');
  }
  return built.key;
}

/** Append a completed premerge-success intent and result at a head (KS7a-2): the merge hold is posted. */
async function appendPremergeSuccess(harness: Harness, head12: string = HEAD12): Promise<void> {
  const key = premergeKey(head12);
  await appendIntent(harness, key, 'forge-01JB00000000000000000000', NOW);
  await appendResult(harness, key, 'completed', 'premerge-success', NOW);
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  /** KS7b: every `enqueue` request the fake queue saw, in order. */
  readonly enqueueRequests: readonly MergeQueueEnqueueCommand[];
  /** KS7b: every `list` query the fake queue saw, in order. */
  readonly queueQueries: readonly MergeQueueListQuery[];
  /** KS7b: the fake queue's entries; tests change their state in place. */
  readonly queue: MergeQueueEntryRecord[];
  readonly recordParkAttentionCalls: readonly LaneRunParkRequest[];
  readonly askParkQuestionCalls: readonly LaneRunParkRequest[];
  readonly forgeReadRequests: readonly ReadPullRequestRequest[];
  readonly ancestryRequests: readonly ContainsCommitRequest[];
  readonly portCalls: readonly string[];
  readonly deps: AdvanceLaneRunDependencies;
  /** Fix the enqueue answer (undefined restores the faithful fake). */
  setEnqueueAnswer(answer: MergeEnqueueDecision | 'throw' | undefined): void;
  /** Fix the list answer (undefined restores the faithful fake). */
  setListAnswer(answer: readonly MergeQueueEntryRecord[] | 'throw' | undefined | { readonly notAList: true }): void;
  setAttentionAnswer(answer: LaneRunParkNoticeResult | 'throw'): void;
  setQuestionAnswer(answer: LaneRunParkNoticeResult | 'throw'): void;
  setForgeReadAnswer(answer: ReadPullRequestResult | 'throw'): void;
  setAncestryAnswer(answer: ContainsCommitResult | 'throw'): void;
  updateAttempt(attempt: AttemptRecord): Promise<void>;
  addWorkOrder(workOrder: WorkOrderRecord): void;
  /** The work orders the release fake saved, in save order (KF-36a). */
  readonly savedWorkOrders: readonly WorkOrderRecord[];
  /** The KF-36a release fake itself, for RegisterWorkOrderUseCase in tests. */
  readonly workOrderReleaseFake: WorkOrderRepositoryPort;
  workOrderById(workOrderId: string): WorkOrderRecord | null;
  setWorkOrderReleaseRace(mode: 'none' | 'steal-merged' | 'throw-find' | 'bump-approved'): void;
  addOtherRun(options: {
    readonly runId: string;
    readonly workOrderId: string;
    readonly repository: string;
    readonly state: LaneRunStateValue;
  }): Promise<void>;
}

interface HarnessOptions {
  /** Wire the KS7b merge queue (enqueue, list and the forge repository). */
  readonly wireQueue?: boolean;
  readonly wireParkNotice?: boolean;
  readonly wireForgeRead?: boolean;
  readonly wireForgeAncestry?: boolean;
  readonly wireWorkOrder?: boolean;
  /** Wire the KF-36a `workOrderRelease` fake over the harness's work orders map. */
  readonly wireWorkOrderRelease?: boolean;
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

function mergedPullRequestAtHead(number: number, baseRef: string = 'main'): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number,
      state: 'merged',
      mergeState: 'clean',
      headSha: COMMIT,
      headRef: 'wt-example-1',
      baseRef,
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
  const enqueueRequests: MergeQueueEnqueueCommand[] = [];
  const queueQueries: MergeQueueListQuery[] = [];
  const queue: MergeQueueEntryRecord[] = [];
  let enqueueAnswer: MergeEnqueueDecision | 'throw' | undefined;
  let listAnswer: readonly MergeQueueEntryRecord[] | 'throw' | undefined | { readonly notAList: true };
  const recordParkAttentionCalls: LaneRunParkRequest[] = [];
  const askParkQuestionCalls: LaneRunParkRequest[] = [];
  const forgeReadRequests: ReadPullRequestRequest[] = [];
  const ancestryRequests: ContainsCommitRequest[] = [];
  const portCalls: string[] = [];
  const workOrders = new Map<string, WorkOrderRecord>([[WORK_ORDER_ID, makeWorkOrder()]]);
  const autoMergeEnabled = options.autoMergeEnabled ?? true;
  let attentionAnswer: LaneRunParkNoticeResult | 'throw' | undefined;
  let questionAnswer: LaneRunParkNoticeResult | 'throw' | undefined;
  let forgeReadAnswer: ReadPullRequestResult | 'throw' = openPullRequestAtHead(7);
  let ancestryAnswer: ContainsCommitResult | 'throw' = { outcome: 'answered', contains: false };
  const attentionStore = new Map<string, LaneRunParkNoticeResult>();
  const questionStore = new Map<string, LaneRunParkNoticeResult>();
  const savedWorkOrders: WorkOrderRecord[] = [];
  let releaseRace: 'none' | 'steal-merged' | 'throw-find' | 'bump-approved' = 'none';
  // `bump-approved` fires once: another writer bumps the revision (state stays
  // approved) between our find and our first save, so the retry must re-save.
  let bumpApprovedDone = false;
  const workOrderReleaseFake: WorkOrderRepositoryPort = {
    saveWorkOrder: async (record) => {
      const stored = workOrders.get(record.id);
      // Mirror WorkOrderRepositoryAdapter: a stale revision is an error.
      if (stored !== undefined && record.revision <= stored.revision) {
        throw new Error('stale work order revision');
      }
      if (releaseRace === 'steal-merged') {
        // Another writer (markMerged) saves first, then our save is stale.
        workOrders.set(record.id, { ...record, state: 'merged' });
        throw new Error('stale work order revision');
      }
      if (releaseRace === 'bump-approved' && !bumpApprovedDone) {
        // Another writer bumps the stored revision but keeps the state approved,
        // so our first save is stale and the release's retry re-saves.
        bumpApprovedDone = true;
        if (stored !== undefined) {
          workOrders.set(record.id, { ...stored, revision: stored.revision + 1 });
        }
        throw new Error('stale work order revision');
      }
      workOrders.set(record.id, record);
      savedWorkOrders.push(record);
    },
    findWorkOrderById: async (workOrderId) => {
      if (releaseRace === 'throw-find') {
        throw new Error('work order read unavailable');
      }
      return workOrders.get(workOrderId) ?? null;
    },
    listWorkOrdersByProject: async (projectId) =>
      [...workOrders.values()].filter((order) => projectId === undefined || order.projectId === projectId),
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
    // KF-22b: the merge act never touches the acceptance port (the merge facts
    // come from journal rows and the full assessment path). A fake that throws
    // on assessHeadAcceptance pins that. The `premerge` post (KS7a-2) reads the
    // receipts-only assessment for its conductor grant, so assessHeadReceipts
    // answers a pass.
    acceptanceAssessment: {
      assessHeadAcceptance: async () => {
        throw new Error('assessHeadAcceptance must not be called during merge');
      },
      assessHeadReceipts: async (request) => ({
        outcome: 'passed',
        receiptsId: 'rcp-example-1',
        assessedHeadSha: request.candidateHeadSha,
      }),
    },
    // KS7a-2: the pre-merge receipt at the head; a pass releases the merging hold.
    reviewRequest: {
      requestReview: async () => ({ outcome: 'unknown', reason: 'delegate-failed' }),
      findReviewReceipt: async () => ({ outcome: 'not-found' }),
      findLatestReceiptOfKind: async (request) => ({
        outcome: 'found',
        receipt: {
          receiptId: 'pm-example-1',
          requestId: null,
          kind: request.kind,
          reviewerModel: 'reviewer-example-1',
          candidateHeadSha: request.candidateHeadSha,
          verdict: 'passed',
          findings: [],
        },
      }),
    },
    // KS7a-2: the conductor's premerge post (only a moved head posts here; the
    // seeded harness has already posted).
    conductorForgeGrant: {
      issueConductorForgeGrant: async () => ({
        outcome: 'issued',
        grantId: 'grant-conductor-example-1',
        decisionRevision: 'policy:conductor@example',
      }),
    },
    executeForgeAction: {
      executeAuthorizedForgeAction: async (request) => ({
        outcome: 'executed',
        headSha: request.expectedHeadSha,
      }),
    },
    newUlid: makeUlidMinter(),
    autoMergeEnabled,
    ...(options.wireQueue === false
      ? {}
      : {
          forgeRepository: REPOSITORY,
          enqueueMerge: {
            enqueue: async (request: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision> => {
              enqueueRequests.push(request);
              portCalls.push('enqueue');
              if (enqueueAnswer === 'throw') {
                throw new Error('queue unavailable at /home/secret/path');
              }
              if (enqueueAnswer !== undefined) {
                return enqueueAnswer;
              }
              const duplicate = queue.find(
                (entry) => entry.pullRequest === request.pullRequest && entry.headOid === request.headOid &&
                  entry.state !== 'merged' && entry.state !== 'dropped' && entry.state !== 'superseded',
              );
              if (duplicate !== undefined) {
                return { outcome: 'duplicate', entries: [...queue], record: duplicate };
              }
              const record = queueEntry({ entryId: request.entryId, headOid: request.headOid, runId: request.runId });
              queue.push(record);
              return { outcome: 'created', entries: [...queue], record };
            },
          },
          mergeQueue: {
            listMergeEntries: async (query: MergeQueueListQuery): Promise<readonly MergeQueueEntryRecord[]> => {
              queueQueries.push(query);
              portCalls.push('queue-list');
              if (listAnswer === 'throw') {
                throw new Error('queue unreadable at /home/secret/path');
              }
              if (listAnswer !== undefined) {
                return listAnswer as readonly MergeQueueEntryRecord[];
              }
              return [...queue];
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
    ...(options.wireWorkOrderRelease === true
      ? { workOrderRelease: workOrderReleaseFake }
      : {}),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    enqueueRequests,
    queueQueries,
    queue,
    recordParkAttentionCalls,
    askParkQuestionCalls,
    forgeReadRequests,
    ancestryRequests,
    portCalls,
    deps,
    setEnqueueAnswer: (answer) => {
      enqueueAnswer = answer;
    },
    setListAnswer: (answer) => {
      listAnswer = answer;
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
    savedWorkOrders,
    workOrderReleaseFake,
    workOrderById: (workOrderId) => workOrders.get(workOrderId) ?? null,
    setWorkOrderReleaseRace: (mode) => {
      releaseRace = mode;
      bumpApprovedDone = false;
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
async function mergingHarness(options: HarnessOptions = {}, record: LaneRunRecord = runRecord({ prNumber: 7 })): Promise<Harness> {
  const harness = await makeHarness(record, [collectedAttempt()], {
    wireForgeRead: true,
    wireWorkOrder: true,
    wireQueue: true,
    ...options,
  });
  await conduct(harness, 'merging', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  // KS7a-2: the merging hold is already released (premerge success posted); the
  // merge tail is what these tests exercise.
  await appendPremergeSuccess(harness);
  return harness;
}

describe('AdvanceLaneRunUseCase merge act and merge facts (K6-7)', () => {
  it('test 3: a port off with autoMergeEnabled false parks owner-merge before any enqueue and raises attention and a keyed question', async () => {
    const harness = await mergingHarness({ autoMergeEnabled: false, wireParkNotice: true });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
    expect(harness.enqueueRequests).toEqual([]);
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.recordParkAttentionCalls[0]).toMatchObject({
      key: RUN_ID + '/park@1',
      projectId: PROJECT_ID,
      workOrderId: WORK_ORDER_ID,
      runId: RUN_ID,
      reason: 'owner-merge',
      parkCount: 1,
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
      wireQueue: false,
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
      wireQueue: false,
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

  it('test 7: a crash after a pre-KS7b merge intent reconciles by PR state; the queue is never asked', async () => {
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
    expect(merged.enqueueRequests).toHaveLength(0);

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
    expect(open.enqueueRequests).toHaveLength(0);
    // The refused merge is the state's step: the next advance parks step-refused merge.
    expect(await advance(open)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge' });
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
});

/** A `merging` run on PR 7 whose queue is wired (KS7b); the premerge hold is already released. */
async function queueHarness(options: HarnessOptions = {}, record: LaneRunRecord = runRecord({ prNumber: 7 })): Promise<Harness> {
  return mergingHarness(options, record);
}

async function journalOf(harness: Harness) {
  return harness.runJournal.listForRun(RUN_ID);
}

async function resultsOf(harness: Harness, key: string) {
  return (await journalOf(harness)).filter((entry) => entry.kind === 'result' && entry.key === key);
}

describe('AdvanceLaneRunUseCase merge-enqueue (KS7b)', () => {
  it('enqueues the PR head once under a keyed intent whose minted id is the queue entry, then waits', async () => {
    const harness = await queueHarness();
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(harness.enqueueRequests).toHaveLength(1);
    const request = harness.enqueueRequests[0]!;
    expect(request).toMatchObject({
      repository: REPOSITORY,
      pullRequest: 7,
      headOid: COMMIT,
      tier: 2,
      enqueuedBy: 'conductor',
      runId: RUN_ID,
      enqueuedAtIso: LATER,
    });
    const entries = await journalOf(harness);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === enqueueKey());
    expect(intents).toHaveLength(1);
    expect(intents[0]!.mintedId).toBe(request.entryId);
    // A queued entry appends no result: the intent stays open and the queue holds the entry.
    expect(await resultsOf(harness, enqueueKey())).toEqual([]);
    expect(harness.queue).toHaveLength(1);
    expect(harness.queue[0]!.entryId).toBe(request.entryId);
  });

  it('is idempotent: later advances read the queue and never enqueue or journal again while the entry is live', async () => {
    const harness = await queueHarness();
    await advance(harness);
    const before = (await journalOf(harness)).length;
    for (const state of ['queued', 'updating', 'awaiting-checks', 'ready', 'verifying', 'vetoing', 'merging'] as const) {
      harness.queue[0] = { ...harness.queue[0]!, state };
      expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    }
    expect(harness.enqueueRequests).toHaveLength(1);
    expect((await journalOf(harness)).length).toBe(before);
  });

  it('a crash between the intent and the enqueue is recovered: the reconcile enqueues the same entry id', async () => {
    const harness = await queueHarness();
    await appendIntent(harness, enqueueKey(), 'MINTED00000000000000000001', NOW);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(harness.enqueueRequests).toHaveLength(1);
    expect(harness.enqueueRequests[0]!.entryId).toBe('MINTED00000000000000000001');
    const intents = (await journalOf(harness)).filter((entry) => entry.kind === 'intent' && entry.key === enqueueKey());
    expect(intents).toHaveLength(1);
  });

  it('a throwing enqueue leaves the intent open and the next advance asks again under the same entry id', async () => {
    const harness = await queueHarness();
    harness.setEnqueueAnswer('throw');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(await resultsOf(harness, enqueueKey())).toEqual([]);
    harness.setEnqueueAnswer(undefined);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(harness.enqueueRequests).toHaveLength(2);
    expect(harness.enqueueRequests[1]!.entryId).toBe(harness.enqueueRequests[0]!.entryId);
    // No secret or path from the thrown error reaches the journal.
    expect(JSON.stringify(await journalOf(harness))).not.toContain('/home/secret');
  });

  it('a typed enqueue refusal journals a refused result with a closed token and parks step-refused merge-enqueue', async () => {
    const harness = await queueHarness();
    harness.setEnqueueAnswer({ outcome: 'refused', reason: 'invalid-head' });
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'merge-enqueue', key: enqueueKey(), result: 'refused', reasonCode: 'merge-enqueue-refused', detail: 'invalid-head',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge-enqueue' });
    expect(harness.enqueueRequests).toHaveLength(1);
  });

  it('a refusal or answer of the wrong shape never throws and never echoes its text', async () => {
    const wrongReason = await queueHarness();
    wrongReason.setEnqueueAnswer({ outcome: 'refused', reason: '/home/secret/path' } as unknown as MergeEnqueueDecision);
    const result = await advance(wrongReason);
    expect(result).toMatchObject({ outcome: 'acted', reasonCode: 'merge-enqueue-refused', detail: 'unknown' });
    expect(JSON.stringify(await journalOf(wrongReason))).not.toContain('/home/secret');

    const junk = await queueHarness();
    junk.setEnqueueAnswer(42 as unknown as MergeEnqueueDecision);
    expect(await advance(junk)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(await resultsOf(junk, enqueueKey())).toEqual([]);
  });

  it('a merged entry journals merged; the run enters merged only once the forge reads the PR merged', async () => {
    const harness = await queueHarness();
    await advance(harness);
    harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'merged' });
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'merge-enqueue', key: enqueueKey(), result: 'completed', reasonCode: 'merged', detail: null,
    });
    // The forge still reads the PR open: waiting, never merged on the queue's word alone.
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(await advance(harness)).toEqual({ outcome: 'done' });
  });

  it('the forge reading the PR merged ends the run even while the enqueue intent is still open', async () => {
    const harness = await queueHarness();
    await advance(harness);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
  });

  it.each(['conflict', 'checks', 'macos'] as const)('a queue drop for %s with a round left maps to fixing', async (reason) => {
    const harness = await queueHarness();
    await advance(harness);
    harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'dropped', reason });
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'merge-enqueue', key: enqueueKey(), result: 'completed', reasonCode: 'merge-dropped', detail: reason,
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'fixing' });
  });

  it('a queue drop with no round left parks blocker-after-round-2', async () => {
    const harness = await queueHarness({}, runRecord({ prNumber: 7, round: 2, attemptIds: ['attempt-r0', 'attempt-r1', 'attempt-example-1'] }));
    await advance(harness);
    harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'dropped', reason: 'checks' });
    await advance(harness);
    expect(await advance(harness)).toMatchObject({ outcome: 'parked', reason: 'blocker-after-round-2' });
    expect(await resultsOf(harness, enqueueKey(HEAD12, 2))).toHaveLength(1);
  });

  it('a drop is deterministic: the same answer maps to the same state on every replay', async () => {
    const outcomes: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const harness = await queueHarness();
      await advance(harness);
      harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'dropped', reason: 'conflict' });
      outcomes.push([await advance(harness), await advance(harness)]);
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it.each(['forge-error-exhausted', 'operator-dropped', 'closed'] as const)('a queue drop for %s parks step-refused merge-enqueue', async (reason) => {
    const harness = await queueHarness();
    await advance(harness);
    harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'dropped', reason });
    expect(await advance(harness)).toMatchObject({ reasonCode: 'merge-dropped', detail: reason });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge-enqueue' });
  });

  it('a drop with an unknown reason token journals the closed token unknown and parks, never merged', async () => {
    const harness = await queueHarness();
    await advance(harness);
    harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'dropped', reason: '/home/secret/key' });
    expect(await advance(harness)).toMatchObject({ reasonCode: 'merge-dropped', detail: 'unknown' });
    expect(JSON.stringify(await journalOf(harness))).not.toContain('/home/secret');
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge-enqueue' });
  });

  it('a queue entry parked for veto-hold maps to the owner-merge park', async () => {
    const harness = await queueHarness({ wireParkNotice: true });
    await advance(harness);
    harness.queue[0] = queueEntry({ entryId: harness.queue[0]!.entryId, state: 'parked', reason: 'veto-hold' });
    expect(await advance(harness)).toMatchObject({ reasonCode: 'merge-held', detail: 'veto-hold' });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'owner-merge', qualifier: null });
  });

  it('other queue parks wait for the queue; they never map to the run', async () => {
    const harness = await queueHarness();
    await advance(harness);
    for (const reason of ['conflict', 'checks', 'threads', 'premerge', 'macos', 'forge-error', 'update-refused', 'owner-merge'] as const) {
      harness.queue[0] = { ...harness.queue[0]!, state: 'parked', reason };
      expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    }
    expect(await resultsOf(harness, enqueueKey())).toEqual([]);
  });

  it('an unreadable, absent or wrongly shaped queue answer waits and never reaches merged', async () => {
    const harness = await queueHarness();
    await advance(harness);
    harness.setListAnswer('throw');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setListAnswer({ notAList: true });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setListAnswer([null, 7, { entryId: 5, state: 'merged' }, { repository: REPOSITORY, pullRequest: 7, entryId: harness.queue[0]!.entryId, state: 'nonsense', headOid: COMMIT, reason: null, supersedes: null }] as unknown as MergeQueueEntryRecord[]);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(await resultsOf(harness, enqueueKey())).toEqual([]);
    expect(harness.queue).toHaveLength(1);
  });

  it('an entry for another pull request or repository is ignored', async () => {
    const harness = await queueHarness();
    await advance(harness);
    harness.setListAnswer([
      queueEntry({ entryId: harness.queue[0]!.entryId, state: 'merged', pullRequest: 8 }),
      queueEntry({ entryId: harness.queue[0]!.entryId, state: 'merged', repository: { owner: 'other-owner', repo: 'repo-example' } }),
    ]);
    // Neither is the run's: the reconcile asks the queue to enqueue again (the same id) and waits.
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(await resultsOf(harness, enqueueKey())).toEqual([]);
  });

  it('follows a superseded entry to its successor and reads the successor state', async () => {
    const harness = await queueHarness();
    await advance(harness);
    const first = harness.queue[0]!;
    harness.queue[0] = queueEntry({ entryId: first.entryId, state: 'superseded' });
    harness.queue.push(queueEntry({ entryId: '01JB00000000000000000000SU', supersedes: first.entryId, headOid: MOVED_COMMIT, state: 'dropped', reason: 'conflict' }));
    expect(await advance(harness)).toMatchObject({ reasonCode: 'merge-dropped', detail: 'conflict' });
    // A superseded entry whose successor is unknown is still the queue's: wait.
    const waiting = await queueHarness();
    await advance(waiting);
    waiting.queue[0] = queueEntry({ entryId: waiting.queue[0]!.entryId, state: 'superseded' });
    expect(await advance(waiting)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(await resultsOf(waiting, enqueueKey())).toEqual([]);
  });

  it('a live duplicate that someone else enqueued at the head is followed; the run never creates a second entry', async () => {
    const harness = await queueHarness();
    harness.queue.push(queueEntry({ entryId: '01JB00000000000000000000DU' }));
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(harness.queue).toHaveLength(1);
    // The foreign duplicate is the queue's while it is live: no second enqueue and no result.
    expect(harness.enqueueRequests).toHaveLength(1);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(harness.enqueueRequests).toHaveLength(1);
    // Once the foreign entry is gone the hand-off is the run's again: one enqueue under its own id.
    harness.queue[0] = { ...harness.queue[0]!, state: 'dropped', reason: 'checks' };
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(harness.enqueueRequests).toHaveLength(2);
    expect(harness.queue).toHaveLength(2);
    expect(harness.queue[1]!.entryId).toBe(harness.enqueueRequests[1]!.entryId);
  });

  it('a moved head overtakes the open hand-off; the new head is a new key', async () => {
    const harness = await queueHarness();
    await advance(harness);
    await harness.updateAttempt(collectedAttempt({
      revision: 1,
      artifacts: { ...COLLECTED_ARTIFACTS, headCommit: MOVED_COMMIT },
    }));
    await appendIntent(harness, stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: MOVED_HEAD12 }), null, LATER);
    await appendResult(harness, stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: MOVED_HEAD12 }), 'completed', 'accepted', LATER);
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: { ...(openPullRequestAtHead(7) as { pullRequest: object }).pullRequest, headSha: MOVED_COMMIT } as never,
    });
    expect(await advance(harness)).toMatchObject({ step: 'merge-enqueue', result: 'overtaken', reasonCode: 'merge-overtaken' });
  });

  it('without the queue wiring the step is not-wired and nothing is journalled', async () => {
    const harness = await queueHarness({ wireQueue: false });
    expect(await advance(harness)).toEqual({ outcome: 'not-wired', step: 'merge-enqueue' });
    expect((await journalOf(harness)).filter((entry) => entry.key === enqueueKey())).toEqual([]);
  });

  it('a run without a recorded PR number waits instead of enqueueing a guess', async () => {
    const harness = await queueHarness({}, runRecord({ prNumber: null }));
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
    expect(harness.enqueueRequests).toEqual([]);
  });

  it('under a halt nothing is enqueued and a pending hand-off parks halted', async () => {
    const harness = await queueHarness();
    await advance(harness);
    expect(await advance(harness, { halted: true })).toMatchObject({ outcome: 'parked', reason: 'halted' });
    expect(harness.enqueueRequests).toHaveLength(1);
  });

  it('over the real queue adapter a terminal entry stays readable: an operator drop reaches the run, a live entry is never re-enqueued', async () => {
    const harness = await queueHarness();
    const queue = new MergeQueueRepositoryAdapter();
    // The real adapter checks deadlines against the wall clock; the harness's clock is fixed in 2026-10, so
    // the wrappers move only the deadline to the wall clock and pass everything else through.
    const future = () => new Date(Date.now() + 60_000).toISOString();
    const real = new EnqueueMergeUseCase({ queue });
    const deps: AdvanceLaneRunDependencies = {
      ...harness.deps,
      enqueueMerge: { enqueue: (request) => real.enqueue({ ...request, deadlineIso: future() }) },
      mergeQueue: { listMergeEntries: (query) => queue.listMergeEntries({ ...query, deadlineIso: future() }) },
    };
    const run = () => new AdvanceLaneRunUseCase(deps).advanceLaneRun({
      runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, halted: false, nowIso: LATER,
    });
    expect(await run()).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    const live = await queue.listMergeEntries({ deadlineIso: new Date(Date.now() + 60_000).toISOString() });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ state: 'queued', pullRequest: 7, runId: RUN_ID, enqueuedBy: 'conductor' });
    // Still live: read, not enqueued again.
    expect(await run()).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    expect(await queue.listMergeEntries({ deadlineIso: new Date(Date.now() + 60_000).toISOString() })).toHaveLength(1);
    const dropped = await queue.dropMergeEntry({ entryId: live[0]!.entryId, deadlineIso: new Date(Date.now() + 60_000).toISOString() });
    expect(dropped.outcome).toBe('dropped');
    expect(await run()).toMatchObject({ outcome: 'acted', reasonCode: 'merge-dropped', detail: 'operator-dropped' });
    expect(await run()).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge-enqueue' });
    expect(await queue.listMergeEntries({ deadlineIso: new Date(Date.now() + 60_000).toISOString() })).toHaveLength(1);
  });

  it('a journal written before KS7b still replays: the old one-way merge key parses and its intent reconciles', async () => {
    // A recorded pre-KS7b merging journal: accept, premerge and an open `merge` intent.
    const harness = await queueHarness();
    await appendIntent(harness, mergeKey(), null, NOW);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({
      outcome: 'acted', step: 'merge', key: mergeKey(), result: 'completed', reasonCode: 'merged',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.enqueueRequests).toEqual([]);
    const open = await queueHarness();
    await appendIntent(open, mergeKey(), null, NOW);
    expect(await advance(open)).toEqual({
      outcome: 'acted', step: 'merge', key: mergeKey(), result: 'refused', reasonCode: 'merge-not-merged',
    });
    expect(open.enqueueRequests).toEqual([]);
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
  // A base commit distinct from the collected head pins the ancestry request's
  // ancestor to the COLLECTED head, never the attempt's base.
  const harness = await makeHarness(parkedRecord, [collectedAttempt({ baseCommit: 'd'.repeat(40) })], {
    wireForgeRead: true,
    wireWorkOrder: true,
    wireQueue: false,
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

  it('test (a2): in merging, a merged PR at another head enters merged on contains: true and parks ambiguous merge on false or a throw (CT-2b Fable)', async () => {
    const contained = await mergingHarness();
    contained.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
    contained.setAncestryAnswer({ outcome: 'answered', contains: true });
    expect(await advance(contained)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(contained.ancestryRequests).toEqual([{ ancestorSha: COMMIT, descendantSha: MOVED_COMMIT }]);

    for (const answer of [{ outcome: 'answered', contains: false } as const, 'throw' as const]) {
      const harness = await mergingHarness();
      harness.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
      harness.setAncestryAnswer(answer);
      expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'merge' });
      expect(harness.ancestryRequests).toHaveLength(1);
    }
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
    const harness = await mergingHarness({ wireParkNotice: true }, runRecord({ prNumber: 7 }));
    harness.setEnqueueAnswer({ outcome: 'refused', reason: 'invalid-head' });
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', reasonCode: 'merge-enqueue-refused' });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'merge-enqueue' });
    expect(harness.recordParkAttentionCalls).toHaveLength(1);
    expect(harness.askParkQuestionCalls).toHaveLength(0);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
    // The repeat answers `exists` under the same key; one call per advance.
    expect(harness.recordParkAttentionCalls).toHaveLength(2);
    expect(harness.recordParkAttentionCalls[1].key).toBe(RUN_ID + '/park@1');
    expect(harness.askParkQuestionCalls).toHaveLength(0);
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

describe('AdvanceLaneRunUseCase work-order release at the run end (KF-36a)', () => {
  function makeReleaseRequest(): Parameters<RegisterWorkOrderUseCase['registerWorkOrder']>[0] {
    return {
      workOrderId: 'wo-example-2',
      projectId: PROJECT_ID,
      taskId: 'task-example-2',
      laneId: 'lane-example',
      repository: 'repo-example',
      baseCommit: COMMIT,
      ownedPaths: ['src/example.ts/neighbor.ts'],
      policyRevision: 'policy-example-1',
      nowIso: LATER,
    };
  }

  it('entering merged saves the work order merged at revision + 1 and frees its paths for a new registration', async () => {
    const harness = await mergingHarness({ wireWorkOrderRelease: true });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(1);
    expect(harness.savedWorkOrders[0]).toMatchObject({
      id: WORK_ORDER_ID,
      state: 'merged',
      revision: 2,
      updatedAtIso: LATER,
    });
    // The released paths are free: a new work order owning an overlapping path registers.
    const register = new RegisterWorkOrderUseCase({ workOrderRepo: harness.workOrderReleaseFake });
    expect(await register.registerWorkOrder(makeReleaseRequest())).toMatchObject({ outcome: 'registered' });
  });

  it('the owner-merge park exit (CT-2a) releases the work order too', async () => {
    const harness = await ownerMergeParkedHarness({ wireWorkOrderRelease: true });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(1);
    expect(harness.savedWorkOrders[0]).toMatchObject({ id: WORK_ORDER_ID, state: 'merged', revision: 2 });
  });

  it('with workOrderRelease absent the work order is left as it is', async () => {
    const harness = await mergingHarness();
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(0);
    expect(harness.workOrderById(WORK_ORDER_ID)).toMatchObject({ state: 'ready-to-merge', revision: 1 });
  });

  it('a stale save whose re-read shows merged makes no second save and the run still enters merged', async () => {
    const harness = await mergingHarness({ wireWorkOrderRelease: true });
    harness.setWorkOrderReleaseRace('steal-merged');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    // The other writer's merged save stands; the release never saved a second revision.
    expect(harness.savedWorkOrders).toHaveLength(0);
    expect(harness.workOrderById(WORK_ORDER_ID)).toMatchObject({ state: 'merged' });
  });

  it('a throwing work-order read never blocks the run and leaves the work order unchanged', async () => {
    const harness = await mergingHarness({ wireWorkOrderRelease: true });
    harness.setWorkOrderReleaseRace('throw-find');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(0);
    expect(harness.workOrderById(WORK_ORDER_ID)).toMatchObject({ state: 'ready-to-merge', revision: 1 });
  });

  it('another non-terminal run of the same work order blocks the release (no save)', async () => {
    const harness = await mergingHarness({ wireWorkOrderRelease: true });
    const other = await harness.runRepo.create(runRecord({ runId: OTHER_RUN_ID, workOrderId: WORK_ORDER_ID }));
    expect(other.outcome).toBe('saved');
    const otherConduct = laneRunConductEntry(harness.deps.newUlid(), OTHER_RUN_ID, 'gating', NOW);
    expect((await harness.runJournal.append(otherConduct)).outcome).toBe('appended');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(0);
    expect(harness.workOrderById(WORK_ORDER_ID)).toMatchObject({ state: 'ready-to-merge', revision: 1 });
  });

  it('a terminal sibling run on the same work order never blocks the release (KF-36a-1 Fable minor 1)', async () => {
    const harness = await mergingHarness({ wireWorkOrderRelease: true });
    await harness.addOtherRun({ runId: OTHER_RUN_ID, workOrderId: WORK_ORDER_ID, repository: 'repo-example', state: 'stopped' });
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(1);
    expect(harness.savedWorkOrders[0]).toMatchObject({
      id: WORK_ORDER_ID,
      state: 'merged',
      revision: 2,
      updatedAtIso: LATER,
    });
  });

  it('a race that bumps the stored revision but keeps it approved retries into the merged save (KF-36a-1 Fable minor 3)', async () => {
    const harness = await mergingHarness({ wireWorkOrderRelease: true });
    harness.setWorkOrderReleaseRace('bump-approved');
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'merge-train' });
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(harness.savedWorkOrders).toHaveLength(1);
    expect(harness.savedWorkOrders[0]).toMatchObject({
      id: WORK_ORDER_ID,
      state: 'merged',
      revision: 3,
      updatedAtIso: LATER,
    });
  });
});

describe('AdvanceLaneRunUseCase merged-PR leaves branch-behind and ambiguous open-pr parks (G3f, R4b)', () => {
  /** A parked run whose PR is read by branch while parked (R4a), journalled as parked. */
  function parkedForgeHarness(
    parked: NonNullable<LaneRunRecord['parked']>,
    options: HarnessOptions = {},
    prNumber: number | null = null,
  ): Promise<Harness> {
    return (async () => {
      const parkedRecord = runRecord({ parked, parkCount: 1, prNumber });
      const harness = await makeHarness(parkedRecord, [collectedAttempt()], {
        wireForgeRead: true,
        wireWorkOrder: true,
        wireQueue: false,
        ...options,
      });
      await conduct(harness, 'merging', NOW);
      await appendIntent(harness, acceptKey(), null, NOW);
      await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
      await conduct(harness, 'parked', NOW);
      return harness;
    })();
  }

  const BRANCH_BEHIND_PARK: NonNullable<LaneRunRecord['parked']> = {
    reason: 'branch-behind', qualifier: null, parkedFrom: 'merging', questionId: null,
  };
  const AMBIGUOUS_OPEN_PR_PARK: NonNullable<LaneRunRecord['parked']> = {
    reason: 'ambiguous', qualifier: 'open-pr', parkedFrom: 'opening-pr', questionId: null,
  };

  async function openPrIntents(harness: Harness): Promise<string[]> {
    const entries = await harness.runJournal.listForRun(RUN_ID);
    return entries
      .filter((entry) => entry.kind === 'intent' && entry.key !== null && entry.key.includes('/open-pr/'))
      .map((entry) => entry.key as string);
  }

  it('test G3f-1: a branch-behind park enters merged once its PR merges with the lane head; no intent, no result appended', async () => {
    const harness = await parkedForgeHarness(BRANCH_BEHIND_PARK);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'merged')).toBe(true);
    expect(entries.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
    expect(await openPrIntents(harness)).toEqual([]);
    expect(harness.forgeReadRequests).toHaveLength(1);
    expect(harness.forgeReadRequests[0]?.ref.kind).toBe('branch');
  });

  it('test G3f-2: an ambiguous open-pr park enters merged once its PR merges with the lane head; no intent, no result appended', async () => {
    const harness = await parkedForgeHarness(AMBIGUOUS_OPEN_PR_PARK);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'merged')).toBe(true);
    expect(entries.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
    expect(await openPrIntents(harness)).toEqual([]);
    expect(harness.forgeReadRequests).toHaveLength(1);
    expect(harness.forgeReadRequests[0]?.ref.kind).toBe('branch');
  });

  it('test G3f-3: a merged PR at another head that does not carry the lane head keeps both parks', async () => {
    for (const parked of [BRANCH_BEHIND_PARK, AMBIGUOUS_OPEN_PR_PARK]) {
      const harness = await parkedForgeHarness(parked);
      harness.setForgeReadAnswer(mergedPullRequestAtOtherHead(7));
      harness.setAncestryAnswer({ outcome: 'answered', contains: false });
      expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
      const record = await harness.runRepo.get(RUN_ID);
      expect(record?.parked).not.toBeNull();
      expect(harness.forgeReadRequests).toHaveLength(1);
      expect(await openPrIntents(harness)).toEqual([]);
    }
  });

  it('same head, merged, another base: stays parked', async () => {
    for (const parked of [BRANCH_BEHIND_PARK, AMBIGUOUS_OPEN_PR_PARK]) {
      const harness = await parkedForgeHarness(parked);
      harness.setForgeReadAnswer(mergedPullRequestAtHead(7, 'chain/other'));
      expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
      const record = await harness.runRepo.get(RUN_ID);
      expect(record?.parked).not.toBeNull();
      expect(harness.forgeReadRequests).toHaveLength(1);
      expect(await openPrIntents(harness)).toEqual([]);
    }
  });

  it('test G3f-4: fail-closed forge reads keep the parks with prNumber unchanged and no journal write', async () => {
    for (const parked of [BRANCH_BEHIND_PARK, AMBIGUOUS_OPEN_PR_PARK]) {
      // Not-found and the ambiguous two-PR read (resolves to no PR fact) stay parked.
      for (const answer of [
        { outcome: 'not-found' } as const,
        { outcome: 'unavailable', reason: 'multiple pull requests match the branch' } as const,
      ]) {
        const harness = await parkedForgeHarness(parked, {}, 7);
        const entriesBefore = await harness.runJournal.listForRun(RUN_ID);
        harness.setForgeReadAnswer(answer);
        expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
        const record = await harness.runRepo.get(RUN_ID);
        expect(record?.parked).not.toBeNull();
        expect(record?.prNumber).toBe(7);
        const entriesAfter = await harness.runJournal.listForRun(RUN_ID);
        expect(entriesAfter).toEqual(entriesBefore);
        expect(await openPrIntents(harness)).toEqual([]);
      }
      // A throwing read stays parked too.
      const thrown = await parkedForgeHarness(parked, {}, 7);
      const thrownEntriesBefore = await thrown.runJournal.listForRun(RUN_ID);
      thrown.setForgeReadAnswer('throw');
      expect(await advance(thrown)).toEqual({ outcome: 'waiting', reason: 'parked' });
      const thrownRecord = await thrown.runRepo.get(RUN_ID);
      expect(thrownRecord?.parked).not.toBeNull();
      expect(thrownRecord?.prNumber).toBe(7);
      expect(await thrown.runJournal.listForRun(RUN_ID)).toEqual(thrownEntriesBefore);
      expect(await openPrIntents(thrown)).toEqual([]);
    }
  });

  it('test G3f-5: no advance of a parked run ever issues open-pr; a spent-key run advancing twice emits none', async () => {
    for (const parked of [BRANCH_BEHIND_PARK, AMBIGUOUS_OPEN_PR_PARK]) {
      const harness = await parkedForgeHarness(parked);
      harness.setForgeReadAnswer({ outcome: 'not-found' });
      expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
      expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'parked' });
      expect(await openPrIntents(harness)).toEqual([]);
      const entries = await harness.runJournal.listForRun(RUN_ID);
      expect(entries.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
      expect(entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
      expect(harness.forgeReadRequests).toHaveLength(2);
    }
  });

  it('test G3f-6: after entering merged the next advance is done with no port calls; a still-parked rerun re-reads and re-decides, never open-pr', async () => {
    const harness = await parkedForgeHarness(BRANCH_BEHIND_PARK);
    harness.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'merged' });
    const readsAfterEnter = harness.forgeReadRequests.length;
    const callsAfterEnter = harness.portCalls.length;
    expect(await advance(harness)).toEqual({ outcome: 'done' });
    expect(harness.forgeReadRequests).toHaveLength(readsAfterEnter);
    expect(harness.portCalls).toHaveLength(callsAfterEnter);

    // A pass that does not enter leaves the run parked; the next pass re-reads
    // and re-decides, and open-pr is never emitted.
    const again = await parkedForgeHarness(AMBIGUOUS_OPEN_PR_PARK);
    again.setForgeReadAnswer({ outcome: 'not-found' });
    expect(await advance(again)).toEqual({ outcome: 'waiting', reason: 'parked' });
    again.setForgeReadAnswer(mergedPullRequestAtHead(7));
    expect(await advance(again)).toEqual({ outcome: 'entered', state: 'merged' });
    expect(again.forgeReadRequests).toHaveLength(2);
    expect(await openPrIntents(again)).toEqual([]);
  });
});
