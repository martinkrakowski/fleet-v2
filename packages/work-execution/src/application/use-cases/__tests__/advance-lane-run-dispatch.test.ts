/**
 * Unit tests for K4-5: the conductor acts `prepare` (the round-0 seat pivot),
 * `dispatch` (through `DispatchAttemptPort`, with the pivot's conductor seat
 * override) and the G4e `cancel` (through `CancelPreparedAttemptPort`). Each
 * writes its keyed intent first, performs the one action, saves the record it
 * needs, then appends the result entry; a dispatch refused before any save
 * parks for the owner, and a one-way key is never sent twice. Every store is
 * in-memory; no runner, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey, laneRunStopKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type {
  DispatchAttemptRequest,
  DispatchAttemptResult,
} from '../../ports/in/DispatchAttemptPort.in-port.js';
import type {
  CancelPreparedAttemptRequest,
  CancelPreparedAttemptResult,
} from '../../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type { SessionStartGate } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import { SessionStartSpacing } from '../advance-lane-run/session-start-gate.js';
import type {
  PreserveWorktreeEditsRequest,
  PreserveWorktreeEditsResult,
  ResetWorktreeToHeadRequest,
  ResetWorktreeToHeadResult,
} from '../../ports/out/WorkspacePort.out-port.js';

function denyingStartGate(): SessionStartGate {
  return { tryStart: () => ({ ok: false, retryAfterMs: 12_345 }) };
}

function grantingStartGate(): SessionStartGate {
  return { tryStart: () => ({ ok: true }) };
}

/** CO13: a gate whose endpoint rule always denies; the global rule grants. */
function denyingEndpointGate(): SessionStartGate {
  return {
    tryStart: () => ({ ok: true }),
    tryStartForEndpoint: () => ({ ok: false, retryAfterMs: 12_345 }),
  };
}

/** CO13: a gate whose endpoint rule always grants; the global rule grants. */
function grantingEndpointGate(): SessionStartGate {
  return {
    tryStart: () => ({ ok: true }),
    tryStartForEndpoint: () => ({ ok: true }),
  };
}

/** Fix round 1: an endpoint rule that denies only when a durable seed exists; it records each seed. */
function seededEndpointGate() {
  const seeds: (string | null)[] = [];
  const gate: SessionStartGate & { readonly seeds: typeof seeds } = {
    seeds,
    tryStart: () => ({ ok: true }),
    tryStartForEndpoint: (_runId, _nowIso, _endpointKey, lastStartIso) => {
      seeds.push(lastStartIso);
      return lastStartIso === null ? { ok: true } : { ok: false, retryAfterMs: 12_345 };
    },
  };
  return gate;
}

/**
 * Fix round 3: a gate whose endpoint rule grants (holding the start) and
 * records every endpoint ask and every release; the global rule answers as
 * given.
 */
function recordingEndpointGate(globalOk = true) {
  const asks: string[] = [];
  const releases: string[] = [];
  const gate: SessionStartGate & { readonly asks: typeof asks; readonly releases: typeof releases } = {
    asks,
    releases,
    tryStart: () => (globalOk ? { ok: true } : { ok: false, retryAfterMs: 5_000 }),
    tryStartForEndpoint: (_runId, _nowIso, endpointKey) => {
      asks.push(endpointKey);
      return { ok: true };
    },
    releaseStartForEndpoint: (runId) => {
      releases.push(runId);
    },
  };
  return gate;
}

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const PROSE = '# brief\n';
const DEFAULT_MANIFEST_JSON = JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] });
const digestFor = (json: string): string => simpleDeterministicHexDigest(PROSE + '\n' + json);
const SHA = digestFor(DEFAULT_MANIFEST_JSON);

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

const SEAT_PLAN_ONE = {
  version: 1 as const,
  'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [],
};

const SEAT_PLAN_AGY_PIVOT = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'agy' },
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
const CONDUCTED_RUNNER: AttemptRunnerRecord = {
  kind: 'opencode',
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

function usageRecord(costUsd: number) {
  return {
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
  readonly step: 'dispatch' | 'stop' | 'prepare';
  readonly seatIndex: number;
  readonly attemptOrdinal: number | null;
}): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: parts.round,
    step: parts.step,
    seatIndex: parts.seatIndex,
    attemptOrdinal: parts.attemptOrdinal,
    head12: null,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a step key');
  }
  return built.key;
}

function dispatchKey(round: number, seatIndex: number, attemptOrdinal: number): string {
  return stepKey({ round, step: 'dispatch', seatIndex, attemptOrdinal });
}

function prepareKey(round: number, seatIndex: number, attemptOrdinal: number): string {
  return stepKey({ round, step: 'prepare', seatIndex, attemptOrdinal });
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly dispatchRequests: readonly DispatchAttemptRequest[];
  readonly manifestReads: readonly (AttemptRunnerRecord | null)[];
  readonly cancelRequests: readonly CancelPreparedAttemptRequest[];
  readonly preserveRequests: readonly PreserveWorktreeEditsRequest[];
  readonly resetRequests: readonly ResetWorktreeToHeadRequest[];
  readonly deps: AdvanceLaneRunDependencies;
  setManifest(json: string | null): Promise<void>;
  setChangedManifestOnDisk(json: string | null): void;
  setDispatchAnswer(answer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult>): void;
  setCancelAnswer(answer: CancelPreparedAttemptResult): void;
  setPreserveAnswer(answer: (request: PreserveWorktreeEditsRequest) => Promise<PreserveWorktreeEditsResult>): void;
  setResetAnswer(answer: (request: ResetWorktreeToHeadRequest) => Promise<ResetWorktreeToHeadResult>): void;
  markAttemptCancelled(attemptId: string, stopReason: AttemptRecord['stopReason']): Promise<void>;
}

