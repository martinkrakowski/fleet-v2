/**
 * Unit tests for K4-4b: `AdvanceLaneRunUseCase.gatherFacts` in full. Fact
 * gathering reads the lane's end from the runner through reconcile, the
 * deadline from the frozen time limit (a running lane with no readable limit
 * parks ambiguous stop), the timeout from the run journal, admission from held
 * reservations (admitting a prepared attempt on the decider's wait, never
 * while halted), the cost ceiling from recorded usage, and the implementer
 * seat by selectSeat over the run's attempts with their timeouts. Every store
 * is in-memory; no runner, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { ArtifactManifest } from '../../../domain/artifact-manifest.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import { collectionFactOf } from '../advance-lane-run/facts.js';
import type { LaneRunAdmissionResult } from '../../ports/out/LaneRunAdmissionPort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const HEAD12 = 'a'.repeat(12);
const PROSE = '# brief\n';
const DEFAULT_MANIFEST_JSON = JSON.stringify({ timeLimitSeconds: 3600 });
const digestFor = (json: string): string => simpleDeterministicHexDigest(PROSE + '\n' + json);

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

const SEAT_SELECTION_FP2 = {
  role: 'first-pass' as const,
  seatIndex: 1,
  seatId: 'fp-2',
  model: 'model-example-2',
  tool: 'opencode',
  variant: null,
  agent: null,
};

/** The recorded host of a conducted attempt (KF-10/Q2a-2 invariant). */
const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/opencode/wo-example-1/wt-example-1',
    baseCommit: COMMIT,
    state: 'intent-recorded',
    outcome: null,
    briefDigest: digestFor(DEFAULT_MANIFEST_JSON),
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

/** A run record via the domain entity, like the decider's fixture. */
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

