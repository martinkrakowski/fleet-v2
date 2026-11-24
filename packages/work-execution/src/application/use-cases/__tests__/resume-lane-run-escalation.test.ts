// ResumeLaneRunUseCase park-escalation tests (CE1, this change).
/**
 * A `fix-no-progress` park is refused by the plain resume rule; this change
 * lets `requestResume` and `applyPendingResume` escalate it instead, through
 * the domain's `checkParkEscalation`, when the worktree inspection shows
 * uncommitted tracked work. These tests prove the escalation fires on a dirty
 * worktree, that every unreadable or hostile input fails closed to
 * `fix-no-progress` (or the more precise escalation refusal), that a clean
 * worktree and a second escalation stay parked, and that the escalation never
 * bypasses the resume check order (stop, stale revision, stopped, one-way
 * door).
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { PARK_ESCALATION_HISTORY_MAX } from '../../../domain/park-escalation.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import type { WorkspacePort, WorktreeInspection, WorktreeInspectionRequest } from '../../ports/out/WorkspacePort.out-port.js';
import { ResumeLaneRunUseCase } from '../ResumeLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:05:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:10:00.000Z';
const HOLDER = 'driver-example-1';
const ATTEMPT_ID = 'attempt-example-1';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const BASE_COMMIT = 'f'.repeat(40);
const WORKTREE_PATH = '/tmp/opencode/lanes/attempt-example-1';
const RESUME_CLI_KEY = `${RUN_ID}/park/1/resume@cli`;
const FIX_PARK: LaneRunParkRecord = {
  reason: 'fix-no-progress',
  qualifier: null,
  parkedFrom: 'fixing',
  questionId: null,
};

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
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
  schemaVersion: 1,
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: BASE_COMMIT,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: 'lane-host-1',
      agent: null,
      model: 'nvidia/z-ai/glm-5.3',
      variant: null,
    },
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

const DIRTY_INSPECTION: WorktreeInspection = {
  worktreePath: WORKTREE_PATH,
  checkedOutCommit: HEAD,
  matchesBaseCommit: false,
  uncommittedPaths: ['src/changed.ts'],
  untrackedPaths: [],
  residueFromEarlierAttempts: [],
  missingExpectedArtifacts: [],
};

let entryCounter = 0;
/** A unique 26-char ULID-shaped entry id per call (the tests append many entries). */
function nextEntryId(): string {
  entryCounter += 1;
  return `01JB${'0'.repeat(18)}${String(entryCounter).padStart(4, '0')}`;
}

interface EscalationFixture {
  repo: LaneRunRepositoryAdapter;
  journal: LaneRunJournalAdapter;
  resume: ResumeLaneRunUseCase;
  readonly inspectCalls: { count: number };
  readonly inspectRequests: Array<WorktreeInspectionRequest>;
  readonly attemptReads: { count: number };
}

interface SeedOptions {
  /** The inspection answer (default dirty); `null` and `undefined` read malformed. */
  inspect?: unknown;
  /** A factory instead of a fixed answer (e.g. a rejecting promise). */
  inspectFactory?: () => Promise<unknown>;
  /** Wire `worktreeInspect` (default true). */
  wireInspect?: boolean;
  /** Wire `attemptRepo` (default true). */
  wireAttempts?: boolean;
  /** The attempt the fake repo returns (default a collected attempt at HEAD). */
  attempt?: AttemptRecord | null;
  /** A different park record (e.g. `one-way-door`). */
  park?: LaneRunParkRecord;
}

async function seededEscalation(options: SeedOptions = {}): Promise<EscalationFixture> {
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
        parked: options.park ?? FIX_PARK,
        parkCount: 1,
        revision: 2,
        lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL },
      }),
      { holderId: HOLDER, fence: 1, nowIso: NOW },
    ),
  ).toMatchObject({ outcome: 'saved' });
  expect(await journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', NOW))).toMatchObject({
    outcome: 'appended',
  });

  const attemptReads = { count: 0 };
  const attempt = options.attempt === undefined ? makeAttempt() : options.attempt;
  const attempts = new Map<string, AttemptRecord | null>([[ATTEMPT_ID, attempt]]);
  const attemptRepo = options.wireAttempts === false
    ? undefined
    : {
        findAttemptById: async (attemptId: string): Promise<AttemptRecord | null> => {
          attemptReads.count += 1;
          return attempts.get(attemptId) ?? null;
        },
      };

  const inspectCalls = { count: 0 };
  const inspectRequests: Array<WorktreeInspectionRequest> = [];
  const worktreeInspect = options.wireInspect === false
    ? undefined
    : {
        inspectWorktree: async (request: WorktreeInspectionRequest): Promise<WorktreeInspection> => {
          inspectCalls.count += 1;
          inspectRequests.push(request);
          if (options.inspectFactory !== undefined) {
            return (await options.inspectFactory()) as WorktreeInspection;
          }
          return ('inspect' in options ? options.inspect : DIRTY_INSPECTION) as WorktreeInspection;
        },
      } satisfies Pick<WorkspacePort, 'inspectWorktree'>;

  const resume = new ResumeLaneRunUseCase({
    runRepo: repo,
    runJournal: journal,
    newUlid: nextEntryId,
    attemptRepo,
    worktreeInspect,
  });
  return { repo, journal, resume, inspectCalls, inspectRequests, attemptReads };
}