interface HarnessOptions {
  readonly ceiling?: number;
  /** When false, no `dispatchAttempt` port is wired (`not-wired dispatch`). */
  readonly wireDispatch?: boolean;
  /** When true, the GB3 worktree recovery port is wired (preserve/reset fakes). */
  readonly wireRecovery?: boolean;
  /** A run repository whose `save` refuses or throws (save-order tests). */
  readonly runSave?: 'ok' | 'refuse' | 'throw';
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
  const runSave = options.runSave ?? 'ok';
  const runRepoPort: LaneRunRepositoryPort =
    runSave === 'ok'
      ? runRepo
      : {
          create: (created) => runRepo.create(created),
          save: async () => {
            if (runSave === 'throw') {
              throw new Error('example run save failure');
            }
            return { outcome: 'refused', reason: 'stale-revision' };
          },
          get: (runId) => runRepo.get(runId),
          list: () => runRepo.list(),
          acquireLease: (runId, request) => runRepo.acquireLease(runId, request),
          renewLease: (runId, request) => runRepo.renewLease(runId, request),
          releaseLease: (runId, request) => runRepo.releaseLease(runId, request),
        };
  const dispatchRequests: DispatchAttemptRequest[] = [];
  const manifestReads: (AttemptRunnerRecord | null)[] = [];
  let dispatchAnswer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult> = async (request) => ({
    outcome: 'started',
    attempt: attemptFixture({ id: request.attemptId }),
    sessionId: 'session-example-1',
  });
  const cancelRequests: CancelPreparedAttemptRequest[] = [];
  let cancelAnswer: CancelPreparedAttemptResult = { outcome: 'cancelled', attempt: attemptFixture(), capacity: 'released' };
  const preserveRequests: PreserveWorktreeEditsRequest[] = [];
  const resetRequests: ResetWorktreeToHeadRequest[] = [];
  let preserveAnswer: (request: PreserveWorktreeEditsRequest) => Promise<PreserveWorktreeEditsResult> = async (request) => ({
    outcome: 'preserved',
    patchPath: request.patchPath,
    patchBytes: 42,
  });
  let resetAnswer: (request: ResetWorktreeToHeadRequest) => Promise<ResetWorktreeToHeadResult> = async () => ({
    outcome: 'reset',
    headCommit: COMMIT,
  });
  let manifestJson: string | null = DEFAULT_MANIFEST_JSON;
  const created = await runRepoPort.create(record);
  expect(created.outcome).toBe('saved');
  const leased = await runRepoPort.acquireLease(record.runId, {
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
    runRepo: runRepoPort,
    runJournal,
    attemptRepo,
    executionJournal,
    artifactPort: {
      readBriefManifest: async (_worktreePath, _manifestPath, recordedHost) => {
        manifestReads.push(recordedHost ?? null);
        return manifestJson;
      },
      readBriefFile: async () => PROSE,
      verifyArtifactManifest: async () => ({ outcome: 'missing' }),
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({ outcome: 'refused', reason: 'not-found' }),
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    // G11a: a bound family comparator is what lets a refused dispatch record
    // its next-seat advance instead of failing closed.
    sameModelFamily: (left, right) => left.split('-')[0] === right.split('-')[0],
    newUlid: makeUlidMinter(),
    ...(options.ceiling !== undefined ? { perLaneCostCeiling: options.ceiling } : {}),
    ...(options.wireDispatch === false
      ? {}
      : {
          dispatchAttempt: {
            dispatchAttempt: async (request) => {
              dispatchRequests.push(request);
              return dispatchAnswer(request);
            },
          },
        }),
    cancelPreparedAttempt: {
      cancelPreparedAttempt: async (request) => {
        cancelRequests.push(request);
        if (cancelAnswer.outcome === 'cancelled') {
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
            return { outcome: 'cancelled', attempt: cancelled, capacity: cancelAnswer.capacity };
          }
        }
        return cancelAnswer;
      },
    },
    ...(options.wireRecovery
      ? {
          worktreeRecovery: {
            preserveWorktreeEdits: async (request) => {
              preserveRequests.push(request);
              return preserveAnswer(request);
            },
            resetWorktreeToHead: async (request) => {
              resetRequests.push(request);
              return resetAnswer(request);
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
    dispatchRequests,
    manifestReads,
    cancelRequests,
    preserveRequests,
    resetRequests,
    deps,
    setManifest: async (json) => {
      manifestJson = json;
      // SEC-5b: a re-frozen manifest re-freezes the stored attempts' digests
      // too, so every read of the served manifest verifies against it.
      if (json !== null) {
        const digest = digestFor(json);
        for (const attempt of await attemptRepo.listAllAttempts()) {
          if (attempt.briefDigest !== digest) {
            await attemptRepo.saveAttempt({
              ...attempt,
              revision: (attempt.revision ?? 0) + 1,
              briefDigest: digest,
            });
          }
        }
      }
    },
    // The changed-on-disk path (SEC-5b): the served manifest changes without
    // any attempt digest being re-frozen — every digest read then mismatches.
    setChangedManifestOnDisk: (json) => {
      manifestJson = json;
    },
    setDispatchAnswer: (answer) => {
      dispatchAnswer = answer;
    },
    setCancelAnswer: (answer) => {
      cancelAnswer = answer;
    },
    setPreserveAnswer: (answer) => {
      preserveAnswer = answer;
    },
    setResetAnswer: (answer) => {
      resetAnswer = answer;
    },
    markAttemptCancelled: async (attemptId, stopReason) => {
      const existing = await attemptRepo.findAttemptById(attemptId);
      expect(existing).not.toBeNull();
      await attemptRepo.saveAttempt({
        ...attemptFixture({ id: attemptId }),
        revision: (existing?.revision ?? 0) + 1,
        state: 'cancelled',
        stopReason,
        updatedAtIso: LATER,
      });
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

async function admit(harness: Harness, attemptId: string): Promise<void> {
  await harness.executionJournal.saveCapacityReservation({
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

describe('AdvanceLaneRunUseCase dispatch, prepare and cancel acts (K4-5)', () => {
  it('test 1: a prepared, admitted attempt in ready dispatches once and records dispatching', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    const request = harness.dispatchRequests[0];
    expect(request.attemptId).toBe('attempt-example-1');
    expect(request.worktreePath).toBe(WORKTREE);
    expect(request.briefDigest).toBe(SHA);
    expect(request.stepLimit).toBe(100);
    expect(request.timeLimitSeconds).toBe(2700);
    expect(request.expectedArtifacts).toEqual([]);
    expect(request.seatOverride).toBeUndefined();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'intent', key, mintedId: 'attempt-example-1' });
    expect(entries[1]).toMatchObject({ kind: 'result', key, outcome: 'completed', reasonCode: 'dispatch-started' });
    expect(entries[2]).toMatchObject({ kind: 'conduct', state: 'dispatching' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.cursors['first-pass']).toBe(0);
  });

  it('test 2: a runner refusal with a cancelled attempt pivots: dispatching, seat-failed, then prepare seat 1', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async (request) => {
      await harness.markAttemptCancelled(request.attemptId, 'rate-limited');
      return { outcome: 'refused', reason: '429 rate limited' };
    });
    await admit(harness, 'attempt-example-1');
    const dispatched = await advance(harness);
    expect(dispatched).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: dispatchKey(0, 0, 1),
      result: 'refused',
      reasonCode: 'runner-refused',
    });
    expect(await lastJournalState(harness)).toBe('dispatching');
    const failed = await advance(harness);
    expect(failed).toEqual({ outcome: 'entered', state: 'seat-failed' });
    const prepared = await advance(harness);
    expect(prepared).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(0, 1, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
  });

  it('test 3: the pivot prepare mints a second intent-recorded attempt bound to fp-2 under the /a2 key', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async (request) => {
      await harness.markAttemptCancelled(request.attemptId, 'rate-limited');
      return { outcome: 'refused', reason: '429 rate limited' };
    });
    await admit(harness, 'attempt-example-1');
    await advance(harness);
    await advance(harness);
    const prepared = await advance(harness);
    expect(prepared).toMatchObject({ outcome: 'acted', key: expect.stringMatching(/\/a2$/) });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.attemptIds).toHaveLength(2);
    const pivotId = after?.attemptIds[1];
    expect(typeof pivotId).toBe('string');
    const pivot = await harness.attemptRepo.findAttemptById(pivotId as string);
    expect(pivot?.state).toBe('intent-recorded');
    expect(pivot?.kind).toBe('initial');
    expect(pivot?.priorAttemptId).toBe('attempt-example-1');
    expect(pivot?.seatSelection?.seatId).toBe('fp-2');
    expect(pivot?.seatSelection?.seatIndex).toBe(1);
    expect(pivot?.briefDigest).toBe(SHA);
    expect(pivot?.worktreePath).toBe(WORKTREE);
    // The pivot keeps the run's host identity, so the Q2a-2 act guard lets it dispatch.
    expect(pivot?.runner).toEqual({
      kind: CONDUCTED_RUNNER.kind,
      remotePort: CONDUCTED_RUNNER.remotePort,
      host: CONDUCTED_RUNNER.host,
      hostName: CONDUCTED_RUNNER.hostName,
      agent: null,
      model: null,
      variant: null,
    });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const prepareIntent = entries.find(
      (entry) => entry.kind === 'intent' && entry.key === prepareKey(0, 1, 2),
    );
    expect(prepareIntent?.mintedId).toBe(pivotId);
  });

  it('test 4: the pivot dispatch carries the conductor seat override; a residue refusal parks step-refused dispatch', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    let calls = 0;
    harness.setDispatchAnswer(async (request) => {
      calls += 1;
      if (calls === 1) {
        await harness.markAttemptCancelled(request.attemptId, 'rate-limited');
        return { outcome: 'refused', reason: '429 rate limited' };
      }
      return {
        outcome: 'refused',
        reason: 'Worktree ' + WORKTREE + ' contains residue from earlier attempts: .lane/notes.md',
      };
    });
    await admit(harness, 'attempt-example-1');
    await advance(harness);
    await advance(harness);
    const prepared = await advance(harness);
    expect(prepared).toMatchObject({ outcome: 'acted', reasonCode: 'prepared' });
    const after = await harness.runRepo.get(RUN_ID);
    const pivotId = after?.attemptIds[1] as string;
    // Q2a-2: a pivot attempt carries the recorded host when it dispatches (the
    // invariant the conductor enforces); stamp it as the reservation would.
    const pivotRecord = await harness.attemptRepo.findAttemptById(pivotId);
    if (pivotRecord !== null) {
      await harness.attemptRepo.saveAttempt({
        ...pivotRecord,
        runner: CONDUCTED_RUNNER,
        revision: (pivotRecord.revision ?? 0) + 1,
      });
    }
    await admit(harness, pivotId);
    const dispatched = await advance(harness);
    expect(dispatched).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(harness.dispatchRequests).toHaveLength(2);
    const override = harness.dispatchRequests[1].seatOverride;
    expect(override?.model).toBe('model-example-2');
    expect(override?.setBy).toBe('conductor');
    expect(override?.reason.startsWith('seat-plan pivot to fp-2')).toBe(true);
    const pivot = await harness.attemptRepo.findAttemptById(pivotId);
    expect(pivot?.state).toBe('intent-recorded');
  });

  it('test 5: both first-pass seats used in round 0 parks seat-plan-exhausted', async () => {
    const first = attemptFixture({ state: 'cancelled', stopReason: 'rate-limited' });
    const second = attemptFixture({
      id: 'attempt-example-2',
      state: 'cancelled',
      stopReason: 'rate-limited',
      seatSelection: SEAT_SELECTION_FP2,
    });
    const harness = await makeHarness(
      runRecord({ attemptIds: ['attempt-example-1', 'attempt-example-2'] }),
      [first, second],
    );
    await appendIntent(harness, prepareKey(0, 0, 1), 'attempt-example-1', NOW);
    await appendResult(harness, prepareKey(0, 0, 1), 'completed', 'prepared', NOW);
    await appendIntent(harness, prepareKey(0, 1, 2), 'attempt-example-2', NOW);
    await appendResult(harness, prepareKey(0, 1, 2), 'completed', 'prepared', NOW);
    await conduct(harness, 'seat-failed', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'seat-plan-exhausted', qualifier: null });
  });

  it('test 6: a dispatch refused with the attempt still intent-recorded parks step-refused dispatch', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: 'refused by the example runner' }));
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
    expect(stored?.state).toBe('intent-recorded');
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'result', outcome: 'refused', reasonCode: 'dispatch-refused' }),
    );
  });

  it('test 7: a frozen manifest without stepLimit refuses the dispatch inputs and never calls the runner', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await harness.setManifest(JSON.stringify({ timeLimitSeconds: 2700 }));
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(harness.dispatchRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        outcome: 'refused',
        reasonCode: 'dispatch-inputs-unreadable',
      }),
    );
  });

  it('test 7f (SEC-5b): dispatch of an initial attempt with a changed-on-disk manifest refuses the dispatch inputs and parks step-refused', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    // A valid manifest whose bytes changed without any digest re-freeze: the
    // verified read fails closed, so the dispatch inputs are unreadable.
    harness.setChangedManifestOnDisk(JSON.stringify({ stepLimit: 101, timeLimitSeconds: 2700, expectedArtifacts: [] }));
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(harness.dispatchRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        outcome: 'refused',
        reasonCode: 'dispatch-inputs-unreadable',
      }),
    );
  });

  it('test 7b (KF-10): a spent dispatch key parks step-refused dispatch without re-sending it or writing a second intent', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    // A crash after the dispatch result but before the dispatching conduct: the
    // key has a final `dispatch-started` result and the attempt is still
    // prepared, so the decider re-acts the same key. The spent-key guard parks
    // instead of the journal's duplicate-key refusal.
    const key = dispatchKey(0, 0, 1);
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    await appendResult(harness, key, 'completed', 'dispatch-started', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(harness.dispatchRequests).toEqual([]);
    expect(harness.cancelRequests).toEqual([]);
    const entries = await harness.runJournal.listForKey(key);
    expect(entries.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
  });

  it('test 7c (KF-10): after a refused first dispatch parks, a resume pivots to the next first-pass seat under a new key', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await harness.setManifest(null);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const first = await advance(harness);
    expect(first).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(harness.dispatchRequests).toEqual([]);
    expect((await harness.runJournal.listForKey(key)).filter((e) => e.kind === 'intent')).toHaveLength(1);

    // Resume: applyPendingResume's exit — the park cleared, the parked-from conduct journaled.
    const parked = await harness.runRepo.get(RUN_ID);
    if (parked === null || parked.parked === null) {
      throw new Error('fixture must end parked');
    }
    expect(parked.parked).toMatchObject({ reason: 'step-refused', qualifier: 'dispatch' });
    const saved = await harness.deps.runRepo.save(
      { ...parked, parked: null, revision: parked.revision + 1 },
      { holderId: HOLDER, fence: 1, nowIso: LATER },
    );
    expect(saved.outcome).toBe('saved');
    await conduct(harness, 'ready', LATER);

    // The next advance owns the pivot: G8 does not re-park a dispatch refusal
    // (dispatch is no state's keyed step), so the not-started dispatch cancels
    // the never-contacted attempt instead of re-sending the spent key.
    const afterResume = await advance(harness);
    expect(afterResume).toEqual({ outcome: 'waiting', reason: 'dispatch-pending' });
    expect(harness.dispatchRequests).toEqual([]);
    expect((await harness.runJournal.listForKey(key)).filter((e) => e.kind === 'intent')).toHaveLength(1);
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('cancelled');

    // The following advance prepares a NEW attempt on the next first-pass seat
    // under a new key; the spent dispatch key is never re-sent.
    const pivotPrepare = await advance(harness);
    expect(pivotPrepare).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(0, 1, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    const afterRecord = await harness.runRepo.get(RUN_ID);
    const pivotId = afterRecord?.attemptIds[1];
    const pivot = await harness.attemptRepo.findAttemptById(pivotId as string);
    expect(pivot?.seatSelection?.seatId).toBe('fp-2');
    expect(pivot?.seatSelection?.seatIndex).toBe(1);
    expect((await harness.runJournal.listForKey(key)).filter((e) => e.kind === 'intent')).toHaveLength(1);
  });

  it('test 7d (KF-10): with one first-pass seat a resumed refused dispatch re-prepares the same seat under a NEW key, never re-sending the spent key', async () => {
    const harness = await makeHarness(runRecord(), [
      attemptFixture({ seatPlan: SEAT_PLAN_ONE }),
    ]);
    await harness.setManifest(null);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const first = await advance(harness);
    expect(first).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(harness.dispatchRequests).toEqual([]);

    // The park was taken from `ready` (pass 1), so a resume re-enters `ready`: the real path of the live run.
    const parked = await harness.runRepo.get(RUN_ID);
    if (parked === null || parked.parked === null) {
      throw new Error('fixture must end parked');
    }
    expect(parked.parked).toMatchObject({ reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'ready' });
    const saved = await harness.deps.runRepo.save(
      { ...parked, parked: null, revision: parked.revision + 1 },
      { holderId: HOLDER, fence: 1, nowIso: LATER },
    );
    expect(saved.outcome).toBe('saved');
    await conduct(harness, 'ready', LATER);

    const afterResume = await advance(harness);
    expect(afterResume).toEqual({ outcome: 'waiting', reason: 'dispatch-pending' });
    expect(harness.dispatchRequests).toEqual([]);
    expect((await harness.runJournal.listForKey(key)).filter((e) => e.kind === 'intent')).toHaveLength(1);
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('cancelled');

    // One seat: the next prepare lands on seat 0 again, under a new attempt ordinal and key — the spent
    // dispatch key is never re-sent and the advance never returns journal-refused.
    const next = await advance(harness);
    expect(next).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(0, 0, 2),
      result: 'completed',
      reasonCode: 'prepared',
    });
    expect((await harness.runJournal.listForKey(key)).filter((e) => e.kind === 'intent')).toHaveLength(1);
  });

  it('test 7e (KF-10): the pre-dispatch manifest read goes through the attempt\'s stamped runner host', async () => {
    const stamped: AttemptRunnerRecord = {
      kind: 'opencode',
      hostName: 'lane-example',
      host: 'lane-alias-example',
      remotePort: 4166,
      agent: null,
      model: null,
      variant: null,
    };
    const harness = await makeHarness(runRecord(), [attemptFixture({ runner: stamped })]);
    await admit(harness, 'attempt-example-1');
    const dispatched = await advance(harness);
    expect(dispatched).toMatchObject({ outcome: 'acted', step: 'dispatch', key: dispatchKey(0, 0, 1) });
    expect(harness.manifestReads.length).toBeGreaterThan(0);
    for (const read of harness.manifestReads) {
      expect(read).toEqual(stamped);
    }
    expect(harness.dispatchRequests).toHaveLength(1);
  });

  it('test 8: a pivot seat whose tool differs is refused seat-tool-differs and then parks step-refused prepare', async () => {
    const first = attemptFixture({ state: 'cancelled', stopReason: 'rate-limited', seatPlan: SEAT_PLAN_AGY_PIVOT });
    const harness = await makeHarness(runRecord(), [first]);
    await conduct(harness, 'seat-failed', NOW);
    const prepared = await advance(harness);
    expect(prepared).toEqual({
      outcome: 'acted',
      step: 'prepare',
      key: prepareKey(0, 1, 2),
      result: 'refused',
      reasonCode: 'seat-tool-differs',
    });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.attemptIds).toHaveLength(1);
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'prepare' });
  });

  it('test 9: a fix-round prepare without the K5 ports is not-wired and writes nothing', async () => {
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
    await conduct(harness, 'fixing', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'not-wired', step: 'prepare' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.attemptIds).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'conduct' && entry.state === 'fixing')).toHaveLength(1);
  });

  it('test 10: a graceful stop with a prepared, never-dispatched attempt cancels it under its stop key and ends stopped', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const stopBuilt = laneRunStopKey(RUN_ID, 'web');
    expect(stopBuilt.ok).toBe(true);
    if (!stopBuilt.ok) {
      throw new Error('fixture must build a stop key');
    }
    const stopEntry = {
      ...laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, stopBuilt.key, null, NOW),
      mode: 'graceful' as const,
      expectedRevision: 1,
    };
    const stopAppended = await harness.runJournal.append(stopEntry);
    expect(stopAppended.outcome).toBe('appended');
    const cancelled = await advance(harness);
    expect(cancelled).toEqual({
      outcome: 'acted',
      step: 'stop',
      key: RUN_ID + '/r0/stop/0',
      result: 'cancelled-unstarted',
      reasonCode: 'capacity-released',
    });
    expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    const after = await advance(harness);
    expect(after).toEqual({ outcome: 'entered', state: 'stopped' });
  });

  it('test 11: without a dispatch port the act is not-wired and writes nothing', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()], { wireDispatch: false });
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'not-wired', step: 'dispatch' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toHaveLength(0);
  });

  it('test 12: a one-way key is never sent twice across the pivot chain', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async (request) => ({
      outcome: 'started',
      attempt: attemptFixture({ id: request.attemptId }),
      sessionId: 'session-example-1',
    }));
    await admit(harness, 'attempt-example-1');
    const dispatched = await advance(harness);
    expect(dispatched).toMatchObject({ outcome: 'acted', reasonCode: 'dispatch-started' });
    await harness.markAttemptCancelled('attempt-example-1', 'rate-limited');
    const failed = await advance(harness);
    expect(failed).toEqual({ outcome: 'entered', state: 'seat-failed' });
    const prepared = await advance(harness);
    expect(prepared).toMatchObject({ outcome: 'acted', reasonCode: 'prepared' });
    // The pivot attempt is not admitted, so every further advance waits and
    // neither the dispatch key nor the prepare key is ever re-sent.
    for (let index = 0; index < 5; index += 1) {
      const waited = await advance(harness);
      expect(waited).toEqual({ outcome: 'waiting', reason: 'admission' });
    }
    expect(harness.dispatchRequests).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === dispatchKey(0, 0, 1))).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === prepareKey(0, 1, 2))).toHaveLength(1);
  });

  it('test 13: the cost ceiling parks seat-failed before prepare and ready before dispatch', async () => {
    const failedHarness = await makeHarness(
      runRecord(),
      [attemptFixture({ state: 'cancelled', stopReason: 'rate-limited', usage: usageRecord(1.2) })],
      { ceiling: 1 },
    );
    await conduct(failedHarness, 'seat-failed', NOW);
    const parkedFailed = await advance(failedHarness);
    expect(parkedFailed).toEqual({ outcome: 'parked', reason: 'cost-ceiling', qualifier: null });
    const failedEntries = await failedHarness.runJournal.listForRun(RUN_ID);
    expect(
      failedEntries.some((entry) => entry.kind === 'intent' && entry.key !== null && entry.key.includes('/prepare/')),
    ).toBe(false);

    const readyHarness = await makeHarness(
      runRecord(),
      [attemptFixture({ usage: usageRecord(1.2) })],
      { ceiling: 1 },
    );
    await admit(readyHarness, 'attempt-example-1');
    const parkedReady = await advance(readyHarness);
    expect(parkedReady).toEqual({ outcome: 'parked', reason: 'cost-ceiling', qualifier: null });
    expect(readyHarness.dispatchRequests).toHaveLength(0);
    const readyEntries = await readyHarness.runJournal.listForRun(RUN_ID);
    expect(
      readyEntries.some((entry) => entry.kind === 'intent' && entry.key !== null && entry.key.includes('/dispatch/')),
    ).toBe(false);
  });

  it('test 14: a refused cursor save returns save-refused before the dispatch is called; the intent stays pending', async () => {
    const harness = await makeHarness(
      runRecord({ cursors: { 'first-pass': null, fix: null, review: null } }),
      [attemptFixture()],
      { runSave: 'refuse' },
    );
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'refused', reason: 'save-refused' });
    expect(harness.dispatchRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
    expect(entries.some((entry) => entry.kind === 'result')).toBe(false);
  });

  it('test 15: a dispatch key with a final not-started result cancels the attempt instead of re-sending', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    const key = dispatchKey(0, 0, 1);
    await appendIntent(harness, key, 'attempt-example-1', NOW);
    await appendResult(harness, key, 'not-started', 'worktree-idle', NOW);
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'dispatch-pending' });
    expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === key)).toHaveLength(1);
  });

  it('test 16: a throwing run save after the attempt exists returns save-refused with no prepared result', async () => {
    const first = attemptFixture({ state: 'cancelled', stopReason: 'rate-limited' });
    const harness = await makeHarness(runRecord(), [first], { runSave: 'throw' });
    await conduct(harness, 'seat-failed', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'refused', reason: 'save-refused' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.outcome === 'completed')).toBe(false);
    const intent = entries.find((entry) => entry.kind === 'intent');
    expect(typeof intent?.mintedId).toBe('string');
    const attempt = await harness.attemptRepo.findAttemptById(intent?.mintedId as string);
    expect(attempt?.state).toBe('intent-recorded');
  });

  it('test 12b: five further advances of a running lane never dispatch again', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const dispatched = await advance(harness);
    expect(dispatched).toMatchObject({
      outcome: 'acted',
      step: 'dispatch',
      key,
      reasonCode: 'dispatch-started',
    });
    // The attempt record the runner left behind is running; the runner fake
    // keeps answering for it. Every further advance stays inside the time
    // limit (dispatched at LATER, limit 2700s) and inside the lease.
    const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
    expect(stored).not.toBeNull();
    if (stored === null) {
      throw new Error('the dispatched attempt must be stored');
    }
    // The record the dispatch left, moved to running as the runner would; nothing else replaced.
    await harness.attemptRepo.saveAttempt({
      ...stored,
      revision: (stored.revision ?? 0) + 1,
      state: 'running',
      updatedAtIso: LATER,
    });
    const further: unknown[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const nowIso = new Date(Date.parse(LATER) + index * 30_000).toISOString();
      further.push(await advance(harness, { nowIso }));
    }
    // The running path, not a bail-out: the first advance enters running, the rest wait on the lane.
    expect(further).toEqual([
      { outcome: 'entered', state: 'running' },
      { outcome: 'waiting', reason: 'lane-running' },
      { outcome: 'waiting', reason: 'lane-running' },
      { outcome: 'waiting', reason: 'lane-running' },
      { outcome: 'waiting', reason: 'lane-running' },
    ]);
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.cancelRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === key)).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'result' && entry.key === key)).toHaveLength(1);
  });

  for (const [outcome, reasonCode] of [
    ['unknown', 'dispatch-unknown'],
    ['blocked', 'dispatch-blocked'],
  ] as const) {
    it(`test 16${outcome === 'unknown' ? 'a' : 'b'}: a ${outcome} dispatch result is journalled as ${reasonCode}, never as started`, async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()]);
      const attemptRecord = attemptFixture();
      harness.setDispatchAnswer(
        outcome === 'unknown'
          ? async () => ({ outcome: 'unknown', attempt: attemptRecord, reason: 'the runner transport died' })
          : async () => ({ outcome: 'blocked', attempt: attemptRecord, reason: 'a session may be live in the worktree' }),
      );
      await admit(harness, 'attempt-example-1');
      const key = dispatchKey(0, 0, 1);
      const dispatched = await advance(harness);
      expect(dispatched).toEqual({
        outcome: 'acted',
        step: 'dispatch',
        key,
        result: 'completed',
        reasonCode,
      });
      expect(harness.dispatchRequests).toHaveLength(1);
      expect(await lastJournalState(harness)).toBe('dispatching');
      const entries = await harness.runJournal.listForRun(RUN_ID);
      const results = entries.filter((entry) => entry.kind === 'result' && entry.key === key);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({ outcome: 'completed', reasonCode }));
      // A further advance never re-sends the spent key.
      const waited = await advance(harness);
      expect(waited).toEqual({ outcome: 'waiting', reason: 'dispatch-pending' });
      expect(harness.dispatchRequests).toHaveLength(1);
    });
  }

  it('test 17: a dispatch-started key is never cancelled', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const dispatched = await advance(harness);
    expect(dispatched).toMatchObject({ outcome: 'acted', step: 'dispatch', reasonCode: 'dispatch-started' });
    const stopBuilt = laneRunStopKey(RUN_ID, 'web');
    expect(stopBuilt.ok).toBe(true);
    if (!stopBuilt.ok) {
      throw new Error('fixture must build a stop key');
    }
    const stopEntry = {
      ...laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, stopBuilt.key, null, LATER),
      mode: 'graceful' as const,
      expectedRevision: 1,
    };
    const stopAppended = await harness.runJournal.append(stopEntry);
    expect(stopAppended.outcome).toBe('appended');
    // G4f: a graceful stop lets the started attempt finish; the cancel act
    // (G4e) is only for never-dispatched attempts.
    const parked = await advance(harness);
    expect(parked).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'dispatch' });
    expect(harness.cancelRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    // Nothing at all is journalled as a result under any stop key: no cancelled-unstarted
    // outcome or reason code, and no other stop result either.
    expect(
      entries.filter((entry) => entry.kind === 'result' && entry.key !== null && entry.key.includes('/stop/')),
    ).toEqual([]);
  });

  it('test 18 (KF-17): a refused dispatch whose reservation is gone, after resume, cancels the attempt instead of waiting on admission', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: 'refused by the example runner' }));
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });

    // Resume: clear the park and re-conduct `ready` (the park's parkedFrom).
    const parked = await harness.runRepo.get(RUN_ID);
    if (parked === null || parked.parked === null) {
      throw new Error('fixture must end parked');
    }
    const saved = await harness.deps.runRepo.save(
      { ...parked, parked: null, revision: parked.revision + 1 },
      { holderId: HOLDER, fence: 1, nowIso: LATER },
    );
    expect(saved.outcome).toBe('saved');
    await conduct(harness, 'ready', LATER);

    // The reservation is gone: without the KF-17 admission bypass the
    // prepared attempt would wait `admission` forever, because a refusal of
    // `no-reservation` never admits. The not-started dispatch cancels the
    // attempt instead, without contacting the runner.
    expect(await harness.executionJournal.releaseCapacityReservation('attempt-example-1', LATER)).toBe(true);
    expect(await advance(harness)).toEqual({ outcome: 'waiting', reason: 'dispatch-pending' });
    // Only the original refused call: the cancel never re-sends the key.
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('cancelled');
    expect((await harness.runJournal.listForKey(key)).filter((entry) => entry.kind === 'intent')).toHaveLength(1);
  });

  it('test 19 (KF-34a1): a denying start gate waits session-stagger before the dispatch intent and never calls the runner', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness, { startGate: denyingStartGate() });
    expect(result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(harness.dispatchRequests).toEqual([]);
    // Nothing at all is journalled: the wait sits before the one-way intent.
    expect(await harness.runJournal.listForRun(RUN_ID)).toEqual([]);
  });

  it('test 20 (KF-34a1): with a granting gate the dispatch is exactly test 1', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const result = await advance(harness, { startGate: grantingStartGate() });
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries[0]).toMatchObject({ kind: 'intent', key, mintedId: 'attempt-example-1' });
  });

  it('CO13: a denying endpoint gate waits session-stagger before the dispatch intent, spends no key and journals one refused dispatch entry', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness, { startGate: denyingEndpointGate() });
    expect(result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(harness.dispatchRequests).toEqual([]);
    // The wait sits before the one-way intent: nothing is journalled in the run journal.
    expect(await harness.runJournal.listForRun(RUN_ID)).toEqual([]);
    // The attempt is untouched.
    expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('intent-recorded');
    // The execution journal holds exactly one refused dispatch wait entry.
    const entries = await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'dispatch', status: 'refused' });
    expect(entries[0].detail).toMatch(/^dispatch stagger wait: endpoint opencode:lane-host-example:4166/);
  });

  it('CO13: a second wait for the same attempt appends no second entry', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    await advance(harness, { startGate: denyingEndpointGate() });
    await advance(harness, { startGate: denyingEndpointGate() });
    const entries = await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(entries.filter((entry) => entry.action === 'dispatch' && entry.status === 'refused')).toHaveLength(1);
  });

  it('fix round 1: a cancelled attempt that started a session still seeds the endpoint stagger', async () => {
    const prior = attemptFixture({
      id: 'attempt-example-0',
      state: 'cancelled',
      sessionId: 'session-prior',
      updatedAtIso: LATER,
    });
    const harness = await makeHarness(runRecord(), [prior, attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const result = await advance(harness, { startGate: seededEndpointGate() });
    expect(result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(harness.dispatchRequests).toEqual([]);
  });

  it('fix round 1: a cancelled attempt that never started a session does not seed the endpoint stagger', async () => {
    const prior = attemptFixture({ id: 'attempt-example-0', state: 'cancelled', updatedAtIso: LATER });
    const harness = await makeHarness(runRecord(), [prior, attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const result = await advance(harness, { startGate: seededEndpointGate() });
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
  });

  it('CO13: a granting endpoint gate dispatches exactly as test 20 does', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const key = dispatchKey(0, 0, 1);
    const result = await advance(harness, { startGate: grantingEndpointGate() });
    expect(result).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries[0]).toMatchObject({ kind: 'intent', key, mintedId: 'attempt-example-1' });
  });

  it('fix round 3: a started dispatch keeps the held endpoint start (no release)', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const gate = recordingEndpointGate();
    const result = await advance(harness, { startGate: gate });
    expect(result).toMatchObject({ outcome: 'acted', step: 'dispatch', reasonCode: 'dispatch-started' });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(gate.asks).toEqual(['opencode:lane-host-example:4166']);
    expect(gate.releases).toEqual([]);
  });

  it('fix round 3: an endpoint grant the global gate then blocks is released', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const gate = recordingEndpointGate(false);
    const result = await advance(harness, { startGate: gate });
    expect(result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(harness.dispatchRequests).toEqual([]);
    expect(gate.releases).toEqual([RUN_ID]);
  });

  it('fix round 3: a runner refusal releases the held endpoint start', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: 'refused by the example runner' }));
    await admit(harness, 'attempt-example-1');
    const gate = recordingEndpointGate();
    const result = await advance(harness, { startGate: gate });
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(gate.asks).toHaveLength(1);
    expect(gate.releases).toEqual([RUN_ID]);
  });

  it('fix round 3: unreadable dispatch inputs refuse at once without asking the endpoint gate', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    await harness.setManifest(JSON.stringify({ timeLimitSeconds: 2700 }));
    await admit(harness, 'attempt-example-1');
    const gate = recordingEndpointGate();
    const result = await advance(harness, { startGate: gate });
    expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
    expect(gate.asks).toEqual([]);
    const entries = await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(entries.some((entry) => entry.detail?.startsWith('dispatch stagger wait:') === true)).toBe(false);
  });

  it('fix round 3: an undated started attempt waits one full interval from its first sighting, then grants', async () => {
    const prior = attemptFixture({
      id: 'attempt-example-0',
      state: 'running',
      // Created long before: the creation time is never used as a start bound.
      createdAtIso: '2026-10-27T09:00:00.000Z',
      updatedAtIso: 'not-a-date',
    });
    const harness = await makeHarness(runRecord(), [prior, attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const at = (ms: number): string => new Date(Date.parse(LATER) + ms).toISOString();
    // A fresh gate per pass, as the conductor builds one.
    const first = await advance(harness, { startGate: new SessionStartSpacing(20_000, null), nowIso: LATER });
    expect(first).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    const entries = await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'dispatch', status: 'refused', recordedAtIso: LATER });
    expect(entries[0].detail).toBe(
      'dispatch stagger wait: endpoint opencode:lane-host-example:4166, retry after 20000 ms, last start undated',
    );
    // 10 s later the first sighting still spaces the endpoint (no second entry).
    const second = await advance(harness, { startGate: new SessionStartSpacing(20_000, null), nowIso: at(10_000) });
    expect(second).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1')).toHaveLength(1);
    // One interval after the first sighting the start is granted: the corrupt record blocks no longer.
    const third = await advance(harness, { startGate: new SessionStartSpacing(20_000, null), nowIso: at(20_000) });
    expect(third).toMatchObject({ outcome: 'acted', step: 'dispatch', reasonCode: 'dispatch-started' });
    expect(harness.dispatchRequests).toHaveLength(1);
  });

  it('fix round 3: an undated started attempt never hands the gate a malformed seed', async () => {
    const prior = attemptFixture({
      id: 'attempt-example-0',
      state: 'running',
      createdAtIso: 'not-a-date',
      updatedAtIso: 'not-a-date',
    });
    const harness = await makeHarness(runRecord(), [prior, attemptFixture()]);
    await admit(harness, 'attempt-example-1');
    const gate = seededEndpointGate();
    const result = await advance(harness, { startGate: gate });
    expect(result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(gate.seeds).toEqual([LATER]);
  });

  it('test 21 (KF-34a1): a seat-pivot dispatch is denied the same way, before the pivot intent', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture()]);
    harness.setDispatchAnswer(async (request) => {
      await harness.markAttemptCancelled(request.attemptId, 'rate-limited');
      return { outcome: 'refused', reason: '429 rate limited' };
    });
    await admit(harness, 'attempt-example-1');
    await advance(harness);
    await advance(harness);
    await advance(harness);
    const after = await harness.runRepo.get(RUN_ID);
    const pivotId = after?.attemptIds[1] as string;
    const pivotRecord = await harness.attemptRepo.findAttemptById(pivotId);
    if (pivotRecord !== null) {
      await harness.attemptRepo.saveAttempt({
        ...pivotRecord,
        runner: CONDUCTED_RUNNER,
        revision: (pivotRecord.revision ?? 0) + 1,
      });
    }
    await admit(harness, pivotId);
    const denied = await advance(harness, { startGate: denyingStartGate() });
    expect(denied).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(harness.dispatchRequests).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'intent' && entry.key === dispatchKey(0, 1, 2))).toBe(false);
  });

  describe('GB3: worktree-uncommitted dispatch recovery', () => {
    const WORKTREE_REFUSAL = 'Worktree ' + WORKTREE + ' has uncommitted changes: src/ex.ts';
    const PATCH_PATH = WORKTREE + '.attempt-example-1.patch';
    const recoveryJournalEntries = async (harness: Harness) =>
      (await harness.executionJournal.listJournalEntriesForAttempt('attempt-example-1')).filter(
        (entry) =>
          entry.action === 'dispatch' &&
          entry.detail !== null &&
          entry.detail.startsWith('preserved uncommitted edits:'),
      );

    it('GB3 test 1: a worktree-uncommitted refusal preserves edits, resets, cancels, journals the patch path and does not park', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({
        outcome: 'acted',
        step: 'dispatch',
        key: dispatchKey(0, 0, 1),
        result: 'refused',
        reasonCode: 'dispatch-refused',
      });
      const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
      expect(stored?.state).toBe('cancelled');
      const after = await harness.runRepo.get(RUN_ID);
      expect(after?.parked).toBeNull();
      const entries = await harness.runJournal.listForRun(RUN_ID);
      expect(entries).toContainEqual(
        expect.objectContaining({
          kind: 'result',
          outcome: 'refused',
          reasonCode: 'dispatch-refused',
          detail: 'worktree-uncommitted',
        }),
      );
      expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'parked')).toBe(false);
      const preserved = await recoveryJournalEntries(harness);
      expect(preserved.map((entry) => entry.status)).toEqual(['intent-recorded', 'completed']);
      for (const entry of preserved) {
        expect(entry.detail).toBe('preserved uncommitted edits: ' + PATCH_PATH);
      }
      // The next advance prepares the next seat: no park.
      const next = await advance(harness);
      expect(next).toEqual({
        outcome: 'acted',
        step: 'prepare',
        key: prepareKey(0, 1, 2),
        result: 'completed',
        reasonCode: 'prepared',
      });
    });

    it('GB3 test 2: preserve runs before reset before cancel, each on the recorded host with the exact paths', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      await admit(harness, 'attempt-example-1');
      await advance(harness);
      expect(harness.preserveRequests).toEqual([{ worktreePath: WORKTREE, patchPath: PATCH_PATH, recordedHost: CONDUCTED_RUNNER }]);
      expect(harness.resetRequests).toEqual([{ worktreePath: WORKTREE, recordedHost: CONDUCTED_RUNNER }]);
      expect(harness.cancelRequests).toEqual([{ attemptId: 'attempt-example-1', nowIso: LATER }]);
    });

    it('GB3 test 3: a refused preserve keeps the park and calls neither reset nor cancel', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      harness.setPreserveAnswer(async () => ({ outcome: 'refused', reason: 'git-refused' }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      const stored = await harness.attemptRepo.findAttemptById('attempt-example-1');
      expect(stored?.state).toBe('intent-recorded');
      expect(harness.resetRequests).toEqual([]);
      expect(harness.cancelRequests).toEqual([]);
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual(['intent-recorded']);
    });

    it('GB3 test 4: a failed reset keeps the park and never cancels', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      harness.setResetAnswer(async () => ({ outcome: 'error', reason: 'git died' }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toHaveLength(1);
      expect(harness.cancelRequests).toEqual([]);
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual(['intent-recorded']);
    });

    it('GB3 test 5: a refused cancel keeps the park and leaves the recovery intent unclosed', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      harness.setCancelAnswer({ outcome: 'refused', reason: 'changed' });
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual(['intent-recorded']);
    });

    it('GB3 test 6: without wired recovery a worktree-uncommitted refusal parks as today', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()]);
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toEqual([]);
      expect(harness.resetRequests).toEqual([]);
      expect(harness.cancelRequests).toEqual([]);
    });

    it('GB3 test 7: only worktree-uncommitted recovers; worktree-untracked parks and calls nothing', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({
        outcome: 'refused',
        reason: 'Worktree ' + WORKTREE + ' has untracked files: notes.txt',
      }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toEqual([]);
      expect(harness.resetRequests).toEqual([]);
      expect(harness.cancelRequests).toEqual([]);
    });

    it('GB3 test 8: a crash after the durable intent parks; the patch path stays discoverable and reset/cancel never run', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      harness.setPreserveAnswer(async () => ({ outcome: 'error', reason: 'simulated crash after intent' }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toHaveLength(1);
      expect(harness.resetRequests).toEqual([]);
      expect(harness.cancelRequests).toEqual([]);
      const preserved = await recoveryJournalEntries(harness);
      expect(preserved.map((entry) => entry.status)).toEqual(['intent-recorded']);
      expect(preserved[0]?.detail).toBe('preserved uncommitted edits: ' + PATCH_PATH);
    });

    it('GB3 test 9: an incomplete recovery blocks advance after restart: the run parks again and nothing re-runs', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      harness.setResetAnswer(async () => ({ outcome: 'error', reason: 'simulated crash after preserve' }));
      await admit(harness, 'attempt-example-1');
      expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toHaveLength(1);
      expect(harness.resetRequests).toHaveLength(1);
      expect(harness.cancelRequests).toEqual([]);

      // Restart: clear the park and re-conduct `ready`.
      const parked = await harness.runRepo.get(RUN_ID);
      if (parked === null || parked.parked === null) {
        throw new Error('fixture must end parked');
      }
      const saved = await harness.deps.runRepo.save(
        { ...parked, parked: null, revision: parked.revision + 1 },
        { holderId: HOLDER, fence: 1, nowIso: LATER },
      );
      expect(saved.outcome).toBe('saved');
      await conduct(harness, 'ready', LATER);

      // The resumed run still parks (incomplete recovery must not advance) and
      // the recovery steps are not re-run.
      harness.setResetAnswer(async () => ({ outcome: 'reset', headCommit: COMMIT }));
      const again = await advance(harness);
      expect(again).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toHaveLength(1);
      expect(harness.resetRequests).toHaveLength(1);
      expect(harness.cancelRequests).toEqual([]);
      const preserved = await recoveryJournalEntries(harness);
      expect(preserved.map((entry) => entry.status)).toEqual(['intent-recorded']);
      expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('intent-recorded');
    });

    /** Crash injection: the nth execution-journal append throws after delegating. */
    const crashOnAppend = (harness: Harness, nth: number): void => {
      const base = harness.executionJournal;
      let appends = 0;
      const injected: AdvanceLaneRunDependencies['executionJournal'] = {
        listActiveReservations: (hostId) => base.listActiveReservations(hostId),
        listJournalEntriesForAttempt: (attemptId) => base.listJournalEntriesForAttempt(attemptId),
        appendJournalEntry: async (entry) => {
          appends += 1;
          if (appends === nth) {
            throw new Error('simulated crash between journal appends');
          }
          await base.appendJournalEntry(entry);
        },
      };
      (harness.deps as { executionJournal: AdvanceLaneRunDependencies['executionJournal'] }).executionJournal =
        injected;
    };

    /** Restarts the harness's parked run (clears the park, re-conducts `ready`). */
    const restartRun = async (harness: Harness): Promise<void> => {
      const parked = await harness.runRepo.get(RUN_ID);
      if (parked === null || parked.parked === null) {
        throw new Error('fixture must end parked');
      }
      const saved = await harness.deps.runRepo.save(
        { ...parked, parked: null, revision: parked.revision + 1 },
        { holderId: HOLDER, fence: 1, nowIso: LATER },
      );
      expect(saved.outcome).toBe('saved');
      await conduct(harness, 'ready', LATER);
    };

    it('GB3 test 10: a crash after the cancel is reconciled at the next prepare without repeating the reset', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      await admit(harness, 'attempt-example-1');
      // The second execution-journal append is the recovery's completing
      // entry; it throws after the cancel already persisted.
      crashOnAppend(harness, 2);
      expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect((await harness.attemptRepo.findAttemptById('attempt-example-1'))?.state).toBe('cancelled');
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual(['intent-recorded']);

      await restartRun(harness);

      // The patch survived the crash: the adapter answers destination-exists.
      // The first recovery already reset, so the reconcile repeats no reset,
      // closes the intent, and the run prepares the next seat.
      harness.setPreserveAnswer(async () => ({ outcome: 'refused', reason: 'destination-exists' }));
      expect(await advance(harness)).toEqual({
        outcome: 'acted',
        step: 'prepare',
        key: prepareKey(0, 1, 2),
        result: 'completed',
        reasonCode: 'prepared',
      });
      expect(harness.resetRequests).toHaveLength(1);
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual(['intent-recorded', 'completed']);
      expect(harness.cancelRequests).toHaveLength(1);
    });

    it('GB3 test 11: a crash after the cancel whose patch cannot be proven parks at prepare and calls nothing further', async () => {
      const harness = await makeHarness(runRecord(), [attemptFixture()], { wireRecovery: true });
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      await admit(harness, 'attempt-example-1');
      crashOnAppend(harness, 2);
      expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });

      await restartRun(harness);

      // A clean worktree without a provable patch (nothing-to-preserve) cannot
      // close the recovery: the run parks at prepare and the reset never runs.
      harness.setPreserveAnswer(async () => ({ outcome: 'refused', reason: 'nothing-to-preserve' }));
      const next = await advance(harness);
      expect(next).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'prepare' });
      // The crashed recovery's reset ran once; the reconcile added none.
      expect(harness.resetRequests).toHaveLength(1);
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual(['intent-recorded']);
    });

    it('GB3 test 12: a non-normalized recorded worktree path never builds a patch path — recovery and reconcile both refuse', async () => {
      // Dispatch recovery: the double slash means the recorded path was never
      // normalized, so no patch path is built and the refusal parks.
      const harness = await makeHarness(
        runRecord(),
        [attemptFixture({ worktreePath: '/tmp/opencode/wo-example-1//wt-example-1' })],
        { wireRecovery: true },
      );
      harness.setDispatchAnswer(async () => ({ outcome: 'refused', reason: WORKTREE_REFUSAL }));
      await admit(harness, 'attempt-example-1');
      const result = await advance(harness);
      expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'dispatch' });
      expect(harness.preserveRequests).toEqual([]);
      expect(harness.resetRequests).toEqual([]);
      expect(harness.cancelRequests).toEqual([]);
      expect((await recoveryJournalEntries(harness)).map((entry) => entry.status)).toEqual([]);

      // Reconcile: a cancelled attempt with an open intent and a `..`-shaped
      // worktree path parks at prepare without touching the recovery port.
      const harness2 = await makeHarness(
        runRecord(),
        [attemptFixture({ worktreePath: WORKTREE + '/../wt-example-1', state: 'cancelled', outcome: 'stopped' })],
        { wireRecovery: true },
      );
      await harness2.executionJournal.appendJournalEntry({
        id: 'attempt-example-1:dispatch:1',
        attemptId: 'attempt-example-1',
        workOrderId: 'wo-example-1',
        action: 'dispatch',
        baseCommit: COMMIT,
        recordedAtIso: NOW,
        status: 'intent-recorded',
        sessionId: null,
        detail: 'preserved uncommitted edits: ' + WORKTREE + '/../wt-example-1.attempt-example-1.patch',
      });
      const prepared = await advance(harness2);
      expect(prepared).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'prepare' });
      expect(harness2.preserveRequests).toEqual([]);
      expect(harness2.resetRequests).toEqual([]);
    });
  });
});
