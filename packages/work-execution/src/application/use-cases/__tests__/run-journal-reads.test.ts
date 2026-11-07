// LaneRunBoardReads tests — A-R.
/**
 * The read-only board, detail and keyed run-journal reads: live and terminal
 * cards, per-role seats from recorded attempts, parked and wouldAct summaries,
 * bounded journal reads by run and by key, and the robustness bar every input,
 * port and store read is held to.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import {
  buildLaneRunStepKey,
  laneRunResumeKey,
  laneRunStopForceKey,
  laneRunStopKey,
  reaperRepairKey,
  requestKey,
} from '../../../domain/lane-run-keys.js';
import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LANE_RUN_STOP_KEY_MODES } from '../../../domain/lane-run-keys.js';
import { StateFileUnknownVersionError } from '../../../infrastructure/adapters/file-store.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import {
  LaneRunBoardReads,
  MAX_LANE_RUN_CARDS,
  MAX_WOULD_ACT_PER_RUN,
} from '../run-journal-reads.js';
import type { LaneRunBoardReadsDependencies } from '../run-journal-reads.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_2 = 'run-01JB0000000000000000000001';
const RUN_ID_3 = 'run-01JB0000000000000000000002';
const ATTEMPT_ID = 'attempt-live-1';
const ATTEMPT_ID_2 = 'attempt-live-2';
const NOW = '2026-11-06T10:00:00.000Z';
const LEASE_UNTIL = '2026-11-06T10:05:00.000Z';
const ENTRY_1 = '01JB0000000000000000000001';
const ENTRY_2 = '01JB0000000000000000000002';
const ENTRY_3 = '01JB0000000000000000000003';
const ENTRY_4 = '01JB0000000000000000000004';
const ENTRY_5 = '01JB0000000000000000000005';
const WO_ID = 'wo-acme-repo';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: WO_ID,
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: [ATTEMPT_ID],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

const WORK_ORDER: WorkOrderRecord = {
  id: WO_ID,
  projectId: 'project-acme',
  taskId: 'task-1',
  laneId: 'lane-1',
  repository: 'acme/repo',
  baseCommit: 'a'.repeat(40),
  ownedPaths: ['packages/a/x.ts'],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'approved',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

function attemptRecord(
  id: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    id,
    workOrderId: WO_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/srv/wt/' + id,
    baseCommit: 'a'.repeat(40),
    state: 'running',
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: { kind: 'opencode', remotePort: 4166, host: null, agent: 'lane', model: 'm-1', variant: null },
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function seatSelection(role: 'first-pass' | 'fix' | 'review', seatIndex = 0): NonNullable<AttemptRecord['seatSelection']> {
  return { role, seatIndex, seatId: 'seat-' + role + '-' + seatIndex, model: 'model-' + role, tool: 'opencode', variant: null, agent: null };
}

function mustKey(result: { readonly ok: true; readonly key: string } | { readonly ok: false; readonly error: string }): string {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('fixture key must be valid');
  }
  return result.key;
}

function dispatchKey(runId: string): string {
  const key = buildLaneRunStepKey({
    runId,
    round: 0,
    step: 'dispatch',
    seatIndex: 0,
    attemptOrdinal: 1,
    head12: null,
    retry: null,
  });
  expect(key.ok).toBe(true);
  if (!key.ok) {
    throw new Error('fixture must be a valid step key');
  }
  return key.key;
}

function stopIntentEntry(entryId: string, runId: string, mode: (typeof LANE_RUN_STOP_KEY_MODES)[number], nowIso: string): LaneRunJournalEntryRecord {
  const built = mode === 'force' ? laneRunStopForceKey(runId, 'web') : laneRunStopKey(runId, 'web');
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must be a valid stop key');
  }
  return {
    version: 1,
    entryId,
    kind: 'intent',
    key: built.key,
    runId,
    recordedAtIso: nowIso,
    mode,
    expectedRevision: 1,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function resumeIntentEntry(entryId: string, runId: string, nowIso: string): LaneRunJournalEntryRecord {
  const built = laneRunResumeKey(runId, 1, 'web');
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must be a valid resume key');
  }
  return {
    version: 1,
    entryId,
    kind: 'intent',
    key: built.key,
    runId,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: 1,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function requestIntentEntry(entryId: string, nowIso: string): LaneRunJournalEntryRecord {
  const built = requestKey(entryId);
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must be a valid request key');
  }
  return {
    version: 1,
    entryId,
    kind: 'intent',
    key: built.key,
    runId: null,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function reaperIntentEntry(entryId: string, nowIso: string): LaneRunJournalEntryRecord {
  const built = reaperRepairKey('wt-000000000000', 'orphan-session', entryId);
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must be a valid reaper key');
  }
  return {
    version: 1,
    entryId,
    kind: 'intent',
    key: built.key,
    runId: null,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function makeHarness(overrides: Partial<LaneRunBoardReadsDependencies> = {}) {
  const laneRunRepository = new LaneRunRepositoryAdapter();
  const laneRunJournal = new LaneRunJournalAdapter();
  const halt = new ConductorHaltAdapter();
  const driverLease = new ConductorDriverLeaseAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const workOrderRepo = new WorkOrderRepositoryAdapter();
  const reads = new LaneRunBoardReads({
    runRepo: laneRunRepository,
    runJournal: laneRunJournal,
    halt,
    driverLease,
    attemptRepo,
    executionJournal,
    workOrderRepo,
    ...overrides,
  });
  return {
    laneRunRepository,
    laneRunJournal,
    halt,
    driverLease,
    attemptRepo,
    executionJournal,
    workOrderRepo,
    reads,
  };
}

describe('LaneRunBoardReads.readBoard', () => {
  it('lists live and terminal merged/stopped cards with cursors, seats, prNumber, parked and lease', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunRepository.create(runRecord({
      runId: RUN_ID_2,
      attemptIds: [ATTEMPT_ID_2],
      prNumber: 42,
      parked: {
        reason: 'blocker-after-round-2',
        qualifier: null,
        parkedFrom: 'running',
        questionId: '01JB0000000000000000000009',
        findings: [
          { findingId: 'f-1', severity: 'blocker', summary: 'needs work', filePath: 'packages/a/x.ts', line: 3 },
        ],
      },
      parkCount: 1,
    }));
    await h.laneRunRepository.create(runRecord({ runId: RUN_ID_3, attemptIds: [] }));
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'running', NOW));
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_2, RUN_ID_2, 'merged', NOW));
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_3, RUN_ID_3, 'stopped', NOW));
    await h.attemptRepo.saveAttempt(attemptRecord(ATTEMPT_ID, { seatSelection: seatSelection('first-pass') }));
    await h.attemptRepo.saveAttempt(attemptRecord(ATTEMPT_ID_2, { seatSelection: seatSelection('review') }));
    await h.workOrderRepo.saveWorkOrder(WORK_ORDER);
    await h.laneRunRepository.acquireLease(RUN_ID, {
      holderId: 'driver-secret-1',
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });

    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.runs.map((card) => card.runId)).toEqual([RUN_ID, RUN_ID_2, RUN_ID_3]);
    const live = result.runs.find((card) => card.runId === RUN_ID);
    expect(live).toMatchObject({
      state: 'running',
      round: 0,
      revision: 1,
      cursors: { 'first-pass': 0, fix: null, review: null },
      attemptCount: 1,
      latestAttemptId: ATTEMPT_ID,
      prNumber: null,
      parked: null,
      stopMode: null,
      stopRequestedAtIso: null,
      pendingIntent: null,
      wouldAct: [],
      wouldActTruncated: false,
    });
    expect(live?.seatsByRole).toEqual({
      'first-pass': { seatId: 'seat-first-pass-0', model: 'model-first-pass', tool: 'opencode', seatIndex: 0, variant: null },
      fix: null,
      review: null,
    });
    expect(live?.lease).toEqual({
      holderId: 'driver-secret-1',
      fence: 1,
      leaseUntilIso: LEASE_UNTIL,
      lapsed: false,
    });
    const merged = result.runs.find((card) => card.runId === RUN_ID_2);
    expect(merged?.state).toBe('merged');
    expect(merged?.prNumber).toBe(42);
    expect(merged?.parked).toEqual({
      reason: 'blocker-after-round-2',
      qualifier: null,
      parkedFrom: 'running',
      questionId: '01JB0000000000000000000009',
      findingCount: 1,
      // A record written before PT1a has no stored class and reads as `other`.
      class: 'other',
    });
    // No finding filePath or summary crosses the wire.
    expect(JSON.stringify(result)).not.toContain('packages/a/x.ts');
    expect(JSON.stringify(result)).not.toContain('needs work');
    const stopped = result.runs.find((card) => card.runId === RUN_ID_3);
    expect(stopped?.state).toBe('stopped');
  });

  it('preserves the A-R-1 schedule, sessionStarts and truncated flag', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunJournal.append(laneRunIntentEntry(ENTRY_1, RUN_ID, dispatchKey(RUN_ID), null, NOW));
    await h.workOrderRepo.saveWorkOrder(WORK_ORDER);

    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.rows.map((row) => row.runId)).toEqual([RUN_ID]);
    expect(result.schedule.halt).toBe('clear');
    expect(result.sessionStarts).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.runsTruncated).toBe(false);
  });

  it('projects an interrupted intent without a final result as pendingIntent unread or ambiguous', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunJournal.append(laneRunIntentEntry(ENTRY_1, RUN_ID, dispatchKey(RUN_ID), null, NOW));

    let result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.runs[0]?.pendingIntent).toEqual({ step: 'dispatch', reconciliation: 'unread' });
    }

    await h.laneRunJournal.append(laneRunResultEntry(ENTRY_2, RUN_ID, dispatchKey(RUN_ID), 'ambiguous', 'dispatch-blocked', NOW));
    result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.runs[0]?.pendingIntent).toEqual({ step: 'dispatch', reconciliation: 'ambiguous' });
    }
  });

  it('includes bounded wouldAct dry-run summaries with the truncation flag', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    // A dry-run result is a final result: one per key, so a wouldAct summary
    // needs its own dispatch key per entry.
    for (let i = 0; i < MAX_WOULD_ACT_PER_RUN + 5; i += 1) {
      const key = buildLaneRunStepKey({
        runId: RUN_ID,
        round: 0,
        step: 'dispatch',
        seatIndex: i,
        attemptOrdinal: 1,
        head12: null,
        retry: null,
      });
      expect(key.ok).toBe(true);
      if (!key.ok) {
        throw new Error('fixture must be a valid step key');
      }
      const intentId = '01JB00000000000000000000' + String(i * 2).padStart(2, '0');
      const resultId = '01JB00000000000000000000' + String(i * 2 + 1).padStart(2, '0');
      await h.laneRunJournal.append(laneRunIntentEntry(intentId, RUN_ID, key.key, null, NOW));
      await h.laneRunJournal.append(laneRunResultEntry(resultId, RUN_ID, key.key, 'dry-run', 'dispatch-blocked', NOW));
    }

    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.runs[0]?.wouldAct).toHaveLength(MAX_WOULD_ACT_PER_RUN);
    expect(result.runs[0]?.wouldActTruncated).toBe(true);
    expect(result.runs[0]?.wouldAct[0]).toMatchObject({
      keyKind: 'step',
      step: 'dispatch',
      round: 0,
      reasonCode: 'dispatch-blocked',
    });
  });

  it('bounds run cards at MAX_LANE_RUN_CARDS with runsTruncated', async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_LANE_RUN_CARDS + 5; i += 1) {
      const runId = 'run-' + '0' + String(i).padStart(25, '0');
      await h.laneRunRepository.create(runRecord({ runId }));
    }
    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.runs).toHaveLength(MAX_LANE_RUN_CARDS);
    expect(result.runsTruncated).toBe(true);

    const limited = await h.reads.readBoard({ nowIso: NOW, query: { limit: '10' } });
    expect(limited.outcome).toBe('listed');
    if (limited.outcome === 'listed') {
      expect(limited.runs).toHaveLength(10);
      expect(limited.runsTruncated).toBe(true);
    }
  });

  it('redacts secret-shaped and path-bearing identifiers and drops finding paths', async () => {
    const ghp = ['ghp', 'x'.repeat(28)].join('_'); // built at runtime, never a literal token
    // A foreign store can hold a secret-shaped holder id: the adapter would
    // refuse to save one, so inject it through a fake read.
    const foreign = { ...runRecord(), lease: { holderId: ghp, fence: 1, leaseUntilIso: LEASE_UNTIL } };
    const h = makeHarness({
      runRepo: {
        list: async () => [foreign],
        get: async () => null,
      } as unknown as LaneRunBoardReadsDependencies['runRepo'],
    });
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'running', NOW));

    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.runs[0]?.lease?.holderId).toBeNull();
    expect(JSON.stringify(result)).not.toContain(ghp);
  });
});

describe('LaneRunBoardReads card id and label screening', () => {
  const PATH_ID = '/srv/wt/secret-worktree';

  async function board(foreign: LaneRunRecord, attempts: readonly AttemptRecord[] = []) {
    const h = makeHarness({
      runRepo: {
        list: async () => [foreign],
        get: async () => null,
      } as unknown as LaneRunBoardReadsDependencies['runRepo'],
    });
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_1, foreign.runId, 'running', NOW));
    for (const attempt of attempts) {
      await h.attemptRepo.saveAttempt(attempt);
    }
    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      throw new Error('board must list');
    }
    return result;
  }

  it('replaces a path-shaped workOrderId with the invalid marker', async () => {
    const result = await board({ ...runRecord(), workOrderId: PATH_ID });
    expect(result.runs[0]?.workOrderId).toBe('<invalid>');
    expect(JSON.stringify(result)).not.toContain(PATH_ID);
  });

  it('replaces a path-shaped attempt id with the invalid marker', async () => {
    const result = await board({ ...runRecord(), attemptIds: [PATH_ID] });
    expect(result.runs[0]?.latestAttemptId).toBe('<invalid>');
    expect(JSON.stringify(result)).not.toContain(PATH_ID);
  });

  it('replaces a path-shaped parked questionId with the invalid marker', async () => {
    const parked = {
      reason: 'blocker-after-round-2',
      qualifier: null,
      parkedFrom: 'running',
      questionId: PATH_ID,
      findings: [],
    } as unknown as LaneRunRecord['parked'];
    const result = await board({ ...runRecord(), parked, parkCount: 1 });
    expect(result.runs[0]?.parked?.questionId).toBe('<invalid>');
    expect(JSON.stringify(result)).not.toContain(PATH_ID);
  });

  it('replaces a path-shaped or secret-shaped seat variant with the invalid marker', async () => {
    const ghp = ['ghp', 'x'.repeat(28)].join('_'); // built at runtime, never a literal token
    for (const bad of [PATH_ID, ghp]) {
      const attempt = attemptRecord(ATTEMPT_ID, { seatSelection: { ...seatSelection('first-pass'), variant: bad } });
      const result = await board(runRecord(), [attempt]);
      expect(result.runs[0]?.seatsByRole['first-pass']?.variant).toBe('<invalid>');
      expect(JSON.stringify(result)).not.toContain(bad);
    }
  });

  it('keeps well-formed ids and variants verbatim', async () => {
    const attempt = attemptRecord(ATTEMPT_ID, { seatSelection: { ...seatSelection('first-pass'), variant: 'low' } });
    const result = await board(runRecord(), [attempt]);
    expect(result.runs[0]).toMatchObject({ workOrderId: WO_ID, latestAttemptId: ATTEMPT_ID });
    expect(result.runs[0]?.seatsByRole['first-pass']?.variant).toBe('low');
  });
});

describe('LaneRunBoardReads.readRun', () => {
  it('lists a run with its bounded journal and halt/driver facts', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'running', NOW));
    await h.laneRunJournal.append(laneRunIntentEntry(ENTRY_2, RUN_ID, dispatchKey(RUN_ID), null, NOW));
    await h.laneRunJournal.append(laneRunResultEntry(ENTRY_3, RUN_ID, dispatchKey(RUN_ID), 'dry-run', 'dispatch-blocked', NOW));
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_4, RUN_ID, 'collecting', NOW));
    await h.attemptRepo.saveAttempt(attemptRecord(ATTEMPT_ID, { seatSelection: seatSelection('first-pass') }));

    const result = await h.reads.readRun({ runId: RUN_ID, nowIso: NOW, query: { journalLimit: 2 } });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.halt).toBe('clear');
    expect(result.driverLeaseLapsed).toBeNull();
    expect(result.run.runId).toBe(RUN_ID);
    expect(result.run.state).toBe('collecting');
    expect(result.journal).toHaveLength(2);
    expect(result.journalTruncated).toBe(true);
    expect(result.journal.map((entry) => entry.entryId)).toEqual([ENTRY_3, ENTRY_4]);
    expect(result.journal[0]?.isWouldAct).toBe(true);
    expect(result.journal[0]?.keyKind).toBe('step');
    expect(result.journal[0]?.step).toBe('dispatch');
  });

  it('answers not-found for an unknown run', async () => {
    const h = makeHarness();
    const result = await h.reads.readRun({ runId: RUN_ID, nowIso: NOW });
    expect(result).toEqual({ outcome: 'not-found', runId: RUN_ID });
  });
});

describe('LaneRunBoardReads.readJournalForRun', () => {
  it('lists a run journal bounded with truncation', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'running', NOW));
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_2, RUN_ID, 'collecting', NOW));

    const result = await h.reads.readJournalForRun({ runId: RUN_ID, query: { limit: 1 } });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.runId).toBe(RUN_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entryId).toBe(ENTRY_2);
    expect(result.truncated).toBe(true);
  });

  it('answers not-found for an unknown run', async () => {
    const h = makeHarness();
    const result = await h.reads.readJournalForRun({ runId: RUN_ID });
    expect(result).toEqual({ outcome: 'not-found', runId: RUN_ID });
  });
});

describe('LaneRunBoardReads.readJournalByKey', () => {
  it('reads step, stop, resume, request and reaper keys', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunJournal.append(laneRunIntentEntry(ENTRY_1, RUN_ID, dispatchKey(RUN_ID), null, NOW));
    await h.laneRunJournal.append(stopIntentEntry(ENTRY_2, RUN_ID, 'graceful', NOW));
    await h.laneRunJournal.append(resumeIntentEntry(ENTRY_3, RUN_ID, NOW));
    await h.laneRunJournal.append(requestIntentEntry(ENTRY_4, NOW));
    await h.laneRunJournal.append(reaperIntentEntry(ENTRY_5, NOW));

    const step = await h.reads.readJournalByKey({ query: { key: dispatchKey(RUN_ID) } });
    expect(step.outcome).toBe('listed');
    if (step.outcome === 'listed') {
      expect(step.keyKind).toBe('step');
      expect(step.entries).toHaveLength(1);
      expect(step.entries[0]?.step).toBe('dispatch');
    }

    const stopKey = mustKey(laneRunStopKey(RUN_ID, 'web'));
    const stop = await h.reads.readJournalByKey({ query: { key: stopKey } });
    expect(stop.outcome).toBe('listed');
    if (stop.outcome === 'listed') {
      expect(stop.keyKind).toBe('stop');
      expect(stop.entries[0]?.mode).toBe('graceful');
    }

    const resumeKey = mustKey(laneRunResumeKey(RUN_ID, 1, 'web'));
    const resume = await h.reads.readJournalByKey({ query: { key: resumeKey } });
    expect(resume.outcome).toBe('listed');
    if (resume.outcome === 'listed') {
      expect(resume.keyKind).toBe('resume');
    }

    const reqKey = mustKey(requestKey(ENTRY_4));
    const req = await h.reads.readJournalByKey({ query: { key: reqKey } });
    expect(req.outcome).toBe('listed');
    if (req.outcome === 'listed') {
      expect(req.keyKind).toBe('request');
      expect(req.entries[0]?.runId).toBeNull();
    }

    const reapKey = mustKey(reaperRepairKey('wt-000000000000', 'orphan-session', ENTRY_5));
    const reap = await h.reads.readJournalByKey({ query: { key: reapKey } });
    expect(reap.outcome).toBe('listed');
    if (reap.outcome === 'listed') {
      expect(reap.keyKind).toBe('reaper');
    }
  });
});

describe('LaneRunBoardReads robustness', () => {
  it('rejects null, non-object, extra-key, wrong-typed and throwing-getter requests without throwing', async () => {
    const h = makeHarness();
    for (const request of [null, 'x', 1, [], { nowIso: NOW, extra: 1 }, { nowIso: 'not-a-time' }, { runId: RUN_ID }, { query: {} }]) {
      expect(await h.reads.readBoard(request)).toEqual({ outcome: 'rejected', reason: 'invalid-request' });
    }
    await expect(h.reads.readRun(null)).resolves.toEqual({ outcome: 'rejected', reason: 'invalid-request' });
    await expect(h.reads.readRun({ runId: 'not-a-run-id', nowIso: NOW })).resolves.toEqual({ outcome: 'rejected', reason: 'invalid-request' });
    await expect(h.reads.readJournalForRun({ runId: 42 })).resolves.toEqual({ outcome: 'rejected', reason: 'invalid-request' });
    await expect(h.reads.readJournalByKey({ query: {} })).resolves.toEqual({ outcome: 'rejected', reason: 'invalid-request' });
    await expect(h.reads.readJournalByKey({ query: { key: 'not/a/valid/key' } })).resolves.toEqual({ outcome: 'rejected', reason: 'invalid-request' });

    const hostile = { nowIso: NOW };
    Object.defineProperty(hostile, 'nowIso', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    await expect(h.reads.readBoard(hostile)).resolves.toEqual({ outcome: 'rejected', reason: 'invalid-request' });
  });

  it('reports unknown store-unreadable on sparse arrays or unknown enum values in port results without throwing', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());

    const sparse = new Array(1) as readonly LaneRunJournalEntryRecord[];
    const sparseHarness = makeHarness({
      runJournal: {
        listForRun: async () => sparse,
        listForRuns: async () => new Map([[RUN_ID, sparse]]),
        listForKey: async () => sparse,
      } as unknown as LaneRunBoardReadsDependencies['runJournal'],
    });
    await sparseHarness.laneRunRepository.create(runRecord());
    expect(await sparseHarness.reads.readJournalForRun({ runId: RUN_ID })).toEqual({
      outcome: 'unknown',
      reason: 'store-unreadable',
    });

    const unknownEnum = [{
      version: 1,
      entryId: ENTRY_1,
      kind: 'result',
      key: dispatchKey(RUN_ID),
      runId: RUN_ID,
      recordedAtIso: NOW,
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'not-an-outcome',
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    }] as unknown as LaneRunJournalEntryRecord[];
    const enumHarness = makeHarness({
      runJournal: {
        listForRun: async () => unknownEnum,
        listForRuns: async () => new Map([[RUN_ID, unknownEnum]]),
        listForKey: async () => unknownEnum,
      } as unknown as LaneRunBoardReadsDependencies['runJournal'],
    });
    await enumHarness.laneRunRepository.create(runRecord());
    expect(await enumHarness.reads.readJournalForRun({ runId: RUN_ID })).toEqual({
      outcome: 'unknown',
      reason: 'store-unreadable',
    });
    expect(await enumHarness.reads.readBoard({ nowIso: NOW })).toEqual({
      outcome: 'unknown',
      reason: 'store-unreadable',
    });
  });

  it('cuts short a hung store read at readTimeoutMs as unknown store-unreadable and leaves store state untouched', async () => {
    const h = makeHarness({
      runRepo: {
        list: () => new Promise<never>(() => {}),
        get: () => new Promise<never>(() => {}),
      } as unknown as LaneRunBoardReadsDependencies['runRepo'],
      readTimeoutMs: 20,
    });
    const started = Date.now();
    const result = await h.reads.readBoard({ nowIso: NOW });
    expect(result).toEqual({ outcome: 'unknown', reason: 'store-unreadable' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports unknown store-unreadable and unknown-schema-version instead of empty lists or not-found when any store throws', async () => {
    const h = makeHarness({
      executionJournal: {
        listActiveReservations: async () => {
          throw new Error('disk exploded');
        },
      } as unknown as LaneRunBoardReadsDependencies['executionJournal'],
    });
    expect(await h.reads.readBoard({ nowIso: NOW })).toEqual({
      outcome: 'unknown',
      reason: 'store-unreadable',
    });

    const versionHarness = makeHarness({
      runRepo: {
        list: async () => {
          throw new StateFileUnknownVersionError('/tmp/lane-runs.json', 0);
        },
        get: async () => {
          throw new StateFileUnknownVersionError('/tmp/lane-runs.json', 0);
        },
      } as unknown as LaneRunBoardReadsDependencies['runRepo'],
    });
    expect(await versionHarness.reads.readBoard({ nowIso: NOW })).toEqual({
      outcome: 'unknown',
      reason: 'unknown-schema-version',
    });
    expect(await versionHarness.reads.readRun({ runId: RUN_ID, nowIso: NOW })).toEqual({
      outcome: 'unknown',
      reason: 'unknown-schema-version',
    });
  });

  it('composes only read-only state ports with no git, workspace, runner or forge dependency', async () => {
    const reads = new LaneRunBoardReads({
      runRepo: {
        list: async () => [runRecord()],
        get: async () => null,
      } satisfies Pick<LaneRunBoardReadsDependencies['runRepo'], 'list' | 'get'>,
      runJournal: {
        listForRun: async () => [],
        listForRuns: async () => new Map(),
        listForKey: async () => [],
      } satisfies Pick<LaneRunBoardReadsDependencies['runJournal'], 'listForRun' | 'listForRuns' | 'listForKey'>,
      halt: { read: async () => ({ state: 'clear' as const, record: null }) },
      driverLease: { read: async () => null },
      attemptRepo: {
        findAttemptById: async () => null,
        listAllAttempts: async () => [],
      } satisfies Pick<LaneRunBoardReadsDependencies['attemptRepo'], 'findAttemptById' | 'listAllAttempts'>,
      executionJournal: { listActiveReservations: async () => [] },
      workOrderRepo: { listWorkOrdersByProject: async () => [] },
    });
    expect(await reads.readBoard({ nowIso: NOW })).toMatchObject({ outcome: 'listed' });
    expect(await reads.readRun({ runId: RUN_ID, nowIso: NOW })).toEqual({ outcome: 'not-found', runId: RUN_ID });
    expect(await reads.readJournalForRun({ runId: RUN_ID })).toEqual({ outcome: 'not-found', runId: RUN_ID });
    expect(await reads.readJournalByKey({ query: { key: dispatchKey(RUN_ID) } })).toMatchObject({ outcome: 'listed' });
  });

  it('throws Not implemented when unconfigured', async () => {
    const reads = new LaneRunBoardReads();
    await expect(reads.readBoard({ nowIso: NOW })).rejects.toThrow('Not implemented: LaneRunBoardReads');
  });
});

describe('ExecutionJournalAdapter readOnly', () => {
  it('refuses every write and never quarantines corrupt files when readOnly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-exjournal-readonly-'));
    try {
      const journal = new ExecutionJournalAdapter({ stateDir: dir, readOnly: true });
      writeFileSync(join(dir, 'reservations.json'), '{corrupt');
      writeFileSync(join(dir, 'journal.json'), '{corrupt');

      await expect(journal.listActiveReservations()).rejects.toMatchObject({ name: 'StateFileUnreadableReadOnlyError' });
      await expect(journal.listJournalEntriesForAttempt('att-1')).rejects.toMatchObject({ name: 'StateFileUnreadableReadOnlyError' });

      await expect(journal.saveCapacityReservation({
        id: 'res-1',
        attemptId: 'att-1',
        hostId: 'sol',
        slotIndex: 0,
        held: true,
        seatTool: 'opencode',
        hostName: null,
        hostKind: 'opencode',
        transport: 'ssh',
        sshAlias: null,
        port: null,
        worktreePath: null,
        reservedAtIso: NOW,
        releasedAtIso: null,
      })).rejects.toMatchObject({ name: 'ReadOnlyStateStoreError' });

      await expect(journal.appendJournalEntry({
        id: 'act-1',
        attemptId: 'att-1',
        workOrderId: WO_ID,
        action: 'dispatch',
        baseCommit: 'a'.repeat(40),
        recordedAtIso: NOW,
        status: 'intent-recorded',
        sessionId: null,
        detail: null,
      })).rejects.toMatchObject({ name: 'ReadOnlyStateStoreError' });

      expect(readdirSync(dir).some((name) => name.includes('quarantine') || name.startsWith('.'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
