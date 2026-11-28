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
import { laneRunConductEntry, laneRunGateFact, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import { laneRunJournalPendingIntent, laneRunJournalState } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { LANE_RUN_ONE_WAY_STEPS, reviewTransportRetryCountOf } from '../../../domain/lane-run-records.js';
import type { LaneRunParkRecord, LaneRunRecord, LaneRunReviewRetryRecord } from '../../../domain/lane-run-records.js';
import { readLaneRunRecord } from '../../../domain/entities/LaneRun.js';
import { performPark } from '../advance-lane-run/step-context.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { ResumeLaneRunUseCase } from '../ResumeLaneRunUseCase.use-case.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('acts on validated values and refuses altered ones when the request object is mutated after validation during awaits', async () => {
    const fx = await seededParked();
    const originalGet = fx.repo.get.bind(fx.repo);

    // Case 1: Caller validates a request with stale revision (1) and mutates expectedRevision to
    // matching revision (2) during await to attempt bypassing the stale-revision refusal.
    const staleRequest = {
      runId: RUN_ID,
      via: 'cli' as const,
      expectedRevision: 1,
      entryId: ENTRY_1,
      nowIso: NOW,
    };
    fx.repo.get = async (id: string) => {
      (staleRequest as { expectedRevision?: number }).expectedRevision = 2;
      (staleRequest as { via: string }).via = 'web';
      (staleRequest as { runId: string }).runId = 'run-01JB9999999999999999999999';
      return originalGet(id);
    };

    const staleResult = await fx.resume.requestResume(staleRequest);
    expect(staleResult).toEqual({ outcome: 'refused', reason: 'stale-revision' });

    // Case 2: Caller validates a request with valid revision (2) and mutates expectedRevision to
    // stale revision (1) or different via during await: use case still acts on validated values and succeeds.
    const validRequest = {
      runId: RUN_ID,
      via: 'cli' as const,
      expectedRevision: 2,
      entryId: ENTRY_2,
      nowIso: NOW,
    };
    fx.repo.get = async (id: string) => {
      (validRequest as { expectedRevision?: number }).expectedRevision = 1;
      (validRequest as { via: string }).via = 'web';
      (validRequest as { runId: string }).runId = 'run-01JB9999999999999999999999';
      return originalGet(id);
    };

    const validResult = await fx.resume.requestResume(validRequest);
    expect(validResult).toEqual({
      outcome: 'resume-recorded',
      runId: RUN_ID,
      to: 'gating',
      key: RESUME_CLI_KEY,
    });
    const entries = await fx.journal.listForRun(RUN_ID);
    const intent = entries.find((e) => e.kind === 'intent' && e.key === RESUME_CLI_KEY);
    expect(intent).toMatchObject({
      expectedRevision: 2,
      runId: RUN_ID,
    });
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

  it('PT1b3a: crash-finish path on an already-unparked record abandons the ambiguous gate intent before settling resume requests', async () => {
    const fx = await seededAmbiguousGate();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    // An older interrupted resume already landed its save: the record is
    // unparked while the ambiguous gate intent is still open.
    expect(
      await fx.repo.save(
        runRecord({
          parked: null,
          parkCount: 1,
          revision: 3,
          lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL },
        }),
        { holderId: HOLDER, fence: 1, nowIso: NOW },
      ),
    ).toMatchObject({ outcome: 'saved' });

    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'none' });

    const entries = await fx.journal.listForRun(RUN_ID);
    const finals = finalResultsOf(entries, GATE_KEY);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ outcome: 'overtaken', reasonCode: 'intent-abandoned-by-operator' });
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toBeNull();
    const abandonedAt = entries.indexOf(finals[0]!);
    const resumeResultAt = entries.findIndex(
      (entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY && entry.reasonCode === 'resumed',
    );
    expect(resumeResultAt).toBeGreaterThan(abandonedAt);

    // A retry never double-writes: the key keeps exactly one final result.
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'none' });
    expect(finalResultsOf(await fx.journal.listForRun(RUN_ID), GATE_KEY)).toHaveLength(1);
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

  it('acts on validated values and refuses altered ones when the request object is mutated after validation during awaits', async () => {
    // Case 1: Caller validates an apply with an unauthorized lease and mutates to the authorized lease
    // during await to attempt bypassing the lease check: use case acts on validated values and refuses save.
    const fx1 = await seededParked();
    await fx1.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    const originalGet1 = fx1.repo.get.bind(fx1.repo);

    const unauthorizedApply = {
      runId: RUN_ID,
      lease: { holderId: 'unauthorized-driver', fence: 99 },
      nowIso: NOW,
    };
    fx1.repo.get = async (id: string) => {
      (unauthorizedApply as { runId: string }).runId = 'run-01JB9999999999999999999999';
      unauthorizedApply.lease.holderId = HOLDER;
      unauthorizedApply.lease.fence = 1;
      return originalGet1(id);
    };

    const unauthResult = await fx1.resume.applyPendingResume(unauthorizedApply);
    expect(unauthResult).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });

    // Case 2: Caller validates an apply with authorized lease and mutates to invalid/unauthorized values
    // during await: use case still acts on validated values and succeeds.
    const fx2 = await seededParked();
    await fx2.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    const originalGet2 = fx2.repo.get.bind(fx2.repo);

    const validApply = {
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      nowIso: NOW,
    };
    fx2.repo.get = async (id: string) => {
      (validApply as { runId: string }).runId = 'run-01JB9999999999999999999999';
      validApply.lease.holderId = 'attacker-driver';
      validApply.lease.fence = 99;
      return originalGet2(id);
    };

    const validResult = await fx2.resume.applyPendingResume(validApply);
    expect(validResult).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const record = await fx2.repo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    expect(record?.revision).toBe(3);
  });
});