function endedAnswer(attempt: AttemptRecord, receipt: AttemptRecord['completionReceipt']): ReconcileAttemptResult {
  return {
    outcome: 'ended',
    attempt,
    receipt: receipt ?? {
      attemptId: attempt.id,
      sessionId: attempt.sessionId ?? 'session-example-1',
      endedAtIso: LATER,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
  };
}

function cancelledAnswer(attempt: AttemptRecord, reason: string): ReconcileAttemptResult {
  return { outcome: 'cancelled', attempt, reason };
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly admissionCalls: unknown[];
  readonly reconcileCalls: unknown[];
  readonly deps: AdvanceLaneRunDependencies;
  setManifest(json: string | null): void;
  setReconcileAnswer(answer: ReconcileAttemptResult): void;
  setAdmissionAnswer(answer: LaneRunAdmissionResult): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
  options: { readonly ceiling?: number } = {},
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const admissionCalls: unknown[] = [];
  const reconcileCalls: unknown[] = [];
  let manifestJson: string | null = DEFAULT_MANIFEST_JSON;
  let reconcileAnswer: ReconcileAttemptResult = activeAnswer(attempts[attempts.length - 1] ?? attemptFixture());
  let admissionAnswer: LaneRunAdmissionResult = { outcome: 'admitted' };
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
      readBriefFile: async () => PROSE,
      verifyArtifactManifest: async () => ({ outcome: 'missing' }),
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
      admit: async (request) => {
        admissionCalls.push(request);
        return admissionAnswer;
      },
    },
    newUlid: makeUlidMinter(),
    ...(options.ceiling !== undefined ? { perLaneCostCeiling: options.ceiling } : {}),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    admissionCalls,
    reconcileCalls,
    deps,
    setManifest: (json) => {
      manifestJson = json;
    },
    setReconcileAnswer: (answer) => {
      reconcileAnswer = answer;
    },
    setAdmissionAnswer: (answer) => {
      admissionAnswer = answer;
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

function stepKey(parts: {
  readonly round: number;
  readonly step: 'dispatch' | 'stop' | 'gate' | 'prepare';
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
  outcome: 'completed',
  reasonCode: LaneRunResultReasonCode,
  recordedAtIso: string,
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

function dispatchIntentAndResult(harness: Harness, round: number, seatIndex: number, attemptOrdinal: number, at: string): Promise<void> {
  const key = stepKey({ round, step: 'dispatch', seatIndex, attemptOrdinal, head12: null });
  return appendIntent(harness, key, 'attempt-example-' + attemptOrdinal, at).then(() =>
    appendResult(harness, key, 'completed', 'dispatch-started', at),
  );
}

describe('AdvanceLaneRunUseCase facts (K4-4b)', () => {
  it('test 1: a prepared attempt under no-capacity waits and admits once; with a held reservation it dispatches', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const waited = await advance(harness);
    expect(waited).toEqual({ outcome: 'waiting', reason: 'admission' });
    expect(harness.admissionCalls).toEqual([
      {
        attemptId: 'attempt-example-1',
        workOrderId: 'wo-example-1',
        seatTool: 'opencode',
        worktreePath: '/tmp/opencode/wo-example-1/wt-example-1',
        nowIso: LATER,
      },
    ]);
    await harness.executionJournal.saveCapacityReservation({
      id: harness.deps.newUlid(),
      attemptId: 'attempt-example-1',
      hostId: 'host-example-1',
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      reservedAtIso: NOW,
      releasedAtIso: null,
    });
    const dispatched = await advance(harness);
    // K4-5 built the dispatch act; this harness wires no dispatch port, so the
    // reached decision reports not-wired (the old not-built pin is superseded).
    expect(dispatched).toEqual({ outcome: 'not-wired', step: 'dispatch' });
    expect(harness.admissionCalls).toHaveLength(1);
  });

  it('test 2: while halted a prepared attempt parks halted and never admits', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const result = await advance(harness, { halted: true });
    expect(result).toEqual({ outcome: 'parked', reason: 'halted', qualifier: null });
    expect(harness.admissionCalls).toEqual([]);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toEqual({
      reason: 'halted',
      qualifier: null,
      parkedFrom: 'ready',
      questionId: null,
    });
    expect(after?.parkCount).toBe(1);
    expect(after?.revision).toBe(2);
    expect(await lastJournalState(harness)).toBe('parked');
  });

  it('test 3: a running attempt with a session is reconciled; an ended answer enters collecting', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    harness.setReconcileAnswer(endedAnswer(attemptFixture({ state: 'ended', sessionId: 'session-example-1' }), null));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'entered', state: 'collecting' });
    expect(harness.reconcileCalls).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
  });

  it('test 4: a cancelled reconcile enters seat-failed; the next prepare pivots past fp-1', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await dispatchIntentAndResult(harness, 0, 0, 1, NOW);
    harness.setReconcileAnswer(
      cancelledAnswer(attemptFixture({ state: 'cancelled', sessionId: null, stopReason: 'rate-limited' }), 'rate-limited'),
    );
    const failed = await advance(harness);
    expect(failed).toEqual({ outcome: 'entered', state: 'seat-failed' });
    const prepared = await advance(harness);
    // K4-5 built the prepare act: the pivot prepares a fresh attempt on fp-2
    // under the r0/prepare/1/a2 key (the old not-built pin is superseded).
    expect(prepared).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: stepKey({ round: 0, step: 'prepare', seatIndex: 1, attemptOrdinal: 2, head12: null }),
      result: 'completed',
      reasonCode: 'prepared',
    });
    expect(harness.reconcileCalls).toHaveLength(1);
  });

  it('test 5: a running attempt past its time limit decides stop; unwired it is not-wired', async () => {
    // Regression guard (SEC-5a): a matching manifest still yields the deadline
    // and the stop decision.
    const running = attemptFixture({
      state: 'running',
      sessionId: 'session-example-1',
      briefDigest: digestFor(JSON.stringify({ timeLimitSeconds: 2700 })),
    });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await dispatchIntentAndResult(harness, 0, 0, 1, '2026-10-27T09:10:00.000Z');
    harness.setReconcileAnswer(activeAnswer(running));
    harness.setManifest(JSON.stringify({ timeLimitSeconds: 2700 }));
    const result = await advance(harness);
    // K4-6 built the stop act; this harness wires no stop port, so the reached
    // decision reports not-wired (the old not-built pin is superseded).
    expect(result).toEqual({ outcome: 'not-wired', step: 'stop' });
  });

  it('test 12: a running attempt whose on-disk manifest changed after dispatch parks ambiguous stop', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await dispatchIntentAndResult(harness, 0, 0, 1, '2026-10-27T09:10:00.000Z');
    harness.setReconcileAnswer(activeAnswer(running));
    // The on-disk manifest changed after dispatch: its digest no longer matches
    // the attempt's recorded `briefDigest` (SEC-5a), so the run parks instead
    // of silently extending the deadline.
    harness.setManifest(JSON.stringify({ timeLimitSeconds: 360000 }));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'stop' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toEqual({
      reason: 'ambiguous',
      qualifier: 'stop',
      parkedFrom: 'running',
      questionId: null,
    });
    expect(after?.parkCount).toBe(1);
    expect(after?.revision).toBe(2);
    expect(await lastJournalState(harness)).toBe('parked');
  });

  it('test 6: a running attempt with no readable limit parks ambiguous stop', async () => {
    const running = attemptFixture({ state: 'running', sessionId: 'session-example-1' });
    const harness = await makeHarness(runRecord(), [running]);
    await conduct(harness, 'running', NOW);
    await dispatchIntentAndResult(harness, 0, 0, 1, '2026-10-27T09:10:00.000Z');
    harness.setReconcileAnswer(activeAnswer(running));
    harness.setManifest(JSON.stringify({}));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'stop' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toEqual({
      reason: 'ambiguous',
      qualifier: 'stop',
      parkedFrom: 'running',
      questionId: null,
    });
    expect(after?.parkCount).toBe(1);
    expect(after?.revision).toBe(2);
    expect(await lastJournalState(harness)).toBe('parked');
  });

  it('test 7: a run over the cost ceiling parks cost-ceiling in seat-failed', async () => {
    const usage = (costUsd: number) => ({
      source: 'opencode-db' as const,
      readAtIso: NOW,
      sessionId: null,
      steps: null,
      wallSeconds: null,
      tokensInput: null,
      tokensOutput: null,
      tokensReasoning: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      costUsd,
      model: null,
      agent: null,
      reason: null,
    });
    const first = attemptFixture({ id: 'attempt-example-1', state: 'ended', usage: usage(0.6) });
    const second = attemptFixture({ id: 'attempt-example-2', state: 'ended', usage: usage(0.5) });
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [first, second],
      { ceiling: 1 },
    );
    await conduct(harness, 'seat-failed', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'cost-ceiling', qualifier: null });
  });

  it('test 8a: a passed gate at the head enters brief-check', async () => {
    const collected = attemptFixture({
      state: 'collected',
      artifacts: {
        headCommit: COMMIT,
        commitsSinceBase: [COMMIT],
        collectedArtifactPaths: [],
        notes: 'present',
      },
    });
    const harness = await makeHarness(runRecord(), [collected]);
    await conduct(harness, 'gating', NOW);
    const gate = stepKey({ round: 0, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
    await appendIntent(harness, gate, null, NOW);
    await appendResult(harness, gate, 'completed', 'gate-passed', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'entered', state: 'brief-check' });
  });

  it('test 8b: a failed gate in round 0 enters fixing', async () => {
    const collected = attemptFixture({
      state: 'collected',
      artifacts: {
        headCommit: COMMIT,
        commitsSinceBase: [COMMIT],
        collectedArtifactPaths: [],
        notes: 'present',
      },
    });
    const harness = await makeHarness(runRecord(), [collected]);
    await conduct(harness, 'gating', NOW);
    const gate = stepKey({ round: 0, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
    await appendIntent(harness, gate, null, NOW);
    await appendResult(harness, gate, 'completed', 'gate-failed', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'entered', state: 'fixing' });
  });

  it('test 9: a timed-out fp-1 attempt rotates the implementer seat to fp-2', async () => {
    const first = attemptFixture({
      id: 'attempt-example-1',
      state: 'ended',
      stopReason: 'none',
      createdAtIso: NOW,
      updatedAtIso: NOW,
    });
    const second = attemptFixture({
      id: 'attempt-example-2',
      state: 'ended',
      stopReason: 'none',
      seatSelection: SEAT_SELECTION_FP2,
      createdAtIso: LATER,
      updatedAtIso: LATER,
    });
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [first, second],
    );
    await dispatchIntentAndResult(harness, 0, 0, 1, NOW);
    const stop = stepKey({ round: 0, step: 'stop', seatIndex: 0, attemptOrdinal: null, head12: null });
    await appendIntent(harness, stop, null, NOW);
    await appendResult(harness, stop, 'completed', 'stop-timeout', NOW);
    const secondKey = stepKey({ round: 1, step: 'dispatch', seatIndex: 0, attemptOrdinal: 2, head12: null });
    await appendIntent(harness, secondKey, 'attempt-example-2', LATER);
    await appendResult(harness, secondKey, 'completed', 'dispatch-started', LATER);
    await conduct(harness, 'seat-failed', NOW);
    const result = await advance(harness);
    // K4-5 built the prepare act: the rotated seat (fp-2, index 1) prepares
    // under the r0/prepare/1/a3 key (the old not-built pin is superseded).
    expect(result).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: stepKey({ round: 0, step: 'prepare', seatIndex: 1, attemptOrdinal: 3, head12: null }),
      result: 'completed',
      reasonCode: 'prepared',
    });
  });

  it('test 10: a refused admit parks the run step-refused dispatch so the owner sees it', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setAdmissionAnswer({ outcome: 'refused', reason: 'run-host-unknown' });
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toEqual({
      reason: 'step-refused',
      qualifier: 'dispatch',
      parkedFrom: 'ready',
      questionId: null,
    });
    expect(after?.parkCount).toBe(1);
    expect(after?.revision).toBe(2);
    expect(await lastJournalState(harness)).toBe('parked');
  });

  it('test 11: a no-capacity admit keeps waiting admission and never parks', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setAdmissionAnswer({ outcome: 'no-capacity' });
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'admission' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toBeNull();
    expect(after?.parkCount).toBe(0);
  });
});

