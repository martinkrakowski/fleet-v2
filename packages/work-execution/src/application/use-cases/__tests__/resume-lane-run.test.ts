// ResumeLaneRunUseCase tests — K7-3.
/**
 * A resume is a record the driver obeys: `requestResume` journals one intent
 * under the park's resume key with the revision the requester read, after the
 * plan's refusals; `applyPendingResume` applies it under the run lease —
 * conduct entry to the parked-from state, the record saved with no park, then
 * the result. A stop recorded after the request still wins; a wrong lease
 * leaves the conduct and K4-4a's park-exit repair completes the exit.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { laneRunConductEntry, laneRunIntentEntry } from '../../../domain/lane-run-step-facts.js';
import { laneRunJournalState } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { ResumeLaneRunUseCase } from '../ResumeLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:05:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:10:00.000Z';
const HOLDER = 'driver-example-1';
const ENTRY_1 = '01JB0000000000000000000001';
const ENTRY_2 = '01JB0000000000000000000002';
const ENTRY_5 = '01JB0000000000000000000005';
const RESUME_CLI_KEY = `${RUN_ID}/park/1/resume@cli`;
const RESUME_WEB_KEY = `${RUN_ID}/park/1/resume@web`;

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

const PARKED: LaneRunParkRecord = {
  reason: 'halted',
  qualifier: null,
  parkedFrom: 'gating',
  questionId: null,
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function ulidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next + 10).padStart(2, '0');
    next += 1;
    return id;
  };
}

interface Fixture {
  repo: LaneRunRepositoryAdapter;
  journal: LaneRunJournalAdapter;
  resume: ResumeLaneRunUseCase;
}

/** A run parked `halted` (parkCount 1) with its parked conduct, leased by `driver-example-1` at fence 1. */
async function seededParked(park: LaneRunParkRecord = PARKED): Promise<Fixture> {
  const repo = new LaneRunRepositoryAdapter();
  const journal = new LaneRunJournalAdapter();
  const record = runRecord();
  expect(await repo.create(record)).toEqual({ outcome: 'saved', record });
  expect(
    await repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    }),
  ).toMatchObject({ outcome: 'saved' });
  expect(
    await repo.save(
      runRecord({
        parked: park,
        parkCount: 1,
        revision: 2,
        lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL },
      }),
      { holderId: HOLDER, fence: 1, nowIso: NOW },
    ),
  ).toMatchObject({ outcome: 'saved' });
  expect(await journal.append(laneRunConductEntry(ENTRY_5, RUN_ID, 'parked', NOW))).toMatchObject({
    outcome: 'appended',
  });
  return {
    repo,
    journal,
    resume: new ResumeLaneRunUseCase({ runRepo: repo, runJournal: journal, newUlid: ulidMinter() }),
  };
}

/** The Advance deps the repair test needs: only the run stores are real; the rest never run in a repair. */
function advanceDeps(repo: LaneRunRepositoryAdapter, journal: LaneRunJournalAdapter): AdvanceLaneRunDependencies {
  return {
    runRepo: repo,
    runJournal: journal,
    attemptRepo: {
      findAttemptById: async () => null,
      saveAttempt: async () => {},
      listAttemptsByWorkOrder: async () => [],
      listAllAttempts: async () => [],
    },
    executionJournal: {
      listActiveReservations: async () => [],
      listJournalEntriesForAttempt: async () => [],
    } as unknown as AdvanceLaneRunDependencies['executionJournal'],
    artifactPort: {
      readBriefManifest: async () => null,
      verifyArtifactManifest: async () => ({ outcome: 'missing' }),
    } as unknown as AdvanceLaneRunDependencies['artifactPort'],
    reconcileAttempt: {
      reconcileAttempt: async () => ({ outcome: 'not-found', attemptId: '' }),
    },
    admission: { admit: async () => ({ outcome: 'admitted' }) },
    newUlid: ulidMinter(),
  };
}

