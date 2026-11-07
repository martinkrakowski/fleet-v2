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
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import { laneRunJournalPendingIntent, laneRunJournalState } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { LANE_RUN_ONE_WAY_STEPS } from '../../../domain/lane-run-records.js';
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
  schemaVersion: 1,
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

  it('a resume interrupted after its conduct (save refused) is finished by the next applyPendingResume, never refused', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: 'driver-example-2', fence: 99 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(PARKED);

    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        nowIso: LATER,
      }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const record = await fx.repo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    const entries = await fx.journal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'reconciled', reasonCode: 'resumed' });
    expect(entries.filter((entry) => entry.kind === 'conduct' && entry.state === 'gating')).toHaveLength(1);
  });

  it('a stop recorded after an interrupted resume still wins: refused stop-pending, the record stays parked', async () => {
    const fx = await seededParked();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({
        runId: RUN_ID,
        lease: { holderId: 'driver-example-2', fence: 99 },
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });
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
        nowIso: LATER,
      }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'stop-pending' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(PARKED);
    const entries = await fx.journal.listForRun(RUN_ID);
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'refused', reasonCode: 'stop-pending' });
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

  it('RV4: a review-seat-unavailable resume supersedes pending review intents and marks the resumed result review-retry', async () => {
    const keyBuilt = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'brief-check',
      seatIndex: 0,
      attemptOrdinal: null,
      head12: '0123456789ab',
      retry: null,
    });
    expect(keyBuilt.ok).toBe(true);
    const reviewKey = keyBuilt.ok ? keyBuilt.key : '';

    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const park: LaneRunParkRecord = {
      reason: 'review-seat-unavailable',
      qualifier: null,
      parkedFrom: 'brief-check',
      questionId: null,
    };
    const record = runRecord();
    expect(await repo.create(record)).toEqual({ outcome: 'saved', record });
    await repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
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
    await journal.append(laneRunConductEntry(ENTRY_5, RUN_ID, 'parked', NOW));
    // A pending brief-check intent of the parked run, with no final result.
    await journal.append(laneRunIntentEntry('01JB00000000000000000000AA', RUN_ID, reviewKey, 'review-order-pending', NOW));

    const resume = new ResumeLaneRunUseCase({ runRepo: repo, runJournal: journal, newUlid: ulidMinter() });
    expect(
      await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toEqual({ outcome: 'resume-recorded', runId: RUN_ID, to: 'brief-check', key: RESUME_CLI_KEY });
    expect(
      await resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resumed', to: 'brief-check', key: RESUME_CLI_KEY });

    const entries = await journal.listForRun(RUN_ID);
    const reviewResults = entries.filter((entry) => entry.kind === 'result' && entry.key === reviewKey);
    expect(reviewResults).toHaveLength(1);
    expect(reviewResults[0]).toMatchObject({ outcome: 'reconciled', reasonCode: 'review-superseded' });
    const resumeResult = entries.find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(resumeResult).toMatchObject({ reasonCode: 'resumed', detail: 'review-retry' });

    // Review steps stay two-way (never one-way) and the journal never gained a
    // request-digest field (RV4 robustness 8).
    expect((LANE_RUN_ONE_WAY_STEPS as readonly string[]).includes('brief-check')).toBe(false);
    expect((LANE_RUN_ONE_WAY_STEPS as readonly string[]).includes('code-review')).toBe(false);
    for (const entry of entries) {
      expect(Object.hasOwn(entry, 'requestDigest')).toBe(false);
    }
  });
});

const GATE_KEY = `${RUN_ID}/r0/gate/0@0123456789ab`;
const AMBIGUOUS_GATE_PARK: LaneRunParkRecord = {
  reason: 'ambiguous',
  qualifier: 'gate',
  parkedFrom: 'gating',
  questionId: null,
};

/** HN1's shape: parked `ambiguous` at gate with an open ambiguous gate intent. */
async function seededAmbiguousGate(): Promise<Fixture> {
  const fx = await seededParked(AMBIGUOUS_GATE_PARK);
  expect(await fx.journal.append(laneRunIntentEntry('01JB00000000000000000000A1', RUN_ID, GATE_KEY, null, NOW))).toMatchObject({
    outcome: 'appended',
  });
  expect(
    await fx.journal.append(laneRunResultEntry('01JB00000000000000000000A2', RUN_ID, GATE_KEY, 'ambiguous', 'gate-unknown', NOW)),
  ).toMatchObject({ outcome: 'appended' });
  return fx;
}

