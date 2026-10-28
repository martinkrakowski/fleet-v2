/**
 * Unit tests for K4-4a: the `AdvanceLaneRunUseCase` skeleton. The advance
 * loads the run, checks the caller's run lease, repairs a park the record and
 * the journal disagree on, and performs the record-only decisions (`enter`,
 * `park`, `wait`, `done`). Acting decisions are reported `not-built` and
 * write nothing; the stubbed admission fact waits fail-closed and the
 * admission port is never called. Every store is in-memory; no runner, no
 * subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { ArtifactManifestVerdict } from '../../../domain/artifact-manifest.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey, laneRunStopKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../../../domain/lane-run-journal.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
} from '../../../domain/lane-run-step-facts.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const EXPIRED = '2026-10-27T11:00:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const SECOND_COMMIT = 'b'.repeat(40);
const SHA = 'c'.repeat(64);

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

type ManifestVerdict = ArtifactManifestVerdict;

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly verifyCalls: Record<string, unknown>[];
  readonly admissionCalls: unknown[];
  readonly reconcileCalls: unknown[];
  readonly deps: AdvanceLaneRunDependencies;
  setManifestVerdict(verdict: ManifestVerdict | 'throw'): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempt: AttemptRecord | null,
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const verifyCalls: Record<string, unknown>[] = [];
  const admissionCalls: unknown[] = [];
  const reconcileCalls: unknown[] = [];
  let manifestVerdict: ManifestVerdict | 'throw' = { outcome: 'missing' };
  const created = await runRepo.create(record);
  expect(created.outcome).toBe('saved');
  const leased = await runRepo.acquireLease(record.runId, {
    holderId: HOLDER,
    observedFence: 0,
    leaseUntilIso: LEASE_UNTIL,
    nowIso: NOW,
  });
  expect(leased.outcome).toBe('saved');
  if (attempt !== null) {
    await attemptRepo.saveAttempt(attempt);
  }
  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal: {
      listActiveReservations: async () => [],
      listJournalEntriesForAttempt: async () => [],
    },
    artifactPort: {
      readBriefManifest: undefined,
      verifyArtifactManifest: async (request) => {
        verifyCalls.push({ ...request });
        if (manifestVerdict === 'throw') {
          throw new Error('unreadable manifest');
        }
        return manifestVerdict;
      },
    },
    reconcileAttempt: {
      reconcileAttempt: async (request) => {
        reconcileCalls.push(request);
        throw new Error('reconcile must never run in K4-4a');
      },
    },
    admission: {
      admit: async (request) => {
        admissionCalls.push(request);
        return { outcome: 'admitted' };
      },
    },
    newUlid: makeUlidMinter(),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    verifyCalls,
    admissionCalls,
    reconcileCalls,
    deps,
    setManifestVerdict: (verdict) => {
      manifestVerdict = verdict;
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

/** A stop intent entry: mode and expectedRevision are the stop's own. */
function stopIntentEntry(harness: Harness, nowIso: string, expectedRevision: number): LaneRunJournalEntryRecord {
  const built = laneRunStopKey(RUN_ID, 'web');
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a stop key');
  }
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: harness.deps.newUlid(),
    kind: 'intent',
    key: built.key,
    runId: RUN_ID,
    recordedAtIso: nowIso,
    mode: 'graceful',
    expectedRevision,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    grantId: null,
    state: null,
  };
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

