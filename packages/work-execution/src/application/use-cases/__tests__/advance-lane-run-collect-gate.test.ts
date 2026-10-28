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
  setManifest(json: string | null): void;
  setReconcileAnswer(answer: ReconcileAttemptResult): void;
  setStopAnswer(answer: (request: StopAttemptRequest) => Promise<StopAttemptResult>): void;
  setCollectAnswer(answer: (request: CollectAttemptArtifactsRequest) => Promise<CollectAttemptArtifactsResult>): void;
  setCommitAnswer(answer: CommitEditOnlyAttemptResult): void;
  setGateAnswer(answer: EvaluateAttemptGateResult): void;
}

interface HarnessOptions {
  readonly ceiling?: number;
  readonly wireStop?: boolean;
  readonly wireCollect?: boolean;
  readonly wireCommit?: boolean;
  readonly wireGate?: boolean;
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
  const callOrder: string[] = [];
  let manifestJson: string | null = JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] });
  let reconcileAnswer: ReconcileAttemptResult = activeAnswer(attempts[attempts.length - 1] ?? attemptFixture());
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
      verifyArtifactManifest: async () => ({ outcome: 'missing' }),
    },
    reconcileAttempt: {
      reconcileAttempt: async () => reconcileAnswer,
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
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
    callOrder,
    deps,
    setManifest: (json) => {
      manifestJson = json;
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
    const ended = endedAttempt({ runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'model-example-1', variant: null } });
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
});
