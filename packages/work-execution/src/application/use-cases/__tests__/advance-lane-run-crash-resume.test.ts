/**
 * Unit tests for K4-7: the conductor's §3.5 reconcile of an intent without a
 * result and the crash-resume tests. Each test seeds the stores as a crash
 * would leave them (an intent with no result) and asserts the acting fake is
 * never called by the reconcile: prepare and dispatch are one-way (reconcile
 * only reads and records; an idle worktree under an untouched record is
 * not-started and the attempt is cancelled so its key is never re-sent), stop
 * reads the record, and collect and gate, which are not one-way, are
 * completed. The G4j force reconcile moves a prepared attempt to reconciling
 * so the next advance can stop it. Every store is in-memory; no runner, no
 * subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunAttemptDispatchResult,
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import type {
  CancelPreparedAttemptRequest,
} from '../../ports/in/CancelPreparedAttemptPort.in-port.js';
import type {
  DispatchAttemptRequest,
  DispatchAttemptResult,
} from '../../ports/in/DispatchAttemptPort.in-port.js';
import type {
  StopAttemptRequest,
  StopAttemptResult,
} from '../../ports/in/StopAttemptPort.in-port.js';
import type {
  CollectAttemptArtifactsRequest,
  CollectAttemptArtifactsResult,
} from '../../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type {
  EvaluateAttemptGateRequest,
  EvaluateAttemptGateResult,
} from '../../ports/in/EvaluateAttemptGatePort.in-port.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  WorktreeRunRef,
  WorktreeRunState,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
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
const SHA = 'c'.repeat(64);
const HEAD12 = 'a'.repeat(12);
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

const SEAT_SELECTION_AGY = {
  ...SEAT_SELECTION,
  seatId: 'fp-2',
  seatIndex: 1,
  model: 'model-example-2',
  tool: 'agy',
};

const COLLECTED_ARTIFACTS = {
  headCommit: COMMIT,
  commitsSinceBase: [COMMIT],
  collectedArtifactPaths: [],
  notes: 'present' as const,
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
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function receipt(stoppedByRequest: boolean) {
  return {
    attemptId: 'attempt-example-1',
    sessionId: 'session-example-1',
    endedAtIso: LATER,
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest,
  };
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

function dispatchKey(round = 0, seatIndex = 0, attemptOrdinal = 1): string {
  return stepKey({ round, step: 'dispatch', seatIndex, attemptOrdinal, head12: null });
}

function stopKey(round = 0, seatIndex = 0): string {
  return stepKey({ round, step: 'stop', seatIndex, attemptOrdinal: null, head12: null });
}

function collectKey(): string {
  return stepKey({ round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: null, head12: null });
}

function gateKey(): string {
  return stepKey({ round: 0, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

function reconcileKey(round = 0, seatIndex = 0): string {
  return RUN_ID + '/r' + round + '/reconcile/' + seatIndex;
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly dispatchRequests: readonly DispatchAttemptRequest[];
  readonly cancelRequests: readonly CancelPreparedAttemptRequest[];
  readonly stopRequests: readonly StopAttemptRequest[];
  readonly collectRequests: readonly CollectAttemptArtifactsRequest[];
  readonly gateRequests: readonly EvaluateAttemptGateRequest[];
  readonly reconcileCalls: unknown[];
  readonly runnerForRequests: readonly (AttemptRunnerRecord | null)[];
  readonly inspectCalls: readonly WorktreeRunRef[];
  readonly deps: AdvanceLaneRunDependencies;
  setReconcileAnswer(answer: ReconcileAttemptResult): void;
  setInspectAnswer(answer: WorktreeRunState): void;
  setStopAnswer(answer: (request: StopAttemptRequest) => Promise<StopAttemptResult>): void;
  setCollectAnswer(answer: (request: CollectAttemptArtifactsRequest) => Promise<CollectAttemptArtifactsResult>): void;
  setGateAnswer(answer: EvaluateAttemptGateResult): void;
}

interface HarnessOptions {
  /** When false, no `runnerForAttempt` port is wired (`ambiguous worktree-unknown`). */
  readonly wireRunnerForAttempt?: boolean;
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
  const dispatchRequests: DispatchAttemptRequest[] = [];
  const cancelRequests: CancelPreparedAttemptRequest[] = [];
  const stopRequests: StopAttemptRequest[] = [];
  const collectRequests: CollectAttemptArtifactsRequest[] = [];
  const gateRequests: EvaluateAttemptGateRequest[] = [];
  const reconcileCalls: unknown[] = [];
  const runnerForRequests: (AttemptRunnerRecord | null)[] = [];
  const inspectCalls: WorktreeRunRef[] = [];
  let reconcileAnswer: ReconcileAttemptResult = {
    outcome: 'refused',
    reason: 'the example reconcile never runs unless seeded',
  };
  let inspectAnswer: WorktreeRunState = { state: 'idle' };
  let stopAnswer: (request: StopAttemptRequest) => Promise<StopAttemptResult> = async () => ({
    outcome: 'refused',
    reason: 'the example stop never runs in a reconcile',
  });
  let collectAnswer: (request: CollectAttemptArtifactsRequest) => Promise<CollectAttemptArtifactsResult> = async (request) => {
    const existing = await attemptRepo.findAttemptById(request.attemptId);
    await attemptRepo.saveAttempt({
      ...(existing ?? attemptFixture({ id: request.attemptId })),
      revision: (existing?.revision ?? 0) + 1,
      state: 'collected',
      artifacts: COLLECTED_ARTIFACTS,
      updatedAtIso: LATER,
    });
    return { outcome: 'collected', artifacts: COLLECTED_ARTIFACTS };
  };
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
  const runnerFake: ExecutionRunnerPort = {
    describeCapabilities: (): RunnerIsolationCapabilities => ({
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: false,
      cpuAndMemoryLimited: false,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    }),
    startSession: async () => {
      throw new Error('the example runner never starts a session in a reconcile');
    },
    inspectSession: async () => {
      throw new Error('the example runner never inspects a session in a reconcile');
    },
    stopSession: async () => {
      throw new Error('the example runner never stops a session in a reconcile');
    },
    inspectWorktreeRun: async (ref) => {
      inspectCalls.push(ref);
      return inspectAnswer;
    },
  };
  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    artifactPort: {
      readBriefManifest: async () => JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] }),
      verifyArtifactManifest: async () => ({ outcome: 'sealed' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async (request) => {
        reconcileCalls.push(request);
        const answer = reconcileAnswer;
        if (
          answer.outcome === 'active' ||
          answer.outcome === 'ended' ||
          answer.outcome === 'unknown' ||
          answer.outcome === 'cancelled'
        ) {
          const existing = await attemptRepo.findAttemptById(answer.attempt.id);
          await attemptRepo.saveAttempt({ ...answer.attempt, revision: (existing?.revision ?? 0) + 1 });
        }
        return answer;
      },
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    cancelPreparedAttempt: {
      cancelPreparedAttempt: async (request) => {
        cancelRequests.push(request);
        const existing = await attemptRepo.findAttemptById(request.attemptId);
        if (existing !== null) {
          const cancelled: AttemptRecord = {
            ...existing,
            revision: (existing.revision ?? 0) + 1,
            state: 'cancelled',
            outcome: 'stopped',
            updatedAtIso: request.nowIso,
          };
          await attemptRepo.saveAttempt(cancelled);
          return { outcome: 'cancelled', attempt: cancelled, capacity: 'none-held' };
        }
        return { outcome: 'refused', reason: 'attempt-missing' };
      },
    },
    dispatchAttempt: {
      dispatchAttempt: async (request) => {
        dispatchRequests.push(request);
        const result: DispatchAttemptResult = {
          outcome: 'started',
          attempt: attemptFixture({ id: request.attemptId }),
          sessionId: 'session-example-9',
        };
        return result;
      },
    },
    stopAttempt: {
      stopAttempt: async (request) => {
        stopRequests.push(request);
        return stopAnswer(request);
      },
    },
    collectAttemptArtifacts: {
      collectAttemptArtifacts: async (request) => {
        collectRequests.push(request);
        return collectAnswer(request);
      },
    },
    evaluateAttemptGate: {
      evaluateAttemptGate: async (request) => {
        gateRequests.push(request);
        return gateAnswer;
      },
    },
    ...(options.wireRunnerForAttempt === false
      ? {}
      : {
          runnerForAttempt: {
            runnerForAttempt: (request) => {
              runnerForRequests.push(request.runner ?? null);
              return { ok: true, runner: runnerFake };
            },
          },
        }),
    newUlid: makeUlidMinter(),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    dispatchRequests,
    cancelRequests,
    stopRequests,
    collectRequests,
    gateRequests,
    reconcileCalls,
    runnerForRequests,
    inspectCalls,
    deps,
    setReconcileAnswer: (answer) => {
      reconcileAnswer = answer;
    },
    setInspectAnswer: (answer) => {
      inspectAnswer = answer;
    },
    setStopAnswer: (answer) => {
      stopAnswer = answer;
    },
    setCollectAnswer: (answer) => {
      collectAnswer = answer;
    },
    setGateAnswer: (answer) => {
      gateAnswer = answer;
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

async function reserveFor(harness: Harness, attemptId: string, hostName: string | null): Promise<void> {
  await harness.executionJournal.saveCapacityReservation({
    id: harness.deps.newUlid(),
    attemptId,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: 'agy',
    hostName,
    hostKind: 'agy',
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
}

async function resultsForKey(harness: Harness, key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
  const entries = await harness.runJournal.listForKey(key);
  return entries.filter((entry) => entry.kind === 'result');
}

describe('AdvanceLaneRunUseCase reconcile and crash-resume (K4-7)', () => {
  it('test 1: a dispatch started before the crash is reconciled dispatch-started; the dispatch fake is never called and the next advance enters running', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    harness.setReconcileAnswer({
      outcome: 'active',
      attempt: running,
      status: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: false,
      },
    });
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'reconciled',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toEqual([]);
    const results = await resultsForKey(harness, key);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'reconciled', reasonCode: 'dispatch-started' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'conduct', state: 'dispatching' });
    const next = await advance(harness);
    expect(next).toEqual({ outcome: 'entered', state: 'running' });
    expect(harness.dispatchRequests).toEqual([]);
  });

  it('test 2: a dispatch never started reads worktree idle, is not-started, and cancels the attempt so the key is never re-sent', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'not-started',
      reasonCode: 'worktree-idle',
    });
    expect(harness.dispatchRequests).toEqual([]);
    expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
    expect(stored?.state).toBe('cancelled');
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(laneRunAttemptDispatchResult(entries, RUN_ID, 'attempt-example-1')).toBe('not-started');
    const later = await advance(harness);
    expect(later).toMatchObject({ outcome: 'acted', step: 'prepare', key: expect.stringMatching(/\/a2$/) });
    expect(harness.dispatchRequests).toEqual([]);
    const journal = await harness.runJournal.listForRun(RUN_ID);
    expect(journal.filter((entry) => entry.kind === 'intent' && entry.key === key)).toHaveLength(1);
  });

  it('test 2b: an idle worktree whose cancel is refused stays ambiguous and never closes the key not-started', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const refusing: AdvanceLaneRunDependencies = {
      ...harness.deps,
      cancelPreparedAttempt: { cancelPreparedAttempt: async () => ({ outcome: 'refused', reason: 'changed' }) },
    };
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    const result = await new AdvanceLaneRunUseCase(refusing).advanceLaneRun({
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    });
    expect(result).toEqual({ outcome: 'acted', step: 'dispatch', key, result: 'ambiguous', reasonCode: 'worktree-unknown' });
    const results = await resultsForKey(harness, key);
    expect(results.map((entry) => entry.outcome)).toEqual(['ambiguous']);
    expect(laneRunAttemptDispatchResult(await harness.runJournal.listForRun(RUN_ID), RUN_ID, 'attempt-example-1')).not.toBe('not-started');
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('intent-recorded');
  });

  it('test 2c: a crash after the idle cancel but before its result re-enters as not-started, never runner-refused', async () => {
    const harness = await makeHarness(runRecord(), [
      // Exactly what CancelPreparedAttempt leaves: cancelled, outcome stopped, stop reason still 'none'.
      attemptFixture({ state: 'cancelled', outcome: 'stopped', sessionId: null }),
    ]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'acted', step: 'dispatch', key, result: 'not-started', reasonCode: 'worktree-idle' });
    expect(harness.cancelRequests).toEqual([]);
    expect(harness.dispatchRequests).toEqual([]);
  });

  it('test 2d: a runner-refused cancelled attempt (a stop reason class recorded) stays runner-refused', async () => {
    const harness = await makeHarness(runRecord(), [
      attemptFixture({ state: 'cancelled', outcome: 'stopped', sessionId: null, stopReason: 'no-route' } as never),
    ]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    expect(await advance(harness)).toMatchObject({ outcome: 'acted', step: 'dispatch', key, result: 'refused', reasonCode: 'runner-refused' });
  });

  it('test 6b: a crash after the prepare save but before its result appends the result once and keeps one id', async () => {
    const harness = await makeHarness(runRecord({ attemptIds: ['attempt-example-1'] }), [attemptFixture()]);
    const key = stepKey({ round: 0, step: 'prepare', seatIndex: 0, attemptOrdinal: 1, head12: null });
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'acted', step: 'prepare', key, result: 'reconciled', reasonCode: 'prepared' });
    expect((await harness.runRepo.get(RUN_ID))?.attemptIds).toEqual(['attempt-example-1']);
    expect(await resultsForKey(harness, key)).toHaveLength(1);
  });

  it('test 3: a busy worktree is ambiguous worktree-running; the next advance parks ambiguous dispatch and a parked advance waits', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    harness.setInspectAnswer({ state: 'running', sessionId: 'session-example-1' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'ambiguous',
      reasonCode: 'worktree-running',
    });
    expect(harness.dispatchRequests).toEqual([]);
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'dispatch' });
    const waiting = await advance(harness);
    expect(waiting).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.dispatchRequests).toEqual([]);
    expect(harness.inspectCalls).toHaveLength(1);
  });

  it('test 4: an unreadable worktree is ambiguous worktree-unknown and parks ambiguous dispatch', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    harness.setInspectAnswer({ state: 'unknown', reason: 'the example host is unreachable' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'ambiguous',
      reasonCode: 'worktree-unknown',
    });
    expect(harness.dispatchRequests).toEqual([]);
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'dispatch' });
  });

  it('test 5: a dispatching attempt without a session is reconciled by the runner; unknown is ambiguous dispatch-unknown', async () => {
    const dispatching = attemptFixture({ state: 'dispatching' });
    const harness = await makeHarness(runRecord(), [dispatching]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    harness.setReconcileAnswer({ outcome: 'unknown', attempt: dispatching, reason: 'the example transport died' });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'ambiguous',
      reasonCode: 'dispatch-unknown',
    });
    expect(harness.reconcileCalls).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    expect(harness.dispatchRequests).toEqual([]);
  });

  it('test 6: a prepare reconcile finds its minted attempt and completes the run record; an absent attempt is a spent ordinal', async () => {
    const savedCase = await makeHarness(runRecord({ attemptIds: [] }), [attemptFixture()]);
    const savedKey = stepKey({ round: 0, step: 'prepare', seatIndex: 0, attemptOrdinal: 1, head12: null });
    await appendIntent(savedCase, savedKey, 'attempt-example-1', NOW);
    const saved = await advance(savedCase);
    expect(saved).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: savedKey,
      result: 'reconciled',
      reasonCode: 'prepared',
    });
    const afterSaved = await savedCase.runRepo.get(RUN_ID);
    expect(afterSaved?.attemptIds).toEqual(['attempt-example-1']);

    const absentCase = await makeHarness(runRecord(), [attemptFixture()]);
    const absentKey = stepKey({ round: 0, step: 'prepare', seatIndex: 0, attemptOrdinal: 2, head12: null });
    await appendIntent(absentCase, absentKey, 'attempt-example-2', NOW);
    const absent = await advance(absentCase);
    expect(absent).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: absentKey,
      result: 'not-started',
      reasonCode: 'attempt-absent',
    });
    const afterAbsent = await absentCase.runRepo.get(RUN_ID);
    expect(afterAbsent?.attemptIds).toEqual(['attempt-example-1', 'attempt-example-2']);
    const next = await advance(absentCase);
    expect(next).toMatchObject({ outcome: 'acted', step: 'prepare', key: expect.stringMatching(/\/a3$/) });
  });

  it('test 7: a stop reconcile reads the record only: an ended attempt is stop-timeout, a running one stop-unconfirmed; the stop fake is never called', async () => {
    const endedHarness = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'ended', sessionId: 'session-example-1', completionReceipt: receipt(true) })],
    );
    await conduct(endedHarness, 'running', NOW);
    await appendIntent(endedHarness, stopKey(), null, NOW);
    const ended = await advance(endedHarness);
    expect(ended).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-timeout',
    });
    expect(endedHarness.stopRequests).toEqual([]);

    const runningHarness = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'running' })],
    );
    await conduct(runningHarness, 'running', NOW);
    await appendIntent(runningHarness, stopKey(), null, NOW);
    const running = await advance(runningHarness);
    expect(running).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: stopKey(),
      result: 'completed',
      reasonCode: 'stop-unconfirmed',
    });
    expect(runningHarness.stopRequests).toEqual([]);
  });

  it('test 8: a collect reconcile completes the collect: already collected records reconciled, an ended attempt is collected now', async () => {
    const collectedHarness = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS })],
    );
    await conduct(collectedHarness, 'collecting', NOW);
    await appendIntent(collectedHarness, collectKey(), null, NOW);
    const reconciled = await advance(collectedHarness);
    expect(reconciled).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'reconciled',
      reasonCode: 'collected',
    });
    expect(collectedHarness.collectRequests).toEqual([]);

    const endedHarness = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'ended', sessionId: 'session-example-1', completionReceipt: receipt(false) })],
    );
    await conduct(endedHarness, 'collecting', NOW);
    await appendIntent(endedHarness, collectKey(), null, NOW);
    const collected = await advance(endedHarness);
    expect(collected).toEqual({
      outcome: 'acted',
      step: 'collect',
      key: collectKey(),
      result: 'completed',
      reasonCode: 'collected',
    });
    expect(endedHarness.collectRequests).toHaveLength(1);
  });

  it('test 9: a gate reconcile evaluates again at the head and records the stored outcome', async () => {
    const harness = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS })],
    );
    await conduct(harness, 'gating', NOW);
    await appendIntent(harness, gateKey(), null, NOW);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'gate',
      key: gateKey(),
      result: 'completed',
      reasonCode: 'gate-passed',
    });
    expect(harness.gateRequests).toEqual([{ attemptId: 'attempt-example-1', candidateHeadSha: COMMIT }]);
    const results = await resultsForKey(harness, gateKey());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'completed', reasonCode: 'gate-passed' });
  });

  it('test 10: the G4j force reconcile journals the reconcile key, moves the attempt to reconciling, and the next advance stops it once', async () => {
    const prepared = attemptFixture();
    const harness = await makeHarness(runRecord(), [prepared]);
    await appendIntent(harness, dispatchKey(), 'attempt-example-1', NOW);
    await appendResult(harness, dispatchKey(), 'completed', 'dispatch-started', NOW);
    const stopControl = {
      ...laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, RUN_ID + '/stop-force@web', null, NOW),
      mode: 'force' as const,
      expectedRevision: 1,
    };
    const stopAppended = await harness.runJournal.append(stopControl);
    expect(stopAppended.outcome).toBe('appended');
    await conduct(harness, 'running', NOW);
    // K4-1's pinned behaviour: the reconcile port moves the record from
    // intent-recorded to reconciling; the fake saves and answers it.
    const reconciling = attemptFixture({ state: 'reconciling' });
    harness.setReconcileAnswer({
      outcome: 'active',
      attempt: reconciling,
      status: {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: false,
      },
    });
    const key = reconcileKey();
    const result = await advance(harness);
    expect(result).toMatchObject({
      outcome: 'acted',
      key,
      result: 'reconciled',
      reasonCode: 'reconciled',
    });
    const entries = await harness.runJournal.listForKey(key);
    expect(entries[0]).toMatchObject({ kind: 'intent', key, mintedId: 'attempt-example-1' });
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'result', key, outcome: 'reconciled' });
    expect(harness.reconcileCalls).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
    expect(stored?.state).toBe('reconciling');
    harness.setStopAnswer(async (request) => {
      const existing = await harness.attemptRepo.findAttemptById(request.attemptId);
      const ended: AttemptRecord = {
        ...(existing ?? attemptFixture({ id: request.attemptId })),
        revision: (existing?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'stopped',
        completionReceipt: receipt(true),
        updatedAtIso: request.nowIso ?? LATER,
      };
      await harness.attemptRepo.saveAttempt(ended);
      return { outcome: 'terminated', attempt: ended, receipt: receipt(true), capacityReleased: true };
    });
    const stopped = await advance(harness);
    expect(stopped).toMatchObject({ outcome: 'acted', step: 'stop', result: 'completed' });
    expect(harness.stopRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
  });

  it('test 11: an agy worktree read resolves the runner from the held reservation host; without one it stays ambiguous and never resolves a runner', async () => {
    const agyAttempt = attemptFixture({ seatSelection: SEAT_SELECTION_AGY });
    const harness = await makeHarness(runRecord(), [agyAttempt]);
    const key = dispatchKey();
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    await reserveFor(harness, 'attempt-example-1', 'agy-example');
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'not-started',
      reasonCode: 'worktree-idle',
    });
    expect(harness.runnerForRequests).toEqual([
      {
        kind: 'agy',
        hostName: 'agy-example',
        remotePort: null,
        host: null,
        agent: null,
        model: null,
        variant: null,
      },
    ]);
    expect(harness.inspectCalls).toEqual([
      { attemptId: 'attempt-example-1', worktreePath: WORKTREE, runner: harness.runnerForRequests[0] },
    ]);
    expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    expect(harness.dispatchRequests).toEqual([]);

    const noHostHarness = await makeHarness(runRecord(), [agyAttempt]);
    await appendIntent(noHostHarness, key, 'attempt-example-1', NOW);
    const noHost = await advance(noHostHarness);
    expect(noHost).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'ambiguous',
      reasonCode: 'worktree-unknown',
    });
    expect(noHostHarness.runnerForRequests).toEqual([]);
  });

  it('test 12: the G4j force reconcile refuses an agy attempt with no runner record and the next advance parks ambiguous', async () => {
    const agyAttempt = attemptFixture({ seatSelection: SEAT_SELECTION_AGY });
    const harness = await makeHarness(runRecord(), [agyAttempt]);
    await appendIntent(harness, dispatchKey(), 'attempt-example-1', NOW);
    await appendResult(harness, dispatchKey(), 'completed', 'dispatch-started', NOW);
    const stopControl = {
      ...laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, RUN_ID + '/stop-force@web', null, NOW),
      mode: 'force' as const,
      expectedRevision: 1,
    };
    const stopAppended = await harness.runJournal.append(stopControl);
    expect(stopAppended.outcome).toBe('appended');
    await conduct(harness, 'running', NOW);
    const key = reconcileKey();
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'ambiguous',
      reasonCode: 'worktree-unknown',
    });
    const entries = await harness.runJournal.listForKey(key);
    expect(entries[0]).toMatchObject({ kind: 'intent', key, mintedId: 'attempt-example-1' });
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'result', key, outcome: 'ambiguous' });
    expect(harness.reconcileCalls).toEqual([]);
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'reconcile' });
  });
});