function request(fx: EscalationFixture, overrides: Record<string, unknown> = {}): ReturnType<ResumeLaneRunUseCase['requestResume']> {
  return fx.resume.requestResume({
    runId: RUN_ID,
    via: 'cli',
    entryId: nextEntryId(),
    nowIso: LATER,
    expectedRevision: 2,
    ...overrides,
  } as never);
}

function apply(fx: EscalationFixture, overrides: Record<string, unknown> = {}): ReturnType<ResumeLaneRunUseCase['applyPendingResume']> {
  return fx.resume.applyPendingResume({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    nowIso: LATER,
    ...overrides,
  } as never);
}

/** A pending resume intent recorded directly, for apply-side tests. */
async function seedPendingResume(fx: EscalationFixture): Promise<void> {
  const appended = await fx.journal.append({
    ...laneRunIntentEntry(nextEntryId(), RUN_ID, RESUME_CLI_KEY, null, NOW),
    expectedRevision: 2,
  } as LaneRunJournalEntryRecord);
  if (appended.outcome !== 'appended') {
    throw new Error(`seedPendingResume refused: ${JSON.stringify(appended)}`);
  }
}

async function entriesForRun(fx: EscalationFixture): Promise<readonly LaneRunJournalEntryRecord[]> {
  return fx.journal.listForRun(RUN_ID);
}

/** An inspection whose `uncommittedPaths` carries a hole (index 0 deleted). */
function inspectionWithHole(): WorktreeInspection {
  const holed: unknown[] = ['src/a.ts', 'src/b.ts'];
  delete holed[0];
  return { ...DIRTY_INSPECTION, uncommittedPaths: holed } as unknown as WorktreeInspection;
}