describe('collectionFactOf headUnchanged (KF-21c)', () => {
  const artifactPort = {
    verifyArtifactManifest: async () => ({ outcome: 'sealed' as const, manifest: {} as ArtifactManifest }),
  };
  const collected = (overrides: Partial<AttemptRecord> = {}): AttemptRecord =>
    attemptFixture({
      state: 'collected',
      artifacts: {
        headCommit: COMMIT,
        commitsSinceBase: [COMMIT],
        collectedArtifactPaths: [],
        notes: 'present',
      },
      ...overrides,
    });

  it('a fix attempt collected at its prior head is headUnchanged', async () => {
    const prior = collected({ id: 'attempt-example-1', kind: 'initial', priorAttemptId: null });
    const latest = collected({ id: 'attempt-example-2', kind: 'fix', priorAttemptId: 'attempt-example-1' });
    expect(await collectionFactOf(latest, prior, artifactPort)).toEqual({
      commits: 1,
      manifest: 'sealed',
      headUnchanged: true,
    });
  });

  it('a fix attempt at a new head is not headUnchanged', async () => {
    const prior = collected({ id: 'attempt-example-1', kind: 'initial', priorAttemptId: null });
    const latest = collected({
      id: 'attempt-example-2',
      kind: 'fix',
      priorAttemptId: 'attempt-example-1',
      artifacts: {
        headCommit: 'b'.repeat(40),
        commitsSinceBase: [COMMIT, 'b'.repeat(40)],
        collectedArtifactPaths: [],
        notes: 'present',
      },
    });
    expect(await collectionFactOf(latest, prior, artifactPort)).toEqual({
      commits: 2,
      manifest: 'sealed',
      headUnchanged: false,
    });
  });

  it('a first-pass attempt is never headUnchanged', async () => {
    const prior = collected({ id: 'attempt-example-0', kind: 'initial', priorAttemptId: null });
    const latest = collected({ id: 'attempt-example-1', kind: 'initial', priorAttemptId: null });
    expect(await collectionFactOf(latest, prior, artifactPort)).toEqual({
      commits: 1,
      manifest: 'sealed',
      headUnchanged: false,
    });
  });

  it('a missing prior is never headUnchanged', async () => {
    const latest = collected({ id: 'attempt-example-2', kind: 'fix', priorAttemptId: 'attempt-example-1' });
    expect(await collectionFactOf(latest, null, artifactPort)).toEqual({
      commits: 1,
      manifest: 'sealed',
      headUnchanged: false,
    });
  });
});