/** A journal that refuses the first conduct entry appended after `armed` is switched on, as a crash would. */
function crashingOnConduct(journal: LaneRunJournalAdapter): { readonly port: LaneRunJournalPort; arm(): void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    port: {
      append: async (entry) => {
        if (armed && entry.kind === 'conduct') {
          armed = false;
          return { outcome: 'refused', reason: 'invalid-entry', detail: null };
        }
        return journal.append(entry);
      },
      listForRun: (runId) => journal.listForRun(runId),
      listForKey: (key) => journal.listForKey(key),
    },
  };
}

function finalResultsOf(entries: readonly LaneRunJournalEntryRecord[], key: string): readonly LaneRunJournalEntryRecord[] {
  return entries.filter((entry) => entry.kind === 'result' && entry.key === key && entry.outcome !== 'ambiguous');
}

describe('ResumeLaneRunUseCase PT1b3a ambiguous intent', () => {
  it('PT1b3a: applyPendingResume on parked ambiguous gate run abandons pending gate intent before conducting to gating', async () => {
    const oneWayBefore = [...LANE_RUN_ONE_WAY_STEPS];
    const fx = await seededAmbiguousGate();
    expect(laneRunJournalPendingIntent(await fx.journal.listForRun(RUN_ID), RUN_ID)).toEqual({
      key: GATE_KEY,
      step: 'gate',
      reconciliation: 'ambiguous',
    });
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });

    const entries = await fx.journal.listForRun(RUN_ID);
    const finals = finalResultsOf(entries, GATE_KEY);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ outcome: 'overtaken', reasonCode: 'intent-abandoned-by-operator' });
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toBeNull();
    const abandonedAt = entries.indexOf(finals[0]!);
    const gatingAt = entries.findIndex((entry) => entry.kind === 'conduct' && entry.state === 'gating');
    expect(gatingAt).toBeGreaterThan(abandonedAt);
    expect(laneRunJournalState(entries, RUN_ID)).toBe('gating');
    expect(entries.find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY)).toMatchObject({
      outcome: 'completed',
      reasonCode: 'resumed',
    });
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();

    expect([...LANE_RUN_ONE_WAY_STEPS]).toEqual(oneWayBefore);
    for (const entry of entries) {
      expect(Object.hasOwn(entry, 'requestDigest')).toBe(false);
    }
  });

  it('PT1b3a: replay after crash between intent-abandoned-by-operator result and conduct or save never double-writes', async () => {
    const conductCrash = await seededAmbiguousGate();
    await conductCrash.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    const crashing = crashingOnConduct(conductCrash.journal);
    crashing.arm();
    let crashedId = 0;
    const first = new ResumeLaneRunUseCase({
      runRepo: conductCrash.repo,
      runJournal: crashing.port,
      newUlid: () => '01JB00000000000000000000Q' + String((crashedId += 1)),
    });
    expect(await first.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW })).toEqual({
      outcome: 'refused',
      key: RESUME_CLI_KEY,
      reason: 'journal-refused',
    });
    expect(finalResultsOf(await conductCrash.journal.listForRun(RUN_ID), GATE_KEY)).toHaveLength(1);
    expect(
      await conductCrash.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const afterConduct = await conductCrash.journal.listForRun(RUN_ID);
    expect(finalResultsOf(afterConduct, GATE_KEY)).toHaveLength(1);
    expect(laneRunJournalPendingIntent(afterConduct, RUN_ID)).toBeNull();
    expect((await conductCrash.repo.get(RUN_ID))?.parked).toBeNull();

    const saveCrash = await seededAmbiguousGate();
    await saveCrash.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await saveCrash.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: 'driver-example-2', fence: 99 }, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });
    expect(finalResultsOf(await saveCrash.journal.listForRun(RUN_ID), GATE_KEY)).toHaveLength(1);
    expect(
      await saveCrash.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const afterSave = await saveCrash.journal.listForRun(RUN_ID);
    const finals = finalResultsOf(afterSave, GATE_KEY);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ outcome: 'overtaken', reasonCode: 'intent-abandoned-by-operator' });
    expect((await saveCrash.repo.get(RUN_ID))?.parked).toBeNull();
  });

  it('PT1b3a: stop recorded after resume on ambiguous gate park refuses resume as stop-pending without abandoning until advance stops', async () => {
    const fx = await seededAmbiguousGate();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.journal.append({
        ...laneRunIntentEntry(ENTRY_2, RUN_ID, `${RUN_ID}/stop@cli`, null, LATER),
        mode: 'graceful',
        expectedRevision: 2,
      }),
    ).toMatchObject({ outcome: 'appended' });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'stop-pending' });

    const entries = await fx.journal.listForRun(RUN_ID);
    expect(finalResultsOf(entries, GATE_KEY)).toHaveLength(0);
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toEqual({ key: GATE_KEY, step: 'gate', reconciliation: 'ambiguous' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(AMBIGUOUS_GATE_PARK);
  });

  it('PT1b3a robustness (1)(5)(7): requestResume and applyPendingResume refuse malformed, throwing-getter, oversized, and secret-shaped inputs without throwing or echoing values', async () => {
    const fx = await seededAmbiguousGate();
    const throwing: Record<string, unknown> = { via: 'cli', entryId: ENTRY_1, nowIso: NOW };
    Object.defineProperty(throwing, 'runId', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    class Boxed {
      runId = RUN_ID;
      via = 'cli';
      entryId = ENTRY_1;
      nowIso = NOW;
    }
    const secretToken = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4);
    const credentialPath = '/home/' + 'someone' + '/.ssh/' + 'id_ed25519';
    const good = { runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW };
    const badRequests: unknown[] = [
      null,
      undefined,
      'run',
      42,
      [],
      [RUN_ID],
      new Boxed(),
      throwing,
      { ...good, runId: secretToken },
      { ...good, runId: credentialPath },
      { ...good, runId: RUN_ID + 'x' },
      { ...good, via: 'smoke' },
      { ...good, via: 7 },
      { ...good, expectedRevision: 0 },
      { ...good, expectedRevision: -1 },
      { ...good, expectedRevision: Number.NaN },
      { ...good, expectedRevision: 1.5 },
      { ...good, expectedRevision: '2' },
      { ...good, entryId: 'short' },
      { ...good, entryId: secretToken + 'X' },
      { ...good, entryId: ENTRY_1.toLowerCase() },
      { ...good, nowIso: '2026-02-31T10:00:00.000Z' },
      { ...good, nowIso: NOW + ' '.repeat(80) },
      { ...good, nowIso: 'not a date' },
      { ...good, nowIso: undefined },
    ];
    const before = await fx.journal.listForRun(RUN_ID);
    for (const bad of badRequests) {
      const refused = await fx.resume.requestResume(bad as Parameters<ResumeLaneRunUseCase['requestResume']>[0]);
      expect(refused).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(JSON.stringify(refused)).not.toContain(secretToken);
      expect(JSON.stringify(refused)).not.toContain(credentialPath);
    }

    const lease = { holderId: HOLDER, fence: 1 };
    const goodApply = { runId: RUN_ID, lease, nowIso: NOW };
    const throwingLease = { runId: RUN_ID, nowIso: NOW, lease: {} as Record<string, unknown> };
    Object.defineProperty(throwingLease.lease, 'holderId', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    const badApplies: unknown[] = [
      null,
      7,
      [],
      new Boxed(),
      { runId: RUN_ID, nowIso: NOW },
      { ...goodApply, lease: null },
      { ...goodApply, lease: [] },
      throwingLease,
      { ...goodApply, runId: secretToken },
      { ...goodApply, runId: credentialPath },
      { ...goodApply, lease: { holderId: '', fence: 1 } },
      { ...goodApply, lease: { holderId: 5, fence: 1 } },
      { ...goodApply, lease: { holderId: 'h'.repeat(257), fence: 1 } },
      { ...goodApply, lease: { holderId: 'é'.repeat(129), fence: 1 } },
      { ...goodApply, lease: { holderId: secretToken, fence: 1 } },
      { ...goodApply, lease: { holderId: credentialPath, fence: 1 } },
      { ...goodApply, lease: { holderId: HOLDER, fence: 0 } },
      { ...goodApply, lease: { holderId: HOLDER, fence: -3 } },
      { ...goodApply, lease: { holderId: HOLDER, fence: Number.NaN } },
      { ...goodApply, lease: { holderId: HOLDER, fence: Number.MAX_SAFE_INTEGER + 2 } },
      { ...goodApply, lease: { holderId: HOLDER, fence: '1' } },
      { ...goodApply, nowIso: 'yesterday' },
      { ...goodApply, nowIso: '2026-13-01T00:00:00.000Z' },
      { ...goodApply, nowIso: NOW + ' '.repeat(80) },
    ];
    for (const bad of badApplies) {
      const refused = await fx.resume.applyPendingResume(bad as Parameters<ResumeLaneRunUseCase['applyPendingResume']>[0]);
      expect(refused).toEqual({ outcome: 'refused', key: null, reason: 'invalid-request' });
      expect(JSON.stringify(refused)).not.toContain(secretToken);
      expect(JSON.stringify(refused)).not.toContain(credentialPath);
    }
    expect(await fx.journal.listForRun(RUN_ID)).toEqual(before);
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(AMBIGUOUS_GATE_PARK);
    expect(await fx.resume.requestResume(good as Parameters<ResumeLaneRunUseCase['requestResume']>[0])).toMatchObject({
      outcome: 'resume-recorded',
    });
  });
});