const GATE_FAILED_PARK: LaneRunParkRecord = { reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'gating', questionId: null };

const RETRY_KEY = (retry: number) => `${GATE_KEY}/retry${retry}`;

/** GU2: a run parked from `gating` whose gate already settled `gate-failed`, plus optional failed retries. */
async function seededGateFailedPark(retries: readonly number[] = [], park: LaneRunParkRecord = GATE_FAILED_PARK): Promise<Fixture> {
  const fx = await seededParked(park);
  expect(await fx.journal.append(laneRunIntentEntry('01JB00000000000000000000A1', RUN_ID, GATE_KEY, null, NOW))).toMatchObject({
    outcome: 'appended',
  });
  expect(
    await fx.journal.append(laneRunResultEntry('01JB00000000000000000000A2', RUN_ID, GATE_KEY, 'completed', 'gate-failed', NOW)),
  ).toMatchObject({ outcome: 'appended' });
  let id = 0;
  for (const retry of retries) {
    id += 1;
    expect(await fx.journal.append(laneRunIntentEntry(`01JB00000000000000000000B${id}`, RUN_ID, RETRY_KEY(retry), null, NOW))).toMatchObject({
      outcome: 'appended',
    });
    expect(
      await fx.journal.append(laneRunResultEntry(`01JB00000000000000000000C${id}`, RUN_ID, RETRY_KEY(retry), 'completed', 'gate-failed', NOW)),
    ).toMatchObject({ outcome: 'appended' });
  }
  return fx;
}

/** GU2: the advance re-ran the gate at `retry` (the intent the resume minted) and it failed again; the run parks once more. */
async function failGateRetryAndRePark(fx: Fixture, retry: number): Promise<void> {
  const before = await fx.repo.get(RUN_ID);
  expect(before?.parked).toBeNull();
  expect(
    await fx.journal.append(laneRunResultEntry(`01JB00000000000000000000E${retry}`, RUN_ID, RETRY_KEY(retry), 'completed', 'gate-failed', NOW)),
  ).toMatchObject({ outcome: 'appended' });
  expect(await fx.journal.append(laneRunConductEntry(`01JB00000000000000000000F${retry}`, RUN_ID, 'parked', NOW))).toMatchObject({
    outcome: 'appended',
  });
  expect(
    await fx.repo.save(
      runRecord({
        parked: GATE_FAILED_PARK,
        parkCount: (before?.parkCount ?? 0) + 1,
        revision: (before?.revision ?? 0) + 1,
        lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL },
      }),
      { holderId: HOLDER, fence: 1, nowIso: NOW },
    ),
  ).toMatchObject({ outcome: 'saved' });
}

function gateRetryIntents(entries: readonly LaneRunJournalEntryRecord[]): readonly LaneRunJournalEntryRecord[] {
  return entries.filter((entry) => entry.kind === 'intent' && entry.key !== null && /gate\/\d+@.+\/retry\d+$/.test(entry.key));
}