describe('ResumeLaneRunUseCase requestResume', () => {
  it('records a resume via cli under the resume key with the current revision, leaving the run unchanged', async () => {
    const fx = await seededParked();
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toEqual({
      outcome: 'resume-recorded',
      runId: RUN_ID,
      to: 'gating',
      key: RESUME_CLI_KEY,
    });
    const record = await fx.repo.get(RUN_ID);
    expect(record?.revision).toBe(2);
    expect(record?.parked).toEqual(PARKED);
    const entries = await fx.journal.listForRun(RUN_ID);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      kind: 'intent',
      key: RESUME_CLI_KEY,
      expectedRevision: 2,
    });
  });

  it('a repeat of the same resume key is already-requested', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({
      outcome: 'already-requested',
      runId: RUN_ID,
      key: RESUME_CLI_KEY,
    });
  });

  it('refuses a stopped run as run-stopped and appends nothing', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const record = runRecord();
    expect(await repo.create(record)).toEqual({ outcome: 'saved', record });
    expect(await journal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'stopped', NOW))).toMatchObject({
      outcome: 'appended',
    });
    const resume = new ResumeLaneRunUseCase({ runRepo: repo, runJournal: journal, newUlid: ulidMinter() });
    expect(
      await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'run-stopped' });
    expect(await journal.listForRun(RUN_ID)).toHaveLength(1);
  });

  it('refuses a stale revision as stale-revision and appends nothing', async () => {
    const fx = await seededParked();
    expect(
      await fx.resume.requestResume({
        runId: RUN_ID,
        via: 'cli',
        expectedRevision: 1,
        entryId: ENTRY_1,
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    expect(await fx.journal.listForRun(RUN_ID)).toHaveLength(1);
  });

  it('refuses a run with a stop recorded as stop-pending and appends nothing', async () => {
    const fx = await seededParked();
    expect(
      await fx.journal.append({
        ...laneRunIntentEntry(ENTRY_1, RUN_ID, `${RUN_ID}/stop@cli`, null, LATER),
        mode: 'graceful',
        expectedRevision: 2,
      }),
    ).toMatchObject({ outcome: 'appended' });
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'stop-pending' });
    expect(await fx.journal.listForRun(RUN_ID)).toHaveLength(2);
  });

  it('refuses an unparked run as not-parked and appends nothing', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const record = runRecord();
    expect(await repo.create(record)).toEqual({ outcome: 'saved', record });
    const resume = new ResumeLaneRunUseCase({ runRepo: repo, runJournal: journal, newUlid: ulidMinter() });
    expect(
      await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'not-parked' });
    expect(await journal.listForRun(RUN_ID)).toEqual([]);
  });

  it('refuses a stop-unconfirmed park as stop-pending and appends nothing', async () => {
    const fx = await seededParked({
      reason: 'stop-unconfirmed',
      qualifier: null,
      parkedFrom: 'gating',
      questionId: null,
    });
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'stop-pending' });
    expect(await fx.journal.listForRun(RUN_ID)).toHaveLength(1);
  });

  it('refuses a one-way-door park as one-way-door and appends nothing', async () => {
    const fx = await seededParked({
      reason: 'one-way-door',
      qualifier: null,
      parkedFrom: 'gating',
      questionId: null,
    });
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'one-way-door' });
    expect(await fx.journal.listForRun(RUN_ID)).toHaveLength(1);
  });
});

describe('ResumeLaneRunUseCase applyPendingResume', () => {
  it('applies a recorded resume under the lease: conduct, save, then result; the run leaves the park', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });

    const entries = await fx.journal.listForRun(RUN_ID);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ kind: 'conduct', state: 'parked' });
    expect(entries[1]).toMatchObject({ kind: 'intent', key: RESUME_CLI_KEY });
    expect(entries[2]).toMatchObject({ kind: 'conduct', state: 'gating' });
    expect(entries[3]).toMatchObject({
      kind: 'result',
      key: RESUME_CLI_KEY,
      outcome: 'completed',
      reasonCode: 'resumed',
    });
    expect(laneRunJournalState(entries, RUN_ID)).toBe('gating');

    const record = await fx.repo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    expect(record?.revision).toBe(3);
  });

  it('returns none when no resume is pending', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        nowIso: LATER,
      }),
    ).toEqual({ outcome: 'none' });
  });

  it('a stop recorded after the resume intent wins: refused stop-pending, result appended, run still parked', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.journal.append({
        ...laneRunIntentEntry(ENTRY_2, RUN_ID, `${RUN_ID}/stop@cli`, null, LATER),
        mode: 'graceful',
        expectedRevision: 2,
      }),
    ).toMatchObject({ outcome: 'appended' });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'stop-pending' });

    const entries = await fx.journal.listForRun(RUN_ID);
    expect(entries[entries.length - 1]).toMatchObject({
      kind: 'result',
      key: RESUME_CLI_KEY,
      outcome: 'refused',
      reasonCode: 'stop-pending',
    });
    const record = await fx.repo.get(RUN_ID);
    expect(record?.parked).toEqual(PARKED);
    expect(record?.revision).toBe(2);
  });

  it('a wrong lease is refused save-refused after the conduct; a fresh Advance repairs the park exit', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: 'driver-example-2', fence: 99 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });

    const afterFailed = await fx.repo.get(RUN_ID);
    expect(afterFailed?.parked).toEqual(PARKED);
    expect(afterFailed?.revision).toBe(2);
    const entries = await fx.journal.listForRun(RUN_ID);
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'conduct', state: 'gating' });

    const advance = new AdvanceLaneRunUseCase(advanceDeps(fx.repo, fx.journal));
    expect(
      await advance.advanceLaneRun({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        halted: false,
        nowIso: LATER,
      }),
    ).toEqual({ outcome: 'repaired', state: 'gating' });
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();
  });

  it('a web and a cli resume for the same park: the first applies, the second is refused not-parked', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    await fx.resume.requestResume({ runId: RUN_ID, via: 'web', entryId: ENTRY_2, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });

    const entries = await fx.journal.listForRun(RUN_ID);
    const webResults: readonly LaneRunJournalEntryRecord[] = entries.filter(
      (entry) => entry.key === RESUME_WEB_KEY,
    );
    expect(webResults[webResults.length - 1]).toMatchObject({
      kind: 'result',
      key: RESUME_WEB_KEY,
      outcome: 'refused',
      reasonCode: 'not-parked',
    });
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();
  });
});