describe('AdvanceLaneRunUseCase (K4-4a, record-only)', () => {
  it('test 1: another holder is refused lease-not-held, an expired lease lease-expired; nothing written', async () => {
    const harness = await makeHarness(runRecord(), attemptFixture());
    const other = await advance(harness, { lease: { holderId: 'other-holder', fence: 1 } });
    expect(other).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
    const expired = await advance(harness, { nowIso: EXPIRED });
    expect(expired).toEqual({ outcome: 'refused', reason: 'lease-expired' });
    expect(await harness.runJournal.listForRun(RUN_ID)).toEqual([]);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.lease).toEqual({ holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL });
    expect(after?.revision).toBe(1);
  });

  it('test 2: a dispatching journal state with a running attempt enters running; revision unchanged', async () => {
    const harness = await makeHarness(runRecord(), attemptFixture({ state: 'running' }));
    await conduct(harness, 'dispatching', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'entered', state: 'running' });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries).toHaveLength(2);
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'conduct', state: 'running' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });

  it('test 3: a collected attempt with a mismatched manifest parks artifacts-unsealed', async () => {
    const harness = await makeHarness(
      runRecord(),
      attemptFixture({
        state: 'collected',
        artifacts: {
          headCommit: SECOND_COMMIT,
          commitsSinceBase: [SECOND_COMMIT],
          collectedArtifactPaths: [],
          notes: 'missing',
          manifestPath: '.lane/artifacts-manifest-example.json',
          manifestSha256: SHA,
        },
      }),
    );
    harness.setManifestVerdict({ outcome: 'mismatch', mismatches: [] });
    await conduct(harness, 'collecting', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'parked', reason: 'artifacts-unsealed', qualifier: null });
    expect(harness.verifyCalls).toEqual([
      {
        attemptId: 'attempt-example-1',
        worktreePath: '/tmp/opencode/wo-example-1/wt-example-1',
        recordedHost: null,
        manifestPath: '.lane/artifacts-manifest-example.json',
        expectedManifestSha256: SHA,
      },
    ]);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toEqual({
      reason: 'artifacts-unsealed',
      qualifier: null,
      parkedFrom: 'collecting',
      questionId: null,
    });
    expect(after?.parkCount).toBe(1);
    expect(after?.revision).toBe(2);
    expect(await lastJournalState(harness)).toBe('parked');
  });

  it('test 4: a halted park with a recorded graceful stop leaves the park by itself (G4h)', async () => {
    const harness = await makeHarness(
      runRecord({
        parked: { reason: 'halted', qualifier: null, parkedFrom: 'gating', questionId: null },
        parkCount: 1,
      }),
      null,
    );
    await conduct(harness, 'parked', NOW);
    const appended = await harness.runJournal.append(stopIntentEntry(harness, NOW, 1));
    expect(appended.outcome).toBe('appended');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'entered', state: 'gating' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toBeNull();
    expect(after?.revision).toBe(2);
    expect(await lastJournalState(harness)).toBe('gating');
  });

  it('test 5: a park whose conduct entry was lost is repaired by appending it', async () => {
    const harness = await makeHarness(
      runRecord({
        parked: { reason: 'stop-unconfirmed', qualifier: null, parkedFrom: 'running', questionId: null },
        parkCount: 1,
        attemptIds: [],
      }),
      null,
    );
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'repaired', state: 'parked' });
    expect(await lastJournalState(harness)).toBe('parked');
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });

  it('test 5b: a park exit whose save was lost is repaired by saving parked null', async () => {
    const harness = await makeHarness(
      runRecord({
        parked: { reason: 'stop-unconfirmed', qualifier: null, parkedFrom: 'running', questionId: null },
        parkCount: 1,
        attemptIds: [],
      }),
      null,
    );
    await conduct(harness, 'parked', NOW);
    await conduct(harness, 'gating', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'repaired', state: 'gating' });
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.parked).toBeNull();
    expect(after?.revision).toBe(2);
  });

  it('test 6: a run not parked whose journal says parked waits facts-inconsistent; nothing written', async () => {
    const harness = await makeHarness(runRecord(), null);
    await conduct(harness, 'parked', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
    expect(await harness.runJournal.listForRun(RUN_ID)).toHaveLength(1);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });

  it('test 7: a prepared attempt under the stubbed no-capacity admission waits; the admission port is never called', async () => {
    const harness = await makeHarness(runRecord(), attemptFixture());
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'admission' });
    expect(harness.admissionCalls).toEqual([]);
    expect(await harness.runJournal.listForRun(RUN_ID)).toEqual([]);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });

  it('test 8: act decisions are reported not-built and write nothing', async () => {
    const harness = await makeHarness(runRecord(), attemptFixture({ state: 'running' }));
    await conduct(harness, 'collecting', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'not-built', decision: 'act', step: 'collect' });
    expect(await harness.runJournal.listForRun(RUN_ID)).toHaveLength(1);
    expect(harness.reconcileCalls).toEqual([]);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });

  it('test 9: a reconcile decision is reported not-built and writes nothing', async () => {
    const harness = await makeHarness(runRecord(), attemptFixture());
    const built = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'dispatch',
      seatIndex: 0,
      attemptOrdinal: 1,
      head12: null,
      retry: null,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      throw new Error('fixture must build a dispatch key');
    }
    const intent = laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, built.key, 'attempt-example-1', NOW);
    const appended = await harness.runJournal.append(intent);
    expect(appended.outcome).toBe('appended');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'not-built', decision: 'reconcile', step: 'dispatch' });
    expect(harness.reconcileCalls).toEqual([]);
    expect(harness.admissionCalls).toEqual([]);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });

  it('test 10: a cancel decision is reported not-built (step stop) and writes nothing', async () => {
    const harness = await makeHarness(runRecord(), attemptFixture());
    const stop = await harness.runJournal.append(stopIntentEntry(harness, NOW, 1));
    expect(stop.outcome).toBe('appended');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'not-built', decision: 'cancel', step: 'stop' });
    expect(harness.reconcileCalls).toEqual([]);
    expect(harness.admissionCalls).toEqual([]);
    expect(await harness.runJournal.listForRun(RUN_ID)).toHaveLength(1);
    const after = await harness.runRepo.get(RUN_ID);
    expect(after?.revision).toBe(1);
  });
});