describe('ResumeLaneRunUseCase GU2 bounded gate retry', () => {
  it('mints the retry1 gate intent at the same head when resuming a run parked from gating after gate-failed', async () => {
    const fx = await seededGateFailedPark();
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resume-recorded', to: 'gating' });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });

    const entries = await fx.journal.listForRun(RUN_ID);
    expect(gateRetryIntents(entries)).toHaveLength(1);
    expect(gateRetryIntents(entries)[0]).toMatchObject({ key: RETRY_KEY(1) });
    // The minted retry is the run's open step intent at the SAME head: the
    // decider's gate fact reads pending there, so the next advance re-runs it.
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toEqual({ key: RETRY_KEY(1), step: 'gate', reconciliation: 'unread' });
    expect(laneRunGateFact(entries, RUN_ID, '0123456789ab')).toBe('pending');
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();
  });

  it('allows up to three operator gate retries and refuses the fourth with gate-retry-cap-reached, keeping the run parked', async () => {
    const fx = await seededGateFailedPark();
    for (let retry = 1; retry <= 3; retry += 1) {
      expect(
        await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: `01JB00000000000000000000P${retry}`, nowIso: NOW }),
      ).toMatchObject({ outcome: 'resume-recorded' });
      expect(
        await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
      ).toEqual({ outcome: 'resumed', to: 'gating', key: `${RUN_ID}/park/${retry}/resume@cli` });
      await failGateRetryAndRePark(fx, retry);
    }
    const before = await fx.journal.listForRun(RUN_ID);
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'gate-retry-cap-reached' });
    expect(await fx.journal.listForRun(RUN_ID)).toEqual(before);
    expect((await fx.repo.get(RUN_ID))?.parked).toMatchObject({ parkedFrom: 'gating' });
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(3);
  });

  it('refuses applyPendingResume with gate-retry-cap-reached when a third gate failure lands after the resume request', async () => {
    const fx = await seededGateFailedPark([1, 2]);
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resume-recorded' });
    // The third gate run fails before the driver applies the recorded resume.
    expect(await fx.journal.append(laneRunIntentEntry('01JB00000000000000000000D3', RUN_ID, RETRY_KEY(3), null, NOW))).toMatchObject({
      outcome: 'appended',
    });
    expect(
      await fx.journal.append(laneRunResultEntry('01JB00000000000000000000E3', RUN_ID, RETRY_KEY(3), 'completed', 'gate-failed', NOW)),
    ).toMatchObject({ outcome: 'appended' });
    const parked = await fx.repo.get(RUN_ID);
    expect(parked?.parked).toMatchObject({ parkedFrom: 'gating' });

    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'gate-retry-cap-reached' });
    const entries = await fx.journal.listForRun(RUN_ID);
    expect(gateRetryIntents(entries)).toHaveLength(3);
    expect(entries.find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY)).toMatchObject({
      outcome: 'refused',
      reasonCode: 'gate-retry-cap-reached',
    });
    expect((await fx.repo.get(RUN_ID))?.parked).toMatchObject({ parkedFrom: 'gating' });
  });

  it('replayed applyPendingResume after a crash before the save does not mint a second retry intent', async () => {
    const fx = await seededGateFailedPark();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    // The first apply mints retry1 and conducts, but its save is refused: the
    // record stays parked with the minted retry intent open.
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: 'driver-example-2', fence: 99 }, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });
    expect((await fx.repo.get(RUN_ID))?.parked).toMatchObject({ parkedFrom: 'gating' });
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(1);

    // The replay sees the open retry intent (no final yet), plans `none`, and
    // never mints a second retry key.
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const entries = await fx.journal.listForRun(RUN_ID);
    expect(gateRetryIntents(entries)).toHaveLength(1);
    expect(gateRetryIntents(entries)[0]).toMatchObject({ key: RETRY_KEY(1) });
  });

  it('a resume of a run not parked from gating is unchanged and never mints a gate retry', async () => {
    const fx = await seededParked({ reason: 'halted', qualifier: null, parkedFrom: 'brief-check', questionId: null });
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resume-recorded', to: 'brief-check' });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'resumed', to: 'brief-check', key: RESUME_CLI_KEY });
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(0);
  });

  it('a resume of a run parked from gating whose gate is unknown never mints a gate-failed retry', async () => {
    const fx = await seededAmbiguousGate();
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resume-recorded', to: 'gating' });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(0);
  });

  it('a stop recorded after the resume request refuses as stop-pending without minting a gate retry', async () => {
    const fx = await seededGateFailedPark();
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
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(0);
    expect((await fx.repo.get(RUN_ID))?.parked).toMatchObject({ parkedFrom: 'gating' });
  });

  it('a resume refused as stale-revision mints no gate retry intent and leaves the run parked', async () => {
    const fx = await seededGateFailedPark();
    await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    // The record moves on after the request: the recorded expected revision is now stale.
    const current = await fx.repo.get(RUN_ID);
    expect(
      await fx.repo.save({ ...(current as LaneRunRecord), revision: (current?.revision ?? 0) + 1 }, { holderId: HOLDER, fence: 1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'saved' });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'stale-revision' });
    const entries = await fx.journal.listForRun(RUN_ID);
    expect(gateRetryIntents(entries)).toHaveLength(0);
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toBeNull();
    expect((await fx.repo.get(RUN_ID))?.parked).toMatchObject({ parkedFrom: 'gating' });
  });

  it('returns journal-refused when minting the gate retry intent is refused', async () => {
    const fx = await seededGateFailedPark();
    const refusing = Object.create(fx.journal) as LaneRunJournalPort;
    refusing.append = async (entry) =>
      entry.kind === 'intent' && entry.key === RETRY_KEY(1)
        ? { outcome: 'refused', reason: 'storage-unavailable' as never, detail: null }
        : fx.journal.append(entry);
    const resume = new ResumeLaneRunUseCase({ runRepo: fx.repo, runJournal: refusing, newUlid: ulidMinter() });
    await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'journal-refused' });
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(0);
    expect((await fx.repo.get(RUN_ID))?.parked).toMatchObject({ parkedFrom: 'gating' });
  });

  it.each(['cost-ceiling', 'step-refused', 'artifacts-unsealed', 'seat-plan-exhausted'] as const)(
    'a %s park from gating after gate-failed mints no gate retry',
    async (reason) => {
      const fx = await seededGateFailedPark([], { reason, qualifier: reason === 'step-refused' ? 'gate' : null, parkedFrom: 'gating', questionId: null } as LaneRunParkRecord);
      expect(await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW })).toMatchObject({
        outcome: 'resume-recorded',
      });
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW });
      expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(0);
    },
  );

  it('a halted park from gating at the retry cap resumes normally instead of gate-retry-cap-reached', async () => {
    const fx = await seededGateFailedPark([1, 2, 3], { reason: 'halted', qualifier: null, parkedFrom: 'gating', questionId: null });
    expect(await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW })).toMatchObject({
      outcome: 'resume-recorded',
      to: 'gating',
    });
  });

  it('a halted park from gating after gate-failed takes the normal resume path and mints no gate retry', async () => {
    const fx = await seededGateFailedPark([], { reason: 'halted', qualifier: null, parkedFrom: 'gating', questionId: null });
    expect(
      await fx.resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resume-recorded', to: 'gating' });
    expect(
      await fx.resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    expect(gateRetryIntents(await fx.journal.listForRun(RUN_ID))).toHaveLength(0);
  });
});

