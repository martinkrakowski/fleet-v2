/**
 * Unit tests for K4-6: the conductor acts `stop` (a timeout and a forced run
 * stop mapped by the plan's §3.8 table), `collect` (with the edit-only commit
 * step first for an agy attempt) and `gate` (the typed verdict). Each writes
 * its keyed intent, performs the one external action and appends its result; a
 * refused stop is never read from its text. Every store is in-memory; no
 * runner, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type {
  AttemptRecord,
  CollectedAttemptArtifacts,
  CommandCompletionReceipt,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey, laneRunStopForceKey, laneRunStopKey } from '../../../domain/lane-run-keys.js';
import type { LaneDiffFinding } from '../../../domain/lane-diff-check.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import type {
  StopAttemptRequest,
  StopAttemptResult,
} from '../../ports/in/StopAttemptPort.in-port.js';
import type {
  CollectAttemptArtifactsRequest,
  CollectAttemptArtifactsResult,
} from '../../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type {
  CommitEditOnlyAttemptRequest,
  CommitEditOnlyAttemptResult,
} from '../../ports/in/CommitEditOnlyAttemptPort.in-port.js';
import type {
  EvaluateAttemptGateRequest,
  EvaluateAttemptGateResult,
} from '../../ports/in/EvaluateAttemptGatePort.in-port.js';
import type {
  OpenReviewAssessmentRequest,
  OpenReviewAssessmentResult,
} from '../../ports/out/ReviewAssessmentPort.out-port.js';
import type {
  RecordGateReceiptsRequest,
  RecordGateReceiptsResult,
} from '../../ports/out/GateReceiptPort.out-port.js';
import type { GatePredicatePort, EvaluateGatePredicatesResult } from '../../ports/out/GatePredicatePort.out-port.js';
import type { GatePredicateResult } from '../../ports/out/GatePredicatePort.out-port.js';
import { RequestAttemptAcceptanceUseCase } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const EXPIRED = '2026-10-27T11:00:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const SHA = 'c'.repeat(64);
const HEAD12 = 'a'.repeat(12);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const DISPATCHED_AT = '2026-10-27T09:10:00.000Z';

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

const AGY_RUNNER = {
  kind: 'agy' as const,
  remotePort: null,
  host: null,
  hostName: 'lane-host',
  agent: 'agy-agent',
  model: 'model-example-1',
  variant: null,
};

/** The recorded host of a conducted opencode attempt (KF-10/Q2a-2 invariant). */
const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: 'model-example-1',
  variant: null,
};

const WORK_ORDER_FIXTURE: WorkOrderRecord = {
  id: 'wo-example-1',
  projectId: 'project-example-1',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'repo-example-1',
  baseCommit: COMMIT,
  ownedPaths: ['src'],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'approved',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
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
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function receipt(overrides: Partial<CommandCompletionReceipt> = {}): CommandCompletionReceipt {
  return {
    attemptId: 'attempt-example-1',
    sessionId: 'session-example-1',
    endedAtIso: LATER,
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
    ...overrides,
  };
}

function endedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return attemptFixture({
    state: 'ended',
    sessionId: 'session-example-1',
    completionReceipt: receipt(),
    ...overrides,
  });
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
  readonly step: 'dispatch' | 'stop' | 'collect' | 'gate' | 'prepare';
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

function dispatchKey(): string {
  return stepKey({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null });
}

function stopKey(): string {
  return stepKey({ round: 0, step: 'stop', seatIndex: 0, attemptOrdinal: null, head12: null });
}

function retryStopKey(retry: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'stop',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: null,
    retry,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a retry stop key');
  }
  return built.key;
}

function collectKey(): string {
  return stepKey({ round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: null, head12: null });
}