describe('ResumeLaneRunUseCase fix-no-progress park escalation', () => {
  it('refuses hostile request inputs with invalid-request without invoking getters', async () => {
    const fx = await seededEscalation();
    const getterCalls: string[] = [];
    const getterRequest: Record<string, unknown> = {
      runId: RUN_ID,
      entryId: nextEntryId(),
      nowIso: LATER,
      expectedRevision: 2,
    };
    Object.defineProperty(getterRequest, 'via', {
      enumerable: true,
      get: () => {
        getterCalls.push('via');
        return 'cli';
      },
    });
    const protoKeyRequest: Record<string, unknown> = {
      runId: RUN_ID,
      via: 'cli',
      entryId: nextEntryId(),
      nowIso: LATER,
    };
    Object.defineProperty(protoKeyRequest, '__proto__', { value: { via: 'cli' }, enumerable: true });

    expect(await fx.resume.requestResume(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await fx.resume.requestResume(undefined as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await fx.resume.requestResume([RUN_ID] as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await fx.resume.requestResume(getterRequest as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await fx.resume.requestResume(protoKeyRequest as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(getterCalls).toEqual([]);
  });

  it('refuses fix-no-progress when worktreeInspect or attemptRepo is unwired', async () => {
    const withoutInspect = await seededEscalation({ wireInspect: false });
    expect(await request(withoutInspect)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });
    expect(withoutInspect.inspectRequests).toEqual([]);

    const withoutAttempts = await seededEscalation({ wireAttempts: false });
    expect(await request(withoutAttempts)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });
    expect(withoutAttempts.inspectRequests).toEqual([]);

    // The apply path fails closed the same way.
    const applyFx = await seededEscalation({ wireInspect: false });
    await seedPendingResume(applyFx);
    expect(await apply(applyFx)).toMatchObject({ outcome: 'refused', reason: 'fix-no-progress' });
    const results = (await entriesForRun(applyFx)).filter((entry) => entry.kind === 'result');
    expect(results[0]).toMatchObject({ outcome: 'refused', reasonCode: 'fix-no-progress', key: RESUME_CLI_KEY });
  });

  it('refuses fix-no-progress when the parked attempt or its collected headCommit is unreadable', async () => {
    const missing = await seededEscalation({ attempt: null });
    expect(await request(missing)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });

    const noArtifacts = await seededEscalation({ attempt: makeAttempt({ artifacts: null }) });
    expect(await request(noArtifacts)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });

    const shortHead = await seededEscalation({
      attempt: makeAttempt({ artifacts: { headCommit: 'abc', commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' } }),
    });
    expect(await request(shortHead)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });

    // The record cannot drop its attempts through the repository contract, so
    // the empty `attemptIds` case is covered by the missing-attempt case above
    // (the helper returns null for an unknown id).
  });

  it('refuses fix-no-progress when inspectWorktree rejects or times out', async () => {
    const rejecting = await seededEscalation({
      inspectFactory: () => Promise.reject(new Error('boom')),
    });
    expect(await request(rejecting)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });

    const timingOut = await seededEscalation({
      inspectFactory: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), 10)),
    });
    expect(await request(timingOut)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });
  });

  it('refuses fix-no-progress when inspectWorktree returns malformed or getter-backed data', async () => {
    const getterBacked: Record<string, unknown> = { ...DIRTY_INSPECTION };
    Reflect.deleteProperty(getterBacked, 'uncommittedPaths');
    Object.defineProperty(getterBacked, 'uncommittedPaths', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    const malformed: unknown[] = [
      null,
      undefined,
      'not-an-object',
      getterBacked,
      { ...DIRTY_INSPECTION, uncommittedPaths: 'src/changed.ts' },
      { ...DIRTY_INSPECTION, checkedOutCommit: 'main' },
      { ...DIRTY_INSPECTION, uncommittedPaths: [5] },
      inspectionWithHole(),
    ];
    for (const inspect of malformed) {
      const fx = await seededEscalation({ inspect });
      expect(await request(fx)).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });
    }
  });

  it('refuses fix-no-progress with worktree-clean when worktree is clean and head has not moved', async () => {
    const fx = await seededEscalation({ inspect: { ...DIRTY_INSPECTION, uncommittedPaths: [] } });
    expect(await request(fx)).toEqual({ outcome: 'refused', reason: 'worktree-clean' });
    // No intent was recorded for the refused resume.
    expect((await entriesForRun(fx)).some((entry) => entry.kind === 'intent' && entry.key === RESUME_CLI_KEY)).toBe(false);
  });

  it('refuses a second escalation with already-escalated', async () => {
    const fx = await seededEscalation();
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
    const stepKey = keyBuilt.ok ? keyBuilt.key : '';
    expect(await fx.journal.append(laneRunIntentEntry(nextEntryId(), RUN_ID, stepKey, null, NOW))).toMatchObject({
      outcome: 'appended',
    });
    expect(
      await fx.journal.append(laneRunResultEntry(nextEntryId(), RUN_ID, stepKey, 'completed', 'park-escalated', NOW, 'commit-pending')),
    ).toMatchObject({ outcome: 'appended' });

    expect(await request(fx)).toEqual({ outcome: 'refused', reason: 'already-escalated' });
  });

  it('refuses escalation with history-too-long when journal history exceeds PARK_ESCALATION_HISTORY_MAX', async () => {
    const fx = await seededEscalation();
    for (let index = 0; index <= PARK_ESCALATION_HISTORY_MAX; index += 1) {
      expect(await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', NOW))).toMatchObject({
        outcome: 'appended',
      });
    }
    expect(await request(fx)).toEqual({ outcome: 'refused', reason: 'history-too-long' });
  });

  it('never bypasses stop-pending, stale-revision, run-stopped, or one-way-door refusals', async () => {
    // A recorded stop wins before the worktree is even read.
    const stopped = await seededEscalation();
    expect(
      await stopped.journal.append({ ...laneRunIntentEntry(nextEntryId(), RUN_ID, `${RUN_ID}/stop@cli`, null, NOW), mode: 'graceful', expectedRevision: 2 } as LaneRunJournalEntryRecord),
    ).toMatchObject({ outcome: 'appended' });
    expect(await request(stopped)).toEqual({ outcome: 'refused', reason: 'stop-pending' });
    expect(stopped.inspectCalls.count).toBe(0);

    const stale = await seededEscalation();
    expect(await request(stale, { expectedRevision: 3 })).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    expect(stale.inspectCalls.count).toBe(0);

    const runStopped = await seededEscalation();
    expect(await runStopped.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'stopped', NOW))).toMatchObject({
      outcome: 'appended',
    });
    expect(await request(runStopped)).toEqual({ outcome: 'refused', reason: 'run-stopped' });
    expect(runStopped.inspectCalls.count).toBe(0);

    const oneWay = await seededEscalation({
      park: { reason: 'one-way-door', qualifier: null, parkedFrom: 'gating', questionId: 'question-1' },
    });
    expect(await request(oneWay)).toEqual({ outcome: 'refused', reason: 'one-way-door' });
    expect(oneWay.inspectCalls.count).toBe(0);

    // The apply path: a stop recorded after the request still refuses the
    // escalation with stop-pending (never an escalation to fixing).
    const applyStopped = await seededEscalation();
    await seedPendingResume(applyStopped);
    expect(
      await applyStopped.journal.append({ ...laneRunIntentEntry(nextEntryId(), RUN_ID, `${RUN_ID}/stop@cli`, null, NOW), mode: 'graceful', expectedRevision: 2 } as LaneRunJournalEntryRecord),
    ).toMatchObject({ outcome: 'appended' });
    expect(await apply(applyStopped)).toMatchObject({ outcome: 'refused', reason: 'stop-pending' });
    expect((await applyStopped.repo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
  });

  it('returns already-requested on a duplicate escalation resume request', async () => {
    const fx = await seededEscalation();
    expect(await request(fx)).toMatchObject({ outcome: 'resume-recorded', to: 'fixing' });
    expect(await request(fx)).toEqual({ outcome: 'already-requested', runId: RUN_ID, key: RESUME_CLI_KEY });
  });

  it('escalates fix-no-progress with dirty worktree to fixing and journals park-escalated commit-pending', async () => {
    const fx = await seededEscalation();

    const requested = await request(fx);
    expect(requested).toEqual({ outcome: 'resume-recorded', runId: RUN_ID, to: 'fixing', key: RESUME_CLI_KEY });
    // The inspection read the latest attempt's recorded worktree facts.
    expect(fx.inspectCalls.count).toBe(1);
    expect(fx.inspectRequests[0]).toMatchObject({
      worktreePath: WORKTREE_PATH,
      baseCommit: BASE_COMMIT,
      recordedHost: { host: 'lane-host-1', remotePort: 4166 },
    });

    const applied = await apply(fx);
    expect(applied).toEqual({ outcome: 'resumed', to: 'fixing', key: RESUME_CLI_KEY });

    const record = await fx.repo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    expect(record?.revision).toBe(3);

    const entries = await entriesForRun(fx);
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'conduct', runId: RUN_ID, state: 'fixing' }));
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        key: RESUME_CLI_KEY,
        outcome: 'completed',
        reasonCode: 'park-escalated',
        detail: 'commit-pending',
      }),
    );

    // The escalation is once per run: after a re-park with the same reason,
    // the history marker refuses the second escalation.
    const again = await seededEscalation();
    await seedPendingResume(again);
    expect(await apply(again)).toEqual({ outcome: 'resumed', to: 'fixing', key: RESUME_CLI_KEY });
    const reparked = await again.repo.get(RUN_ID);
    if (reparked === null) {
      throw new Error('fixture: the resumed run record disappeared');
    }
    expect(
      await again.repo.save(
        { ...reparked, parked: FIX_PARK, parkCount: 2, revision: reparked.revision + 1 } as LaneRunRecord,
        { holderId: HOLDER, fence: 1, nowIso: LATER },
      ),
    ).toMatchObject({ outcome: 'saved' });
    expect(await again.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', LATER))).toMatchObject({
      outcome: 'appended',
    });
    const secondKey = `${RUN_ID}/park/2/resume@cli`;
    expect(
      await again.journal.append({ ...laneRunIntentEntry(nextEntryId(), RUN_ID, secondKey, null, LATER), expectedRevision: 4 } as LaneRunJournalEntryRecord),
    ).toMatchObject({ outcome: 'appended' });
    expect(await apply(again)).toMatchObject({ outcome: 'refused', reason: 'already-escalated' });
    expect((await again.repo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
  });
});