describe('reviewTransportRetry record (AB-TP4A)', () => {
  const RETRY: LaneRunReviewRetryRecord = {
    step: 'brief-check',
    head12: '0123456789ab',
    count: 1,
    nextRetryAtIso: NOW,
  };

  function withRetry(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
    return runRecord({ reviewTransportRetry: RETRY, ...overrides });
  }

  it('survives LaneRun.create, toRecord, readLaneRunRecord and a JSON round-trip', () => {
    const created = LaneRun.create(withRetry());
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error('fixture must be a valid LaneRun record');
    }
    const stored = created.value.toRecord();
    expect(stored.reviewTransportRetry).toEqual(RETRY);
    const reread = readLaneRunRecord(JSON.parse(JSON.stringify(stored)));
    expect(reread.ok).toBe(true);
    if (!reread.ok) {
      throw new Error('fixture must re-read');
    }
    expect(reread.record.reviewTransportRetry).toEqual(RETRY);
    // `null` is valid too: the run has left the park.
    const cleared = LaneRun.create(runRecord({ reviewTransportRetry: null }));
    expect(cleared.success).toBe(true);
  });

  it('round-trips through LaneRunRepositoryAdapter create, get and list in memory and file mode', async () => {
    const repo = new LaneRunRepositoryAdapter();
    expect(await repo.create(withRetry())).toMatchObject({ outcome: 'saved' });
    expect((await repo.get(RUN_ID))?.reviewTransportRetry).toEqual(RETRY);
    expect((await repo.list())[0]?.reviewTransportRetry).toEqual(RETRY);

    const stateDir = mkdtempSync(join(tmpdir(), 'lane-run-retry-'));
    try {
      const fileRepo = new LaneRunRepositoryAdapter({ stateDir });
      expect(await fileRepo.create(withRetry())).toMatchObject({ outcome: 'saved' });
      expect((await fileRepo.get(RUN_ID))?.reviewTransportRetry).toEqual(RETRY);
      const reloaded = new LaneRunRepositoryAdapter({ stateDir });
      expect((await reloaded.get(RUN_ID))?.reviewTransportRetry).toEqual(RETRY);
      expect((await reloaded.list())[0]?.reviewTransportRetry).toEqual(RETRY);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('save round-trips a changed reviewTransportRetry in memory and file mode and keeps it across a reload', async () => {
    const leased = { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL };
    const next: LaneRunReviewRetryRecord = { ...RETRY, count: 2 };
    const guard = { holderId: HOLDER, fence: 1, nowIso: NOW };
    const stateDir = mkdtempSync(join(tmpdir(), 'lane-run-retry-save-'));
    try {
      for (const repo of [new LaneRunRepositoryAdapter(), new LaneRunRepositoryAdapter({ stateDir })]) {
        expect(await repo.create(withRetry({ lease: leased }))).toMatchObject({ outcome: 'saved' });
        const saved = await repo.save({ ...withRetry({ lease: leased }), reviewTransportRetry: next, revision: 2 }, guard);
        expect(saved).toMatchObject({ outcome: 'saved' });
        expect((await repo.get(RUN_ID))?.reviewTransportRetry).toEqual(next);
        const cleared = await repo.save({ ...withRetry({ lease: leased }), reviewTransportRetry: null, revision: 3 }, guard);
        expect(cleared).toMatchObject({ outcome: 'saved' });
        expect((await repo.get(RUN_ID))?.reviewTransportRetry).toBeNull();
      }
      expect((await new LaneRunRepositoryAdapter({ stateDir }).get(RUN_ID))?.reviewTransportRetry).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('reviewTransportRetryCountOf reads 0 when absent or null and the count when present', () => {
    expect(reviewTransportRetryCountOf(withRetry(), 'brief-check', '0123456789ab')).toBe(1);
    expect(reviewTransportRetryCountOf(runRecord())).toBe(0);
    expect(reviewTransportRetryCountOf(runRecord({ reviewTransportRetry: null }))).toBe(0);
    expect(reviewTransportRetryCountOf(withRetry(), 'code-review')).toBe(0);
    expect(reviewTransportRetryCountOf(withRetry(), 'brief-check', 'ffffffffffff')).toBe(0);
    expect(reviewTransportRetryCountOf(null)).toBe(0);
    expect(reviewTransportRetryCountOf([withRetry()])).toBe(0);
    expect(reviewTransportRetryCountOf('run')).toBe(0);
  });

  it('reviewTransportRetryCountOf never runs a getter and returns 0', () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'reviewTransportRetry', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    expect(reviewTransportRetryCountOf(throwing)).toBe(0);
    const throwingCount: Record<string, unknown> = { step: 'brief-check', head12: '0123456789ab' };
    Object.defineProperty(throwingCount, 'count', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    expect(reviewTransportRetryCountOf({ reviewTransportRetry: throwingCount })).toBe(0);
  });

  it.each([
    ['an extra key', { ...RETRY, extra: 1 }],
    ['a missing key', { step: 'brief-check', head12: '0123456789ab', count: 1 }],
    ['a bad step', { ...RETRY, step: 'gate' }],
    ['a bad head12', { ...RETRY, head12: '0123456789' }],
    ['an uppercase head12', { ...RETRY, head12: '0123456789AB' }],
    ['a negative count', { ...RETRY, count: -1 }],
    ['a non-integer count', { ...RETRY, count: 1.5 }],
    ['a count over the cap', { ...RETRY, count: 101 }],
    ['an impossible nextRetryAtIso', { ...RETRY, nextRetryAtIso: '2026-02-31T10:00:00.000Z' }],
    ['a non-ISO nextRetryAtIso', { ...RETRY, nextRetryAtIso: 'not a date' }],
    ['a null step', { ...RETRY, step: null }],
  ] as readonly [string, unknown][])('%s is refused by LaneRun.create and LaneRunRepositoryAdapter.create', async (_name, bad) => {
    const badRecord = { ...BASE_RECORD, reviewTransportRetry: bad };
    const refused = LaneRun.create(badRecord);
    expect(refused.success).toBe(false);
    if (refused.success) {
      throw new Error('fixture must be refused');
    }
    expect(refused.code).toBe('invalid');
    expect(refused.error.message).toBe('LaneRun reviewTransportRetry is invalid');
    const reread = readLaneRunRecord(badRecord);
    expect(reread.ok).toBe(false);
    expect(await new LaneRunRepositoryAdapter().create(badRecord as unknown as LaneRunRecord)).toEqual({
      outcome: 'refused',
      reason: 'invalid-record',
    });
  });

  it('a throwing getter on the retry value is refused by LaneRun.create without running the accessor', () => {
    const throwingRetry: Record<string, unknown> = { ...RETRY };
    Object.defineProperty(throwingRetry, 'step', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    const refused = LaneRun.create({ ...BASE_RECORD, reviewTransportRetry: throwingRetry });
    expect(refused.success).toBe(false);
    const throwingKey: Record<string, unknown> = { ...runRecord() };
    Object.defineProperty(throwingKey, 'reviewTransportRetry', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    expect(LaneRun.create(throwingKey).success).toBe(false);
  });

  it('performPark clears reviewTransportRetry to null when the run parks', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    expect(await repo.create(withRetry())).toMatchObject({ outcome: 'saved' });
    expect(
      await repo.acquireLease(RUN_ID, {
        holderId: HOLDER,
        observedFence: 0,
        leaseUntilIso: LEASE_UNTIL,
        nowIso: NOW,
      }),
    ).toMatchObject({ outcome: 'saved' });
    const before = await repo.get(RUN_ID);
    expect(before?.reviewTransportRetry).toEqual(RETRY);
    const ctx = { deps: { runRepo: repo, runJournal: journal, newUlid: ulidMinter() } };
    const request = { runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, halted: false, nowIso: NOW };
    expect(
      await performPark(ctx as never, before as LaneRunRecord, 'halted', null, 'gating', request as never),
    ).toMatchObject({ outcome: 'parked', reason: 'halted' });
    const parked = await repo.get(RUN_ID);
    expect(parked?.parked).not.toBeNull();
    expect(parked?.reviewTransportRetry).toBeNull();
    expect(reviewTransportRetryCountOf(parked)).toBe(0);
  });

  it('applyPendingResume clears reviewTransportRetry to null on the normal resume path', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const record = withRetry({ parked: PARKED, parkCount: 1, revision: 2, lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL } });
    expect(await repo.create(withRetry())).toMatchObject({ outcome: 'saved' });
    await repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
    expect(
      await repo.save(record, { holderId: HOLDER, fence: 1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'saved' });
    await journal.append(laneRunConductEntry(ENTRY_5, RUN_ID, 'parked', NOW));
    const resume = new ResumeLaneRunUseCase({ runRepo: repo, runJournal: journal, newUlid: ulidMinter() });
    await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: NOW }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const resumed = await repo.get(RUN_ID);
    expect(resumed?.parked).toBeNull();
    expect(resumed?.reviewTransportRetry).toBeNull();
  });

  it('the crash-repair resume exit (finishConductedResumeExit) also clears reviewTransportRetry', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const record = withRetry({ parked: PARKED, parkCount: 1, revision: 2, lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL } });
    expect(await repo.create(withRetry())).toMatchObject({ outcome: 'saved' });
    await repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
    expect(
      await repo.save(record, { holderId: HOLDER, fence: 1, nowIso: NOW }),
    ).toMatchObject({ outcome: 'saved' });
    await journal.append(laneRunConductEntry(ENTRY_5, RUN_ID, 'parked', NOW));
    const resume = new ResumeLaneRunUseCase({ runRepo: repo, runJournal: journal, newUlid: ulidMinter() });
    await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    // The first apply's save is refused (wrong lease): the record stays parked
    // with the retry; the replay's conducted exit finishes it.
    expect(
      await resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: 'driver-example-2', fence: 99 }, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });
    expect((await repo.get(RUN_ID))?.reviewTransportRetry).toEqual(RETRY);
    expect(
      await resume.applyPendingResume({ runId: RUN_ID, lease: { holderId: HOLDER, fence: 1 }, nowIso: LATER }),
    ).toEqual({ outcome: 'resumed', to: 'gating', key: RESUME_CLI_KEY });
    const resumed = await repo.get(RUN_ID);
    expect(resumed?.parked).toBeNull();
    expect(resumed?.reviewTransportRetry).toBeNull();
  });
});