function gateKey(): string {
  return stepKey({ round: 0, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

function activeAnswer(attempt: AttemptRecord): ReconcileAttemptResult {
  return {
    outcome: 'active',
    attempt,
    status: {
      runnerReachable: 'reachable',
      workspacePreparation: 'prepared',
      workerCommand: 'active',
      completionReceipt: null,
      artifactsCollected: false,
    },
  };
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly stopRequests: readonly StopAttemptRequest[];
  readonly collectRequests: readonly CollectAttemptArtifactsRequest[];
  readonly commitRequests: readonly CommitEditOnlyAttemptRequest[];
  readonly gateRequests: readonly EvaluateAttemptGateRequest[];
  readonly callOrder: string[];
  readonly deps: AdvanceLaneRunDependencies;
  readonly reviewOpenRequests: readonly OpenReviewAssessmentRequest[];
  readonly gateReceiptRequests: readonly RecordGateReceiptsRequest[];
  /** The harness's work-order store (KF-36a-2); seeded with a copy of the fixture. */
  readonly workOrders: Map<string, WorkOrderRecord>;
  setManifest(json: string | null): void;
  setManifestVerdict(verdict: 'sealed' | 'missing' | 'mismatch'): void;
  setReconcileAnswer(answer: ReconcileAttemptResult): void;
  setStopAnswer(answer: (request: StopAttemptRequest) => Promise<StopAttemptResult>): void;
  setCollectAnswer(answer: (request: CollectAttemptArtifactsRequest) => Promise<CollectAttemptArtifactsResult>): void;
  setCommitAnswer(answer: CommitEditOnlyAttemptResult): void;
  setGateAnswer(answer: EvaluateAttemptGateResult): void;
  setReviewAssessmentAnswer(answer: OpenReviewAssessmentResult): void;
  setGateReceiptsAnswer(answer: RecordGateReceiptsResult): void;
}

interface HarnessOptions {
  readonly ceiling?: number;
  readonly wireStop?: boolean;
  readonly wireCollect?: boolean;
  readonly wireCommit?: boolean;
  readonly wireGate?: boolean;
  readonly wireReviewAssessment?: boolean;
  readonly wireGateReceipts?: boolean;
  /** Wire the KF-36a `workOrderRelease` fake over the harness's work-order map. */
  readonly wireWorkOrderRelease?: boolean;
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
  const stopRequests: StopAttemptRequest[] = [];
  const collectRequests: CollectAttemptArtifactsRequest[] = [];
  const commitRequests: CommitEditOnlyAttemptRequest[] = [];
  const gateRequests: EvaluateAttemptGateRequest[] = [];
  const reviewOpenRequests: OpenReviewAssessmentRequest[] = [];
  const gateReceiptRequests: RecordGateReceiptsRequest[] = [];
  const callOrder: string[] = [];
  // KF-36a-2: a per-harness work-order store, seeded with a copy of the fixture
  // (never the fixture itself — the release fake writes only into this map).
  const workOrders = new Map<string, WorkOrderRecord>([['wo-example-1', { ...WORK_ORDER_FIXTURE }]]);
  let manifestJson: string | null = JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] });
  let manifestVerdict: 'sealed' | 'missing' | 'mismatch' = 'missing';
  let reconcileAnswer: ReconcileAttemptResult = activeAnswer(attempts[attempts.length - 1] ?? attemptFixture());
  let reviewAssessmentAnswer: OpenReviewAssessmentResult = { outcome: 'open' };
  // null answers `recorded` with one receipt per request receipt (the honest default).
  let gateReceiptsAnswer: RecordGateReceiptsResult | null = null;
  let stopAnswer: (request: StopAttemptRequest) => Promise<StopAttemptResult> = async (request) => {
    const existing = await attemptRepo.findAttemptById(request.attemptId);
    if (existing === null) {
      return { outcome: 'refused', reason: 'attempt missing' };
    }
    const endedReceipt: CommandCompletionReceipt = {
      attemptId: existing.id,
      sessionId: existing.sessionId ?? 'session-example-1',
      endedAtIso: request.nowIso ?? LATER,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: true,
    };
    const ended: AttemptRecord = {
      ...existing,
      revision: (existing.revision ?? 0) + 1,
      state: 'ended',
      outcome: 'stopped',
      completionReceipt: endedReceipt,
      updatedAtIso: request.nowIso ?? LATER,
    };
    await attemptRepo.saveAttempt(ended);
    return { outcome: 'terminated', attempt: ended, receipt: endedReceipt, capacityReleased: true };
  };
  let collectAnswer: (request: CollectAttemptArtifactsRequest) => Promise<CollectAttemptArtifactsResult> = async (request) => {
    const existing = await attemptRepo.findAttemptById(request.attemptId);
    const collected: AttemptRecord = {
      ...(existing ?? attemptFixture({ id: request.attemptId })),
      revision: (existing?.revision ?? 0) + 1,
      state: 'collected',
      artifacts: COLLECTED_ARTIFACTS,
      updatedAtIso: LATER,
    };
    await attemptRepo.saveAttempt(collected);
    return { outcome: 'collected', artifacts: COLLECTED_ARTIFACTS };
  };
  let commitAnswer: CommitEditOnlyAttemptResult = { outcome: 'committed', headCommit: COMMIT, alreadyCommitted: false };
  let gateAnswer: EvaluateAttemptGateResult = { verdict: 'passed' };

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
      verifyArtifactManifest: async () => ({ outcome: manifestVerdict }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => reconcileAnswer,
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    workOrderRepo: {
      findWorkOrderById: async () => WORK_ORDER_FIXTURE,
    },
    ...(options.wireWorkOrderRelease === true
      ? {
          workOrderRelease: {
            saveWorkOrder: async (record: WorkOrderRecord) => {
              const stored = workOrders.get(record.id);
              // Mirror WorkOrderRepositoryAdapter.adapter.ts:76-78: a stale revision is an error.
              if (stored !== undefined && record.revision <= stored.revision) {
                throw new Error('stale work order revision');
              }
              workOrders.set(record.id, record);
            },
            findWorkOrderById: async (workOrderId: string) => workOrders.get(workOrderId) ?? null,
          },
        }
      : {}),
    newUlid: makeUlidMinter(),
    ...(options.ceiling !== undefined ? { perLaneCostCeiling: options.ceiling } : {}),
    ...(options.wireStop === false
      ? {}
      : {
          stopAttempt: {
            stopAttempt: async (request) => {
              stopRequests.push(request);
              return stopAnswer(request);
            },
          },
        }),
    ...(options.wireCollect === false
      ? {}
      : {
          collectAttemptArtifacts: {
            collectAttemptArtifacts: async (request) => {
              collectRequests.push(request);
              callOrder.push('collect');
              return collectAnswer(request);
            },
          },
        }),
    ...(options.wireCommit === false
      ? {}
      : {
          commitEditOnlyAttempt: {
            commitEditOnlyAttempt: async (request) => {
              commitRequests.push(request);
              callOrder.push('commit');
              return commitAnswer;
            },
          },
        }),
    ...(options.wireGate === false
      ? {}
      : {
          evaluateAttemptGate: {
            evaluateAttemptGate: async (request) => {
              gateRequests.push(request);
              return gateAnswer;
            },
          },
        }),
    ...(options.wireReviewAssessment === true
      ? {
          reviewAssessment: {
            openReviewAssessment: async (request) => {
              reviewOpenRequests.push(request);
              return reviewAssessmentAnswer;
            },
          },
        }
      : {}),
    ...(options.wireGateReceipts === true
      ? {
          gateReceipts: {
            recordGateReceipts: async (request) => {
              gateReceiptRequests.push(request);
              return gateReceiptsAnswer ?? { outcome: 'recorded', count: request.receipts.length };
            },
          },
        }
      : {}),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    stopRequests,
    collectRequests,
    commitRequests,
    gateRequests,
    reviewOpenRequests,
    gateReceiptRequests,
    workOrders,
    callOrder,
    deps,
    setManifest: (json) => {
      manifestJson = json;
    },
    setManifestVerdict: (verdict) => {
      manifestVerdict = verdict;
    },
    setReconcileAnswer: (answer) => {
      reconcileAnswer = answer;
    },
    setStopAnswer: (answer) => {
      stopAnswer = answer;
    },
    setCollectAnswer: (answer) => {
      collectAnswer = answer;
    },
    setCommitAnswer: (answer) => {
      commitAnswer = answer;
    },
    setGateAnswer: (answer) => {
      gateAnswer = answer;
    },
    setReviewAssessmentAnswer: (answer) => {
      reviewAssessmentAnswer = answer;
    },
    setGateReceiptsAnswer: (answer) => {
      gateReceiptsAnswer = answer;
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

async function conduct(harness: Harness, state: LaneRunStateValue, nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function lastJournalState(harness: Harness): Promise<string | null> {
  const entries = await harness.runJournal.listForRun(RUN_ID);
  const last = entries[entries.length - 1];
  return last === undefined ? null : last.kind === 'conduct' ? last.state : last.kind;
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
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendStopIntent(harness: Harness, mode: 'graceful' | 'force', nowIso: string): Promise<void> {
  const built = mode === 'force' ? laneRunStopForceKey(RUN_ID, 'web') : laneRunStopKey(RUN_ID, 'web');
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a stop key');
  }
  const entry = {
    ...laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, built.key, null, nowIso),
    mode,
    expectedRevision: 1,
  };
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

describe('AdvanceLaneRunUseCase stop, collect and gate acts (K4-6)', () => {
  it('test 1: a running attempt past its time limit is stopped as a timeout and the next advance seats it failed', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await appendIntent(harness, dispatchKey(), 'attempt-example-1', DISPATCHED_AT);
    await appendResult(harness, dispatchKey(), 'completed', 'dispatch-started', DISPATCHED_AT);
    harness.setReconcileAnswer(activeAnswer(running));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-timeout',
    });
    expect(harness.stopRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries[entries.length - 2]).toMatchObject({ kind: 'intent', key: stopKey() });
    expect(entries[entries.length - 1]).toMatchObject({
      kind: 'result',
      key: stopKey(),
      outcome: 'completed',
      reasonCode: 'stop-timeout',
    });
    const failed = await advance(harness);
    expect(failed).toEqual({ outcome: 'entered', state: 'seat-failed' });
  });

  it('test 2: a still-running stop is stop-unconfirmed and the next stop retries under /retry1', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await appendIntent(harness, dispatchKey(), 'attempt-example-1', DISPATCHED_AT);
    await appendResult(harness, dispatchKey(), 'completed', 'dispatch-started', DISPATCHED_AT);
    harness.setReconcileAnswer(activeAnswer(running));
    harness.setStopAnswer(async () => ({ outcome: 'still-running', attempt: running, reason: 'the runner is still live' }));
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-unconfirmed',
    });
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: retryStopKey(1),
      result: 'completed',
      reasonCode: 'stop-unconfirmed',
    });
    expect(harness.stopRequests).toHaveLength(2);
  });

  it('test 3: a forced stop maps all four rows of the stop table', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });

    const hReleased = await makeHarness(runRecord(), [running]);
    await conduct(hReleased, 'running', NOW);
    await appendStopIntent(hReleased, 'force', NOW);
    const released = await advance(hReleased);
    expect(released).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force',
    });
    expect(await lastJournalState(hReleased)).toBe('stopped');

    const hHeld = await makeHarness(runRecord(), [attemptFixture({ state: 'running', sessionId: 'session-example-1' })]);
    await conduct(hHeld, 'running', NOW);
    await appendStopIntent(hHeld, 'force', NOW);
    hHeld.setStopAnswer(async (request) => {
      const existing = await hHeld.attemptRepo.findAttemptById(request.attemptId);
      const heldReceipt: CommandCompletionReceipt = {
        attemptId: existing?.id ?? request.attemptId,
        sessionId: existing?.sessionId ?? 'session-example-1',
        endedAtIso: request.nowIso ?? LATER,
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: true,
      };
      const ended: AttemptRecord = {
        ...(existing ?? attemptFixture({ id: request.attemptId })),
        revision: (existing?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'stopped',
        completionReceipt: heldReceipt,
        updatedAtIso: request.nowIso ?? LATER,
      };
      await hHeld.attemptRepo.saveAttempt(ended);
      return { outcome: 'terminated', attempt: ended, receipt: heldReceipt, capacityReleased: false };
    });
    const held = await advance(hHeld);
    expect(held).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force-slot-held',
    });
    expect(await lastJournalState(hHeld)).toBe('stopped');

    const hRunning = await makeHarness(runRecord(), [attemptFixture({ state: 'running', sessionId: 'session-example-1' })]);
    await conduct(hRunning, 'running', NOW);
    await appendStopIntent(hRunning, 'force', NOW);
    hRunning.setStopAnswer(async () => ({
      outcome: 'still-running',
      attempt: attemptFixture({ state: 'running', sessionId: 'session-example-1' }),
      reason: 'the runner is still live',
    }));
    const stillRunning = await advance(hRunning);
    expect(stillRunning).toEqual({ outcome: 'parked', reason: 'stop-unconfirmed', qualifier: null });
    const afterRunning = await hRunning.runRepo.get(RUN_ID);
    expect(afterRunning?.parked).toEqual({
      reason: 'stop-unconfirmed',
      qualifier: null,
      parkedFrom: 'running',
      questionId: null,
    });
    expect(afterRunning?.parkCount).toBe(1);

    const hRefused = await makeHarness(runRecord(), [attemptFixture({ state: 'running', sessionId: 'session-example-1' })]);
    await conduct(hRefused, 'running', NOW);
    await appendStopIntent(hRefused, 'force', NOW);
    hRefused.setStopAnswer(async (request) => {
      const existing = await hRefused.attemptRepo.findAttemptById(request.attemptId);
      await hRefused.attemptRepo.saveAttempt({
        ...(existing ?? attemptFixture({ id: request.attemptId })),
        revision: (existing?.revision ?? 0) + 1,
        state: 'cancelled',
        outcome: 'stopped',
        updatedAtIso: request.nowIso ?? LATER,
      });
      return { outcome: 'refused', reason: 'the example runner refused the stop' };
    });
    const refused = await advance(hRefused);
    expect(refused).toEqual({ outcome: 'parked', reason: 'stop-refused', qualifier: 'attempt-terminal' });
    const afterRefused = await hRefused.runRepo.get(RUN_ID);
    expect(afterRefused?.parked).toEqual({
      reason: 'stop-refused',
      qualifier: 'attempt-terminal',
      parkedFrom: 'running',
      questionId: null,
    });
  });

  it('test 4: a graceful stop during running before the deadline drains without calling the stop', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await appendIntent(harness, dispatchKey(), 'attempt-example-1', LATER);
    await appendResult(harness, dispatchKey(), 'completed', 'dispatch-started', LATER);
    await appendStopIntent(harness, 'graceful', NOW);
    harness.setReconcileAnswer(activeAnswer(running));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'stop-draining' });
    expect(harness.stopRequests).toHaveLength(0);
  });

  it('test 5: collecting an ended opencode attempt collects without the commit step', async () => {
    const ended = endedAttempt({ runner: CONDUCTED_RUNNER });
    const harness = await makeHarness(runRecord(), [ended]);
    await conduct(harness, 'collecting', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'completed',
      reasonCode: 'collected',
    });
    expect(harness.commitRequests).toHaveLength(0);
    expect(harness.collectRequests).toHaveLength(1);
    expect(harness.collectRequests[0]).toEqual({
      attemptId: 'attempt-example-1',
      workOrderId: 'wo-example-1',
      expectedArtifacts: [],
      completionReceipt: ended.completionReceipt,
    });
    const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
    expect(stored?.state).toBe('collected');
  });

  it('test 6a: an agy collect runs the edit-only commit first, then collects', async () => {
    const ended = endedAttempt({ runner: AGY_RUNNER });
    const harness = await makeHarness(runRecord(), [ended]);
    await conduct(harness, 'collecting', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'completed',
      reasonCode: 'collected',
    });
    expect(harness.callOrder).toEqual(['commit', 'collect']);
    expect(harness.commitRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
  });

  it('test 6b: a commit refusal refuses the collect and the next advance parks step-refused collect', async () => {
    const findings: readonly LaneDiffFinding[] = [
      { path: 'packages/example/secret.txt', line: 3, rule: 'secret-shape' },
    ];
    const ended = endedAttempt({ runner: AGY_RUNNER });
    const harness = await makeHarness(runRecord(), [ended]);
    await conduct(harness, 'collecting', NOW);
    harness.setCommitAnswer({ outcome: 'refused', reason: 'diff-findings', findings });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'refused',
      reasonCode: 'edit-only-refused',
    });
    expect(harness.collectRequests).toHaveLength(0);
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'collect' });
  });

  it('test 6c: an unknown commit is ambiguous and the next advance parks ambiguous collect', async () => {
    const ended = endedAttempt({ runner: AGY_RUNNER });
    const harness = await makeHarness(runRecord(), [ended]);
    await conduct(harness, 'collecting', NOW);
    harness.setCommitAnswer({ outcome: 'unknown', reason: 'host unreadable' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'ambiguous',
      reasonCode: 'edit-only-unknown',
    });
    expect(harness.collectRequests).toHaveLength(0);
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'collect' });
  });

  it('test 6d: a nothing-to-commit commit collects and a zero-commit collection seats the attempt failed', async () => {
    const ended = endedAttempt({ runner: AGY_RUNNER });
    const harness = await makeHarness(runRecord(), [ended]);
    await conduct(harness, 'collecting', NOW);
    harness.setCommitAnswer({ outcome: 'nothing-to-commit' });
    harness.setCollectAnswer(async (request) => {
      const existing = await harness.attemptRepo.findAttemptById(request.attemptId);
      const artifacts: CollectedAttemptArtifacts = {
        headCommit: COMMIT,
        commitsSinceBase: [],
        collectedArtifactPaths: [],
        notes: 'present',
      };
      await harness.attemptRepo.saveAttempt({
        ...(existing ?? attemptFixture({ id: request.attemptId })),
        revision: (existing?.revision ?? 0) + 1,
        state: 'collected',
        artifacts,
        updatedAtIso: LATER,
      });
      return { outcome: 'collected', artifacts };
    });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'completed',
      reasonCode: 'collected',
    });
    const failed = await advance(harness);
    expect(failed).toEqual({ outcome: 'entered', state: 'seat-failed' });
  });

  it('test 7: a graceful drain still collects', async () => {
    const ended = endedAttempt();
    const harness = await makeHarness(runRecord(), [ended]);
    await conduct(harness, 'collecting', NOW);
    await appendStopIntent(harness, 'graceful', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'completed',
      reasonCode: 'collected',
    });
    expect(harness.collectRequests).toHaveLength(1);
  });

  it('test 8: the gate act journals the typed verdict at the collected head and the next advance follows it', async () => {
    const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });

    const hPass = await makeHarness(runRecord(), [collected]);
    hPass.setManifestVerdict('sealed');
    await conduct(hPass, 'gating', NOW);
    const passed = await advance(hPass);
    expect(passed).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: gateKey(),
      result: 'completed',
      reasonCode: 'gate-passed',
    });
    expect(hPass.gateRequests).toEqual([{ attemptId: 'attempt-example-1', candidateHeadSha: COMMIT }]);
    expect(await advance(hPass)).toEqual({ outcome: 'entered', state: 'brief-check' });

    const hFail = await makeHarness(runRecord(), [collected]);
    hFail.setManifestVerdict('sealed');
    await conduct(hFail, 'gating', NOW);
    hFail.setGateAnswer({ verdict: 'failed', reason: 'Gate predicate command 1 failed' });
    const failed = await advance(hFail);
    expect(failed).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: gateKey(),
      result: 'completed',
      reasonCode: 'gate-failed',
    });
    expect(await advance(hFail)).toEqual({ outcome: 'entered', state: 'fixing' });

    const hUnknown = await makeHarness(runRecord(), [collected]);
    hUnknown.setManifestVerdict('sealed');
    await conduct(hUnknown, 'gating', NOW);
    hUnknown.setGateAnswer({ verdict: 'unknown', reason: 'predicates unavailable' });
    const unknown = await advance(hUnknown);
    expect(unknown).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: gateKey(),
      result: 'ambiguous',
      reasonCode: 'gate-unknown',
    });
    expect(await advance(hUnknown)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'gate' });
  });

  it('test 8c: a congested gate run records gate-congested, waits the backoff, then retries under /retry1 and passes into brief-check', async () => {
    const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
    const harness = await makeHarness(runRecord(), [collected]);
    harness.setManifestVerdict('sealed');
    await conduct(harness, 'gating', NOW);
    harness.setGateAnswer({ verdict: 'unknown', reason: 'gate slot wait limit reached', congested: true });

    // Run 0: congestion is completed (never ambiguous) and the run is not parked.
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: gateKey(),
      result: 'completed',
      reasonCode: 'gate-congested',
    });
    expect(harness.gateRequests).toEqual([{ attemptId: 'attempt-example-1', candidateHeadSha: COMMIT }]);

    // Within the backoff the decider waits, never parks.
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'gate-congested' });

    // After the backoff the next advance acts the gate under /retry1, passing gateRun 1.
    const retryBuilt = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'gate',
      seatIndex: 0,
      attemptOrdinal: null,
      head12: HEAD12,
      retry: 1,
    });
    expect(retryBuilt.ok).toBe(true);
    if (!retryBuilt.ok) {
      throw new Error('fixture must build a retry gate key');
    }
    const retryKey = retryBuilt.key;
    harness.setGateAnswer({ verdict: 'passed', results: [] });
    const second = await advance(harness, { nowIso: '2026-10-27T10:02:01.000Z' });
    expect(second).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: retryKey,
      result: 'completed',
      reasonCode: 'gate-passed',
    });
    expect(harness.gateRequests).toEqual([
      { attemptId: 'attempt-example-1', candidateHeadSha: COMMIT },
      { attemptId: 'attempt-example-1', candidateHeadSha: COMMIT, gateRun: 1 },
    ]);
    // The retry's journal entries exist under /retry1: run 0 never sealed the head.
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'intent' && entry.key === retryKey)).toBe(true);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === retryKey && entry.reasonCode === 'gate-passed')).toBe(true);

    // A pass then enters brief-check.
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'brief-check' });
  });

  it('test 8d: repeated congestion retries to the bound and then parks ambiguous gate', async () => {
    const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
    const harness = await makeHarness(runRecord(), [collected]);
    harness.setManifestVerdict('sealed');
    await conduct(harness, 'gating', NOW);
    harness.setGateAnswer({ verdict: 'unknown', reason: 'gate slot wait limit reached', congested: true });

    // Run 0 is congested (recorded at LATER by the default advance) and never parks.
    expect(await advance(harness)).toMatchObject({
      outcome: 'acted', step: 'gate', result: 'completed', reasonCode: 'gate-congested',
    });

    // The retry sequence spans the 60s backoffs, so extend the run lease past it
    // (the lease window is bounded at 10 minutes).
    const renewed = await harness.runRepo.renewLease(RUN_ID, {
      holderId: HOLDER,
      fence: 1,
      leaseUntilIso: '2026-10-27T10:10:00.000Z',
      nowIso: NOW,
    });
    expect(renewed.outcome).toBe('saved');

    // Retries 1..6, each past the backoff, all congested; never parked.
    let tick = Date.parse('2026-10-27T10:02:01.000Z');
    for (let n = 1; n <= 6; n += 1) {
      const acted = await advance(harness, { nowIso: new Date(tick).toISOString() });
      expect(acted).toMatchObject({
        outcome: 'acted', step: 'gate', result: 'completed', reasonCode: 'gate-congested',
      });
      tick += 61_000;
    }

    // Past the bound the next advance parks ambiguous at the gate.
    expect(await advance(harness, { nowIso: new Date(tick).toISOString() })).toEqual({
      outcome: 'parked', reason: 'ambiguous', qualifier: 'gate',
    });
  });

  it('test 8e (KF-30c2, real path): a real gate recovers a congested run under /retry1 and journals /g1 predicates', async () => {
    // A real RequestAttemptAcceptanceUseCase over the harness's execution
    // journal: its first evaluation hits a gate-slot congestion, its second
    // passes. The conductor's gate step runs it through AdvanceLaneRunUseCase,
    // so the run waits out the backoff and the retry reads /retry1.
    const GATE_PROSE = '# Brief\n';
    const GATE_SPEC = { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] };
    const GATE_MANIFEST = JSON.stringify({
      baseCommit: COMMIT,
      allowedPathPrefixes: ['src'],
      acceptanceSpec: GATE_SPEC,
    });
    const gateAttempt = attemptFixture({
      state: 'collected',
      artifacts: COLLECTED_ARTIFACTS,
      briefDigest: simpleDeterministicHexDigest(GATE_PROSE + '\n' + GATE_MANIFEST),
    });
    const harness = await makeHarness(runRecord(), [gateAttempt]);
    harness.setManifestVerdict('sealed');

    class FlakyGatePredicatePort implements GatePredicatePort {
      private calls = 0;
      async evaluateGatePredicates(): Promise<EvaluateGatePredicatesResult> {
        this.calls += 1;
        const verdict: GatePredicateResult['verdict'] = this.calls === 1 ? 'unknown' : 'pass';
        return {
          outcome: 'evaluated',
          results: [
            { name: 'commit', kind: 'commit', verdict: 'pass', exitCode: null, durationMs: 1, detail: 'head ' + COMMIT },
            { name: 'diff-check', kind: 'diff-check', verdict: 'pass', exitCode: null, durationMs: 1, detail: 'clean' },
            {
              name: 'command 1: corepack yarn build',
              kind: 'command',
              verdict,
              exitCode: this.calls === 1 ? 75 : 0,
              durationMs: 1,
              detail: this.calls === 1 ? 'gate slot wait limit reached' : 'exit 0',
              ...(this.calls === 1 ? { cause: 'gate-slot-wait-limit' as const } : {}),
            },
          ],
        };
      }
    }
    const realGate = new RequestAttemptAcceptanceUseCase({
      attemptRepo: harness.attemptRepo,
      acceptancePort: {
        assessHeadAcceptance: async () => {
          throw new Error('not used by this test');
        },
        assessHeadReceipts: async () => {
          throw new Error('not used by this test');
        },
      },
      artifactPort: {
        readBriefFile: async () => GATE_PROSE,
        readBriefManifest: async () => GATE_MANIFEST,
      },
      gatePredicates: new FlakyGatePredicatePort(),
      journal: harness.executionJournal,
    });
    const wired = {
      evaluateAttemptGate: async (request: Parameters<typeof realGate.evaluateAttemptGate>[0]) => {
        (harness.gateRequests as EvaluateAttemptGateRequest[]).push(request);
        return realGate.evaluateAttemptGate(request);
      },
    };
    Object.assign(harness.deps, { evaluateAttemptGate: wired });

    await conduct(harness, 'gating', NOW);

    // Run 0: the real gate is congested and the conductor records it completed.
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: gateKey(),
      result: 'completed',
      reasonCode: 'gate-congested',
    });
    expect(harness.gateRequests).toEqual([{ attemptId: 'attempt-example-1', candidateHeadSha: COMMIT }]);

    // Within the backoff the run waits.
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'gate-congested' });

    // After the backoff the next advance re-runs under /retry1 and passes.
    const retryBuilt = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'gate',
      seatIndex: 0,
      attemptOrdinal: null,
      head12: HEAD12,
      retry: 1,
    });
    expect(retryBuilt.ok).toBe(true);
    if (!retryBuilt.ok) {
      throw new Error('fixture must build a retry gate key');
    }
    const second = await advance(harness, { nowIso: '2026-10-27T10:02:01.000Z' });
    expect(second).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: retryBuilt.key,
      result: 'completed',
      reasonCode: 'gate-passed',
    });
    expect(harness.gateRequests).toEqual([
      { attemptId: 'attempt-example-1', candidateHeadSha: COMMIT },
      { attemptId: 'attempt-example-1', candidateHeadSha: COMMIT, gateRun: 1 },
    ]);

    // The execution journal holds the /g1 predicate entries and run 0's are
    // unchanged (still the congestion, with its cause).
    const journalEntries = await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    const g1 = journalEntries.filter((entry) => entry.id.startsWith(`attempt-example-1:accept:${COMMIT}/g1:`));
    expect(g1.map((entry) => entry.id)).toEqual([
      `attempt-example-1:accept:${COMMIT}/g1:0`,
      `attempt-example-1:accept:${COMMIT}/g1:1`,
      `attempt-example-1:accept:${COMMIT}/g1:2`,
      `attempt-example-1:accept:${COMMIT}/g1:3`,
    ]);
    const run0 = journalEntries.filter((entry) => entry.id.startsWith(`attempt-example-1:accept:${COMMIT}:`));
    expect(run0.map((entry) => entry.id)).toEqual([
      `attempt-example-1:accept:${COMMIT}:0`,
      `attempt-example-1:accept:${COMMIT}:1`,
      `attempt-example-1:accept:${COMMIT}:2`,
      `attempt-example-1:accept:${COMMIT}:3`,
    ]);
    expect(run0[3]).toMatchObject({ status: 'ambiguous' });
    expect(JSON.parse(run0[3]?.detail ?? '{}')).toMatchObject({
      predicate: 'command 1: corepack yarn build',
      verdict: 'unknown',
      cause: 'gate-slot-wait-limit',
    });
  });

  it('test 8b: a gating run whose collection is not sealed parks artifacts-unsealed and never gates', async () => {
    const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
    for (const verdict of ['missing', 'mismatch'] as const) {
      const harness = await makeHarness(runRecord(), [collected]);
      harness.setManifestVerdict(verdict);
      await conduct(harness, 'gating', NOW);
      expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'artifacts-unsealed', qualifier: null });
      expect(harness.gateRequests).toEqual([]);
      const entries = await harness.runJournal.listForRun(RUN_ID);
      expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === gateKey())).toEqual([]);
    }
  });

  it('test 5b: a manifest whose expectedArtifacts is not a string array refuses the collect without calling it', async () => {
    const ended = endedAttempt({ runner: CONDUCTED_RUNNER });
    const harness = await makeHarness(runRecord(), [ended]);
    harness.setManifest(JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: 'all' }));
    await conduct(harness, 'collecting', NOW);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'refused',
      reasonCode: 'collect-refused',
    });
    expect(harness.collectRequests).toHaveLength(0);
  });

  it('test 5c: an absent frozen manifest refuses the collect before the edit-only commit or the collector', async () => {
    const agyEnded = endedAttempt({ runner: AGY_RUNNER });
    for (const attempt of [endedAttempt(), agyEnded]) {
      const harness = await makeHarness(runRecord(), [attempt]);
      harness.setManifest(null);
      await conduct(harness, 'collecting', NOW);
      expect(await advance(harness)).toEqual({
        outcome: 'acted',
        step: 'collect',
        key: collectKey(),
        result: 'refused',
        reasonCode: 'collect-refused',
      });
      expect(harness.collectRequests).toHaveLength(0);
      expect(harness.commitRequests).toHaveLength(0);
    }
  });

  it('test 9: each absent port is not-wired with its step and writes nothing', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const hStop = await makeHarness(runRecord(), [running], { wireStop: false });
    await conduct(hStop, 'running', NOW);
    await appendIntent(hStop, dispatchKey(), 'attempt-example-1', DISPATCHED_AT);
    await appendResult(hStop, dispatchKey(), 'completed', 'dispatch-started', DISPATCHED_AT);
    hStop.setReconcileAnswer(activeAnswer(running));
    expect(await advance(hStop)).toEqual({ outcome: 'not-wired', step: 'stop' });
    expect(await hStop.runJournal.listForRun(RUN_ID)).toHaveLength(3);

    const hCollect = await makeHarness(runRecord(), [endedAttempt()], { wireCollect: false });
    await conduct(hCollect, 'collecting', NOW);
    expect(await advance(hCollect)).toEqual({ outcome: 'not-wired', step: 'collect' });
    expect(await hCollect.runJournal.listForRun(RUN_ID)).toHaveLength(1);

    const hCommit = await makeHarness(runRecord(), [endedAttempt({ runner: AGY_RUNNER })], { wireCommit: false });
    await conduct(hCommit, 'collecting', NOW);
    expect(await advance(hCommit)).toEqual({ outcome: 'not-wired', step: 'collect' });
    expect(await hCommit.runJournal.listForRun(RUN_ID)).toHaveLength(1);
    expect(hCommit.collectRequests).toHaveLength(0);

    const hGate = await makeHarness(runRecord(), [attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS })], { wireGate: false });
    await conduct(hGate, 'gating', NOW);
    expect(await advance(hGate)).toEqual({ outcome: 'not-wired', step: 'gate' });
    expect(await hGate.runJournal.listForRun(RUN_ID)).toHaveLength(1);
  });

  it('test 10: halt during a drain parks before collect or gate, and lifts back into the collect', async () => {
    const hCollect = await makeHarness(runRecord(), [endedAttempt()]);
    await conduct(hCollect, 'collecting', NOW);
    await appendStopIntent(hCollect, 'graceful', NOW);
    const parkedCollect = await advance(hCollect, { halted: true });
    expect(parkedCollect).toEqual({ outcome: 'parked', reason: 'halted', qualifier: null });
    expect(hCollect.commitRequests).toHaveLength(0);
    expect(hCollect.collectRequests).toHaveLength(0);
    const lifted = await advance(hCollect, { halted: false });
    expect(lifted).toEqual({ outcome: 'entered', state: 'collecting' });
    const collectedResult = await advance(hCollect);
    expect(collectedResult).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'completed',
      reasonCode: 'collected',
    });

    const hGate = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS })],
    );
    await conduct(hGate, 'gating', NOW);
    await appendStopIntent(hGate, 'graceful', NOW);
    const parkedGate = await advance(hGate, { halted: true });
    expect(parkedGate).toEqual({ outcome: 'parked', reason: 'halted', qualifier: null });
    expect(hGate.gateRequests).toHaveLength(0);
  });

  it('test 11: a lapsed lease refuses lease-expired before any collect write', async () => {
    const harness = await makeHarness(runRecord(), [endedAttempt()]);
    await conduct(harness, 'collecting', NOW);
    const result = await advance(harness, { nowIso: EXPIRED });
    expect(result).toEqual({ outcome: 'refused', reason: 'lease-expired' });
    expect(harness.collectRequests).toHaveLength(0);
    expect(await harness.runJournal.listForRun(RUN_ID)).toHaveLength(1);
  });

  it('test 12: a forced-stop reconcile reads the reservation: a still-held slot is stop-force-slot-held, else stop-force', async () => {
    const terminal = () => attemptFixture({ state: 'ended', sessionId: 'session-example-1', completionReceipt: receipt() });

    const heldHarness = await makeHarness(runRecord(), [terminal()]);
    await conduct(heldHarness, 'running', NOW);
    await appendStopIntent(heldHarness, 'force', NOW);
    await appendIntent(heldHarness, stopKey(), null, NOW);
    await heldHarness.executionJournal.saveCapacityReservation({
      id: heldHarness.deps.newUlid(),
      attemptId: 'attempt-example-1',
      hostId: 'host-example-1',
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const held = await advance(heldHarness);
    expect(held).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force-slot-held',
    });
    expect(heldHarness.stopRequests).toHaveLength(0);
    expect(await lastJournalState(heldHarness)).toBe('stopped');

    const releasedHarness = await makeHarness(runRecord(), [terminal()]);
    await conduct(releasedHarness, 'running', NOW);
    await appendStopIntent(releasedHarness, 'force', NOW);
    await appendIntent(releasedHarness, stopKey(), null, NOW);
    const released = await advance(releasedHarness);
    expect(released).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force',
    });
    expect(await lastJournalState(releasedHarness)).toBe('stopped');
  });

  describe('KF-13a: a wired gate records one verification receipt per acceptance check', () => {
    const CHECKS_MANIFEST = JSON.stringify({
      stepLimit: 100,
      timeLimitSeconds: 2700,
      expectedArtifacts: [],
      acceptanceChecks: ['build', 'test'],
      modelAssignment: { model: 'model-example-1' },
    });

    function commandResult(
      name: string,
      verdict: GatePredicateResult['verdict'],
      exitCode: number | null,
      kind: GatePredicateResult['kind'] = 'command',
    ): GatePredicateResult {
      return { name, kind, verdict, exitCode, durationMs: 1, detail: 'exit ' + String(exitCode) };
    }

    it('records two receipts in check order after opening the assessment with the same requiredChecks', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('commit', 'pass', null, 'commit'),
          commandResult('diff-check', 'pass', null, 'diff-check'),
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'completed',
        reasonCode: 'gate-passed',
      });
      expect(harness.reviewOpenRequests).toHaveLength(1);
      expect(harness.reviewOpenRequests[0]).toEqual({
        attemptId: 'attempt-example-1',
        projectId: 'project-example-1',
        candidateHeadSha: COMMIT,
        policyRevision: 'policy-example-1',
        implementerModel: 'model-example-1',
        requiredChecks: ['build', 'test'],
      });
      expect(harness.gateReceiptRequests).toHaveLength(1);
      expect(harness.gateReceiptRequests[0]).toMatchObject({
        attemptId: 'attempt-example-1',
        projectId: 'project-example-1',
        candidateHeadSha: COMMIT,
        hostId: 'lane-host-example',
        policyRevision: 'policy-example-1',
        completedAtIso: LATER,
        evidenceRef: 'run-journal:' + gateKey(),
        receipts: [
          { procedureName: 'build', result: 'pass', exitCode: 0 },
          { procedureName: 'test', result: 'pass', exitCode: 0 },
        ],
      });
      // Receipts are recorded before the run result is appended.
      const entries = await harness.runJournal.listForRun(RUN_ID);
      expect(entries[entries.length - 1]).toMatchObject({
        kind: 'result',
        key: gateKey(),
        outcome: 'completed',
        reasonCode: 'gate-passed',
      });
    });

    it('records the failing receipt and the run result is still gate-failed', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'failed',
        reason: 'Gate predicate command 1 failed',
        results: [
          commandResult('commit', 'pass', null, 'commit'),
          commandResult('diff-check', 'pass', null, 'diff-check'),
          commandResult('command 1: build', 'fail', 2),
          commandResult('command 2: test', 'skipped', null),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'completed',
        reasonCode: 'gate-failed',
      });
      expect(harness.gateReceiptRequests).toHaveLength(1);
      expect(harness.gateReceiptRequests[0]?.receipts).toEqual([
        { procedureName: 'build', result: 'fail', exitCode: 2 },
        { procedureName: 'test', result: 'skipped', exitCode: null },
      ]);
    });

    it('records nothing when the gateReceipts dep is absent', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], { wireReviewAssessment: true });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'completed',
        reasonCode: 'gate-passed',
      });
      expect(harness.reviewOpenRequests).toHaveLength(0);
      expect(harness.gateReceiptRequests).toHaveLength(0);
    });

    it('fails closed to gate-unknown when the assessment open is unavailable', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setReviewAssessmentAnswer({ outcome: 'unavailable', reason: 'head-mismatch' });
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'ambiguous',
        reasonCode: 'gate-unknown',
      });
      expect(harness.gateReceiptRequests).toHaveLength(0);
    });

    it('fails closed to gate-unknown when the record is unavailable', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateReceiptsAnswer({ outcome: 'unavailable', reason: 'host gone' });
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'ambiguous',
        reasonCode: 'gate-unknown',
      });
      expect(harness.gateReceiptRequests).toHaveLength(1);
    });

    it('fails closed to gate-unknown when two checks share a name, with no record (KF-13a Luna pre-merge)', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(JSON.stringify({ ...JSON.parse(CHECKS_MANIFEST), acceptanceChecks: ['same', 'same'] }));
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toMatchObject({ outcome: 'acted', step: 'gate', result: 'ambiguous', reasonCode: 'gate-unknown' });
      expect(harness.gateReceiptRequests).toHaveLength(0);
    });

    it('fails closed to gate-unknown when the receipt port records fewer receipts than checks (KF-13a Luna)', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateReceiptsAnswer({ outcome: 'recorded', count: 0 });
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toMatchObject({ outcome: 'acted', step: 'gate', result: 'ambiguous', reasonCode: 'gate-unknown' });
    });

    it('fails closed to gate-unknown on a checks/command count mismatch with no partial record', async () => {
      const collected = attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(
        JSON.stringify({
          stepLimit: 100,
          timeLimitSeconds: 2700,
          expectedArtifacts: [],
          acceptanceChecks: ['build', 'test', 'lint'],
          modelAssignment: { model: 'model-example-1' },
        }),
      );
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'ambiguous',
        reasonCode: 'gate-unknown',
      });
      expect(harness.gateReceiptRequests).toHaveLength(0);
    });

    it('opens the assessment with the runner model when it equals the manifest model (KF-20)', async () => {
      const collected = attemptFixture({
        state: 'collected',
        artifacts: COLLECTED_ARTIFACTS,
        runner: { ...CONDUCTED_RUNNER, model: 'model-example-1' },
        seatSelection: null,
      });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'completed',
        reasonCode: 'gate-passed',
      });
      expect(harness.reviewOpenRequests[0]).toMatchObject({
        attemptId: 'attempt-example-1',
        implementerModel: 'model-example-1',
      });
    });

    it('opens the assessment with the RUNNER model when the runner model differs from the manifest model (KF-20, a fix seat)', async () => {
      const collected = attemptFixture({
        state: 'collected',
        artifacts: COLLECTED_ARTIFACTS,
        runner: { ...CONDUCTED_RUNNER, model: 'fix-model-1' },
      });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'completed',
        reasonCode: 'gate-passed',
      });
      // The manifest's model is 'model-example-1'; the model that ran the
      // attempt is the fix seat's 'fix-model-1' and it wins.
      expect(harness.reviewOpenRequests[0]).toMatchObject({
        attemptId: 'attempt-example-1',
        implementerModel: 'fix-model-1',
      });
    });

    it('a fix attempt with no recorded model opens no assessment and never passes the gate (KF-20)', async () => {
      const collected = attemptFixture({
        kind: 'fix',
        priorAttemptId: 'attempt-example-0',
        state: 'collected',
        artifacts: COLLECTED_ARTIFACTS,
        runner: { ...CONDUCTED_RUNNER, model: null },
        seatSelection: null,
      });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(harness.reviewOpenRequests).toHaveLength(0);
      expect(result).not.toMatchObject({ reasonCode: 'gate-passed' });
    });

    it('falls back to the manifest model when the attempt has no runner model (KF-20)', async () => {
      const collected = attemptFixture({
        state: 'collected',
        artifacts: COLLECTED_ARTIFACTS,
        runner: { ...CONDUCTED_RUNNER, model: null },
        seatSelection: null,
      });
      const harness = await makeHarness(runRecord(), [collected], {
        wireReviewAssessment: true,
        wireGateReceipts: true,
      });
      harness.setManifest(CHECKS_MANIFEST);
      harness.setManifestVerdict('sealed');
      harness.setGateAnswer({
        verdict: 'passed',
        results: [
          commandResult('command 1: build', 'pass', 0),
          commandResult('command 2: test', 'pass', 0),
        ],
      });
      await conduct(harness, 'gating', NOW);

      const result = await advance(harness);

      expect(result).toEqual({
        outcome: 'acted',
        step: 'gate',
        key: gateKey(),
        result: 'completed',
        reasonCode: 'gate-passed',
      });
      expect(harness.reviewOpenRequests[0]).toMatchObject({
        attemptId: 'attempt-example-1',
        implementerModel: 'model-example-1',
      });
    });
  });
});

describe('AdvanceLaneRunUseCase force stops release the work order (KF-36a-2)', () => {
  function heldReservation(harness: Harness, attemptId: string): void {
    void harness.executionJournal.saveCapacityReservation({
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

  it('test 13: finishForceStop stop-force releases the work order stopped at revision + 1 and nowIso', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running], { wireWorkOrderRelease: true });
    await conduct(harness, 'running', NOW);
    await appendStopIntent(harness, 'force', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force',
    });
    expect(await lastJournalState(harness)).toBe('stopped');
    expect(harness.workOrders.get('wo-example-1')).toMatchObject({
      id: 'wo-example-1',
      state: 'stopped',
      revision: 2,
      updatedAtIso: LATER,
    });
  });

  it('test 14: finishForceStop stop-force-slot-held leaves the work order approved at its revision', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running], { wireWorkOrderRelease: true });
    await conduct(harness, 'running', NOW);
    await appendStopIntent(harness, 'force', NOW);
    heldReservation(harness, 'attempt-example-1');
    harness.setStopAnswer(async (request) => {
      const existing = await harness.attemptRepo.findAttemptById(request.attemptId);
      const heldReceipt: CommandCompletionReceipt = {
        attemptId: existing?.id ?? request.attemptId,
        sessionId: existing?.sessionId ?? 'session-example-1',
        endedAtIso: request.nowIso ?? LATER,
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: true,
      };
      const ended: AttemptRecord = {
        ...(existing ?? attemptFixture({ id: request.attemptId })),
        revision: (existing?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'stopped',
        completionReceipt: heldReceipt,
        updatedAtIso: request.nowIso ?? LATER,
      };
      await harness.attemptRepo.saveAttempt(ended);
      return { outcome: 'terminated', attempt: ended, receipt: heldReceipt, capacityReleased: false };
    });
    const held = await advance(harness);
    expect(held).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force-slot-held',
    });
    expect(await lastJournalState(harness)).toBe('stopped');
    expect(harness.workOrders.get('wo-example-1')).toMatchObject({
      id: 'wo-example-1',
      state: 'approved',
      revision: 1,
    });
  });

  it('test 15: the forced-stop reconcile releases stopped when released and keeps approved when held', async () => {
    const terminal = () => attemptFixture({ state: 'ended', sessionId: 'session-example-1', completionReceipt: receipt() });

    const releasedHarness = await makeHarness(runRecord(), [terminal()], { wireWorkOrderRelease: true });
    await conduct(releasedHarness, 'running', NOW);
    await appendStopIntent(releasedHarness, 'force', NOW);
    await appendIntent(releasedHarness, stopKey(), null, NOW);
    const released = await advance(releasedHarness);
    expect(released).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force',
    });
    expect(releasedHarness.workOrders.get('wo-example-1')).toMatchObject({
      state: 'stopped',
      revision: 2,
      updatedAtIso: LATER,
    });

    const heldHarness = await makeHarness(runRecord(), [terminal()], { wireWorkOrderRelease: true });
    await conduct(heldHarness, 'running', NOW);
    await appendStopIntent(heldHarness, 'force', NOW);
    await appendIntent(heldHarness, stopKey(), null, NOW);
    heldReservation(heldHarness, 'attempt-example-1');
    const held = await advance(heldHarness);
    expect(held).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-force-slot-held',
    });
    expect(heldHarness.workOrders.get('wo-example-1')).toMatchObject({
      state: 'approved',
      revision: 1,
    });
  });

  it('test 16: without wireWorkOrderRelease a force stop leaves the work-order map unchanged', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await appendStopIntent(harness, 'force', NOW);
    const result = await advance(harness);
    expect(result).toMatchObject({ reasonCode: 'stop-force' });
    expect(harness.workOrders.get('wo-example-1')).toMatchObject({
      state: 'approved',
      revision: 1,
    });
  });

  it('test 17: a held reservation for an attempt outside the run still releases stopped (pins the attemptIds filter)', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running], { wireWorkOrderRelease: true });
    await conduct(harness, 'running', NOW);
    await appendStopIntent(harness, 'force', NOW);
    heldReservation(harness, 'attempt-other-1');
    const result = await advance(harness);
    expect(result).toMatchObject({ reasonCode: 'stop-force' });
    expect(harness.workOrders.get('wo-example-1')).toMatchObject({
      state: 'stopped',
      revision: 2,
    });
  });
});
