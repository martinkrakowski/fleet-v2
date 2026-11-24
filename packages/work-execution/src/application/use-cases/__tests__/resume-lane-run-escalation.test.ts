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
import { prepareLaneRunJournalAppend } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import { canEnterLaneRunState, checkParkEscalation } from '../../../domain/lane-run-transitions.js';
import { PARK_ESCALATION_HISTORY_MAX, decideParkEscalation } from '../../../domain/park-escalation.js';
import type { ForgeReadPort } from '../../ports/out/ForgeReadPort.out-port.js';
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
  parkedFrom: 'collecting',
  questionId: null,
};

const OPEN_PR_PARK: LaneRunParkRecord = {
  reason: 'ambiguous',
  qualifier: 'open-pr',
  parkedFrom: 'opening-pr',
  questionId: null,
};

const DIRTY = { trackedFilesChanged: 1 } as const;

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
  /** Stored round. Round 2 needs one attempt id per round plus the current one. */
  round?: number;
  /** `findAttemptById` throws. */
  attemptThrows?: boolean;
  /** Wire a forge read whose `readPullRequest` throws. Default: forge read unwired. */
  forgeThrows?: boolean;
}

async function seededEscalation(options: SeedOptions = {}): Promise<EscalationFixture> {
  const repo = new LaneRunRepositoryAdapter();
  const journal = new LaneRunJournalAdapter();
  const round = options.round ?? 0;
  const attemptIds = [ATTEMPT_ID];
  while (attemptIds.length < round + 1) {
    attemptIds.push(`attempt-example-${attemptIds.length + 1}`);
  }
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
        round,
        attemptIds,
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
  for (const attemptId of attemptIds) {
    if (!attempts.has(attemptId)) {
      attempts.set(attemptId, attempt === null ? null : makeAttempt({ id: attemptId }));
    }
  }
  const attemptRepo = options.wireAttempts === false
    ? undefined
    : {
        findAttemptById: async (attemptId: string): Promise<AttemptRecord | null> => {
          attemptReads.count += 1;
          if (options.attemptThrows === true) {
            throw new Error('attempt unreadable');
          }
          return attempts.get(attemptId) ?? null;
        },
      };
  const forgeRead: ForgeReadPort | undefined = options.forgeThrows === true
    ? {
        readPullRequest: async () => {
          throw new Error('forge unreadable');
        },
        listOpenPullRequestsByBase: async () => {
          throw new Error('forge unreadable');
        },
        isConfigured: () => true,
      }
    : undefined;

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
    ...(forgeRead === undefined ? {} : { forgeRead }),
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

/** Re-park after an escalation so a second attempt can see the marker in history. */
async function reparkAfterEscalation(fx: EscalationFixture): Promise<number> {
  const current = await fx.repo.get(RUN_ID);
  if (current === null) {
    throw new Error('fixture: the run record disappeared');
  }
  const nextRevision = current.revision + 1;
  expect(
    await fx.repo.save(
      { ...current, parked: FIX_PARK, parkCount: current.parkCount + 1, revision: nextRevision },
      { holderId: HOLDER, fence: 1, nowIso: LATER },
    ),
  ).toMatchObject({ outcome: 'saved' });
  expect(await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', LATER))).toMatchObject({
    outcome: 'appended',
  });
  return nextRevision;
}

async function seedOpenPrResume(fx: EscalationFixture): Promise<void> {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'open-pr',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: '0123456789ab',
    retry: null,
  });
  if (!built.ok) {
    throw new Error('fixture: open-pr key');
  }
  expect(await fx.journal.append(laneRunIntentEntry(nextEntryId(), RUN_ID, built.key, null, NOW))).toMatchObject({
    outcome: 'appended',
  });
  await seedPendingResume(fx);
}

function escalationRecord(overrides: { readonly round?: unknown; readonly parked?: unknown; readonly revision?: unknown } = {}): {
  readonly revision: unknown;
  readonly round: unknown;
  readonly parked: unknown;
} {
  return {
    revision: overrides.revision ?? 2,
    round: overrides.round ?? 0,
    parked: overrides.parked === undefined ? FIX_PARK : overrides.parked,
  };
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

  it('refuses fix-no-progress without running a getter when the stored attempt exposes one', async () => {
    const getterCalls = { count: 0 };
    const hostile = (field: 'artifacts' | 'worktreePath' | 'baseCommit'): AttemptRecord => {
      const record = makeAttempt() as unknown as Record<string, unknown>;
      const value = record[field];
      Reflect.deleteProperty(record, field);
      Object.defineProperty(record, field, {
        enumerable: true,
        get: () => {
          getterCalls.count += 1;
          return value;
        },
      });
      return record as unknown as AttemptRecord;
    };
    for (const field of ['artifacts', 'worktreePath', 'baseCommit'] as const) {
      const fx = await seededEscalation({ attempt: hostile(field) });
      expect(await request(fx), field).toEqual({ outcome: 'refused', reason: 'fix-no-progress' });
      expect(fx.inspectCalls.count, field).toBe(0);
    }
    expect(getterCalls.count).toBe(0);
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

  it('records park-escalated commit-pending when an escalation crashed after its conduct entry and before its save', async () => {
    const fx = await seededEscalation();
    expect(await request(fx)).toMatchObject({ outcome: 'resume-recorded', to: 'fixing' });
    // Crash simulation: the marked conduct landed, the unparked record never saved.
    expect(
      await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', LATER, 'commit-pending')),
    ).toMatchObject({ outcome: 'appended' });
    expect(await apply(fx)).toEqual({ outcome: 'resumed', to: 'fixing', key: RESUME_CLI_KEY });
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();
    const result = (await entriesForRun(fx)).find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(result).toMatchObject({ outcome: 'reconciled', reasonCode: 'park-escalated', detail: 'commit-pending' });
  });

  it('refuses a request whose Proxy traps throw with invalid-request instead of throwing', async () => {
    const fx = await seededEscalation();
    const hostile = new Proxy({ runId: RUN_ID, via: 'cli' }, { getPrototypeOf: () => { throw new Error('hostile trap'); } });
    expect(await fx.resume.requestResume(hostile as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
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
      // A Proxy whose traps throw must refuse, never throw out of requestResume.
      new Proxy({ ...DIRTY_INSPECTION }, { ownKeys: () => { throw new Error('hostile ownKeys trap'); } }),
      new Proxy({ ...DIRTY_INSPECTION }, { getPrototypeOf: () => { throw new Error('hostile prototype trap'); } }),
      { ...DIRTY_INSPECTION, uncommittedPaths: new Proxy(['src/changed.ts'], { ownKeys: () => { throw new Error('hostile ownKeys trap'); } }) },
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

  it('refuses fix-no-progress with head-advanced when the worktree is clean but the HEAD moved past the recorded head commit', async () => {
    // CE2: a clean worktree whose checked-out HEAD differs from the attempt's
    // collected headCommit is `head-advanced`, not `worktree-clean`.
    const moved = 'c'.repeat(40);
    const fx = await seededEscalation({
      inspect: { ...DIRTY_INSPECTION, uncommittedPaths: [], checkedOutCommit: moved },
    });
    expect(await request(fx)).toEqual({ outcome: 'refused', reason: 'head-advanced' });
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
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'conduct', runId: RUN_ID, state: 'fixing', mode: 'commit-pending' }),
    );
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

  it('finishes unparking to fixing when the marked conduct landed before the save', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    expect(
      await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', LATER, 'commit-pending')),
    ).toMatchObject({ outcome: 'appended' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
    expect(await apply(fx)).toEqual({ outcome: 'resumed', to: 'fixing', key: RESUME_CLI_KEY });
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();
    const result = (await entriesForRun(fx)).find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(result).toMatchObject({ outcome: 'reconciled', reasonCode: 'park-escalated', detail: 'commit-pending' });
  });

  it('settles the resume intent when the unpark save landed before the result', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    expect(
      await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', LATER, 'commit-pending')),
    ).toMatchObject({ outcome: 'appended' });
    const parked = await fx.repo.get(RUN_ID);
    if (parked === null) {
      throw new Error('fixture: the run record disappeared');
    }
    expect(
      await fx.repo.save(
        { ...parked, parked: null, revision: parked.revision + 1 },
        { holderId: HOLDER, fence: 1, nowIso: LATER },
      ),
    ).toMatchObject({ outcome: 'saved' });
    expect(await apply(fx)).toEqual({ outcome: 'none' });
    const settled = (await entriesForRun(fx)).find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(settled).toMatchObject({ outcome: 'reconciled', reasonCode: 'resumed' });
    const revision = await reparkAfterEscalation(fx);
    expect(await request(fx, { expectedRevision: revision })).toEqual({ outcome: 'refused', reason: 'already-escalated' });
  });

  it('refuses second escalation with already-escalated after crash replay', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    expect(
      await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', LATER, 'commit-pending')),
    ).toMatchObject({ outcome: 'appended' });
    expect(await apply(fx)).toEqual({ outcome: 'resumed', to: 'fixing', key: RESUME_CLI_KEY });
    const revision = await reparkAfterEscalation(fx);
    expect(await request(fx, { expectedRevision: revision })).toEqual({ outcome: 'refused', reason: 'already-escalated' });
    expect((await fx.repo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    const fixing = (await entriesForRun(fx)).filter((entry) => entry.kind === 'conduct' && entry.state === 'fixing');
    expect(fixing).toEqual([expect.objectContaining({ mode: 'commit-pending' })]);
  });

  it('refuses fixing state without escalation marker', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    expect(await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', LATER))).toMatchObject({
      outcome: 'appended',
    });
    expect(await apply(fx)).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
    const entries = await entriesForRun(fx);
    expect(entries.some((entry) => entry.mode === 'commit-pending')).toBe(false);
    expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'fixing' && entry.mode !== null)).toBe(false);
  });

  it('refuses fix-no-progress escalation at round 2', async () => {
    const fx = await seededEscalation({ round: 2 });
    expect(await request(fx)).toEqual({ outcome: 'refused', reason: 'round-limit-reached' });
    expect((await entriesForRun(fx)).some((entry) => entry.kind === 'intent' && entry.key === RESUME_CLI_KEY)).toBe(false);
    expect((await entriesForRun(fx)).some((entry) => entry.mode === 'commit-pending' || (entry.kind === 'conduct' && entry.state === 'fixing'))).toBe(false);

    await seedPendingResume(fx);
    expect(await apply(fx)).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'round-limit-reached' });
    const after = await entriesForRun(fx);
    expect(after.some((entry) => entry.kind === 'conduct' && entry.state === 'fixing')).toBe(false);
    expect(after.some((entry) => entry.mode === 'commit-pending')).toBe(false);
    expect(after.some((entry) => entry.kind === 'result' && entry.reasonCode === 'park-escalated')).toBe(false);
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
    expect(checkParkEscalation({
      record: escalationRecord({ round: 2 }) as LaneRunRecord,
      state: 'parked',
      stopMode: null,
      expectedRevision: 2,
      history: [{ kind: 'conduct', state: 'parked' }],
      dirtyWorktree: DIRTY,
    })).toEqual({ ok: false, reason: 'round-limit-reached' });
  });

  it('refuses with journal-refused when conduct or marker append fails', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    const original = fx.journal.append.bind(fx.journal);
    fx.journal.append = async (entry) => {
      if (entry.kind === 'conduct' && entry.state === 'fixing') {
        return { outcome: 'refused', reason: 'invalid-entry', detail: 'marker refused' };
      }
      return original(entry);
    };
    expect(await apply(fx)).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'journal-refused' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
    expect((await entriesForRun(fx)).some((entry) => entry.mode === 'commit-pending')).toBe(false);
  });

  it('refuses with save-refused when unpark save fails', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    const original = fx.repo.save.bind(fx.repo);
    fx.repo.save = async (record, guard) => {
      if (record.parked === null) {
        return { outcome: 'refused', reason: 'lease-changed' };
      }
      return original(record, guard);
    };
    expect(await apply(fx)).toEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'save-refused' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
    expect(await entriesForRun(fx)).toContainEqual(
      expect.objectContaining({ kind: 'conduct', state: 'fixing', mode: 'commit-pending' }),
    );
  });

  it('returns none when no pending resume intent exists', async () => {
    const fx = await seededEscalation();
    expect(await apply(fx)).toEqual({ outcome: 'none' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
  });

  it('returns run-not-found when run record is missing', async () => {
    const fx = await seededEscalation();
    const missing = 'run-01JB0000000000000000000001';
    expect(await fx.resume.requestResume({
      runId: missing,
      via: 'cli',
      entryId: nextEntryId(),
      nowIso: LATER,
      expectedRevision: 2,
    })).toEqual({ outcome: 'not-found', runId: missing });
    expect(await fx.resume.applyPendingResume({
      runId: missing,
      lease: { holderId: HOLDER, fence: 1 },
      nowIso: LATER,
    })).toEqual({ outcome: 'refused', key: null, reason: 'run-not-found' });
  });

  it('fails closed when attempt or forge read is unreadable', async () => {
    const attemptThrows = await seededEscalation({ park: OPEN_PR_PARK, attemptThrows: true });
    await seedOpenPrResume(attemptThrows);
    expect(await apply(attemptThrows)).toMatchObject({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'forge-ambiguous' });
    expect((await attemptThrows.repo.get(RUN_ID))?.parked).toEqual(OPEN_PR_PARK);

    const forgeThrows = await seededEscalation({ park: OPEN_PR_PARK, forgeThrows: true });
    await seedOpenPrResume(forgeThrows);
    expect(await apply(forgeThrows)).toMatchObject({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'forge-ambiguous' });
    const result = (await entriesForRun(forgeThrows)).find((entry) => entry.kind === 'result' && entry.key === RESUME_CLI_KEY);
    expect(result).toMatchObject({ outcome: 'ambiguous', reasonCode: 'forge-ambiguous' });
  });

  it('fails closed when optional forgeRead or attemptRepo is absent', async () => {
    const withoutForge = await seededEscalation({ park: OPEN_PR_PARK });
    await seedOpenPrResume(withoutForge);
    expect(await apply(withoutForge)).toMatchObject({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'forge-ambiguous' });

    const withoutAttempts = await seededEscalation({ park: OPEN_PR_PARK, wireAttempts: false });
    await seedOpenPrResume(withoutAttempts);
    expect(await apply(withoutAttempts)).toMatchObject({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'forge-ambiguous' });
    expect((await withoutAttempts.repo.get(RUN_ID))?.parked).toEqual(OPEN_PR_PARK);
  });

  it('refuses malformed resume request with invalid-request', async () => {
    const fx = await seededEscalation();
    expect(await fx.resume.requestResume(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await fx.resume.requestResume({ runId: RUN_ID, via: 'cli' } as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await fx.resume.applyPendingResume(undefined as never)).toEqual({
      outcome: 'refused',
      key: null,
      reason: 'invalid-request',
    });
    expect(await fx.resume.applyPendingResume({ runId: RUN_ID, lease: null, nowIso: LATER } as never)).toEqual({
      outcome: 'refused',
      key: null,
      reason: 'invalid-request',
    });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
  });

  it('refuses malformed record or parked payload without throwing', () => {
    const history = [{ kind: 'conduct', state: 'parked' }];
    const base = {
      state: 'parked' as const,
      stopMode: null,
      expectedRevision: 2,
      history,
      dirtyWorktree: DIRTY,
    };
    expect(checkParkEscalation({ ...base, record: escalationRecord({ round: '2' }) as LaneRunRecord })).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(checkParkEscalation({ ...base, record: escalationRecord({ round: -1 }) as LaneRunRecord })).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(checkParkEscalation({ ...base, record: escalationRecord({ round: 1.5 }) as LaneRunRecord })).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(checkParkEscalation({
      ...base,
      record: escalationRecord({ parked: { reason: 'fix-no-progress' } }) as LaneRunRecord,
    })).toEqual({ ok: false, reason: 'malformed-parked-record' });
    expect(decideParkEscalation({ ...FIX_PARK, reason: 'not-a-reason' }, history, DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-parked-record',
    });
    expect(decideParkEscalation({ ...FIX_PARK, reason: 'halted' }, history, DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'park-reason-not-escalatable',
    });
    expect(checkParkEscalation({ ...base, state: 'sideways', record: escalationRecord() as LaneRunRecord } as never)).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(canEnterLaneRunState('sideways', 'fixing')).toBe(false);
    expect(canEnterLaneRunState('parked', 'sideways', 'collecting', false, undefined, true)).toBe(false);
  });

  it('refuses malformed journal entry and malformed history', () => {
    const marker = { ...laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW), mode: 'commit-pending' as const };
    expect(prepareLaneRunJournalAppend([], marker)).toMatchObject({ ok: true, entry: { mode: 'commit-pending', state: 'fixing' } });
    expect(prepareLaneRunJournalAppend([], { ...laneRunConductEntry(nextEntryId(), RUN_ID, 'collecting', NOW), mode: 'commit-pending' })).toMatchObject({
      ok: false,
      reason: 'invalid-entry',
    });
    expect(prepareLaneRunJournalAppend([], { ...laneRunIntentEntry(nextEntryId(), RUN_ID, RESUME_CLI_KEY, null, NOW), mode: 'commit-pending', expectedRevision: 2 })).toMatchObject({
      ok: false,
      reason: 'invalid-entry',
    });
    expect(prepareLaneRunJournalAppend([], { ...laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW), mode: 'graceful' })).toMatchObject({
      ok: false,
      reason: 'invalid-entry',
    });
    expect(decideParkEscalation(FIX_PARK, [{}], DIRTY)).toEqual({ kind: 'stay-parked', reason: 'malformed-history' });
    const holed = [{ kind: 'conduct', state: 'parked' }, { kind: 'result', reasonCode: 'gate-failed' }];
    delete holed[0];
    expect(decideParkEscalation(FIX_PARK, holed, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'malformed-history' });
    const polluted = { kind: 'conduct', state: 'parked' };
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: { mode: 'commit-pending' } });
    expect(decideParkEscalation(FIX_PARK, [polluted], DIRTY)).toEqual({ kind: 'stay-parked', reason: 'malformed-history' });
  });

  it('refuses non-array history and non-array findings', () => {
    expect(decideParkEscalation(FIX_PARK, { length: 9, 0: { kind: 'conduct' } }, DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-history',
    });
    expect(decideParkEscalation(FIX_PARK, 'not-an-array', DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-history',
    });
    expect(decideParkEscalation({ ...FIX_PARK, findings: 'not-an-array' }, [], DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-parked-record',
    });
    expect(decideParkEscalation({ ...FIX_PARK, findings: { length: 1, 0: {} } }, [], DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-parked-record',
    });
  });

  it('refuses null or undefined dirtyWorktree fact', () => {
    expect(decideParkEscalation(FIX_PARK, [], null)).toEqual({ kind: 'stay-parked', reason: 'missing-dirty-worktree-fact' });
    expect(decideParkEscalation(FIX_PARK, [], undefined)).toEqual({ kind: 'stay-parked', reason: 'missing-dirty-worktree-fact' });
    expect(decideParkEscalation(FIX_PARK, [])).toEqual({ kind: 'stay-parked', reason: 'missing-dirty-worktree-fact' });
  });

  it('refuses null parked record as not-parked', () => {
    expect(checkParkEscalation({
      record: escalationRecord({ parked: null }) as LaneRunRecord,
      state: 'parked',
      stopMode: null,
      expectedRevision: 2,
      history: [],
      dirtyWorktree: DIRTY,
    })).toEqual({ ok: false, reason: 'not-parked' });
  });

  it('refuses throwing getter on request, record, and history elements', async () => {
    const fx = await seededEscalation();
    const getterCalls: string[] = [];
    const requestRecord: Record<string, unknown> = {
      runId: RUN_ID,
      via: 'cli',
      entryId: nextEntryId(),
      nowIso: LATER,
    };
    Object.defineProperty(requestRecord, 'expectedRevision', {
      enumerable: true,
      get() {
        getterCalls.push('request');
        throw new Error('request getter');
      },
    });
    expect(await fx.resume.requestResume(requestRecord as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    const recordCalls: string[] = [];
    const hostileRecord: Record<string, unknown> = { revision: 2, round: 0 };
    Object.defineProperty(hostileRecord, 'parked', {
      enumerable: true,
      get() {
        recordCalls.push('parked');
        throw new Error('parked getter');
      },
    });
    expect(checkParkEscalation({
      record: hostileRecord as never,
      state: 'parked',
      stopMode: null,
      expectedRevision: 2,
      history: [{ kind: 'conduct', state: 'parked' }],
      dirtyWorktree: DIRTY,
    })).toEqual({ ok: false, reason: 'malformed-input' });

    const roundRecord: Record<string, unknown> = { revision: 2, parked: FIX_PARK };
    Object.defineProperty(roundRecord, 'round', {
      enumerable: true,
      get() {
        recordCalls.push('round');
        throw new Error('round getter');
      },
    });
    expect(checkParkEscalation({
      record: roundRecord as never,
      state: 'parked',
      stopMode: null,
      expectedRevision: 2,
      history: [{ kind: 'conduct', state: 'parked' }],
      dirtyWorktree: DIRTY,
    })).toEqual({ ok: false, reason: 'malformed-input' });

    const historyCalls: string[] = [];
    const history: unknown[] = [{ kind: 'conduct', state: 'parked' }];
    Object.defineProperty(history, 0, {
      enumerable: true,
      get() {
        historyCalls.push('history');
        throw new Error('history getter');
      },
    });
    expect(decideParkEscalation(FIX_PARK, history, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'malformed-history' });
    expect(decideParkEscalation(
      new Proxy({ ...FIX_PARK }, { ownKeys() { throw new Error('ownKeys'); } }),
      [{ kind: 'conduct', state: 'parked' }],
      DIRTY,
    )).toEqual({ kind: 'stay-parked', reason: 'malformed-parked-record' });

    const findingCalls: string[] = [];
    const findings: unknown[] = [{}];
    Object.defineProperty(findings, 0, {
      enumerable: true,
      get() {
        findingCalls.push('finding');
        throw new Error('finding getter');
      },
    });
    expect(decideParkEscalation({ ...FIX_PARK, findings }, [{ kind: 'conduct', state: 'parked' }], DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-parked-record',
    });

    const dirtyCalls: string[] = [];
    const dirty: Record<string, unknown> = {};
    Object.defineProperty(dirty, 'trackedFilesChanged', {
      enumerable: true,
      get() {
        dirtyCalls.push('dirty');
        throw new Error('dirty getter');
      },
    });
    expect(decideParkEscalation(FIX_PARK, [{ kind: 'conduct', state: 'parked' }], dirty)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-dirty-worktree-fact',
    });

    expect(getterCalls).toEqual([]);
    expect(recordCalls).toEqual([]);
    expect(historyCalls).toEqual([]);
    expect(findingCalls).toEqual([]);
    expect(dirtyCalls).toEqual([]);
  });

  it('refuses with stop-pending when stop is recorded before replay', async () => {
    const fx = await seededEscalation();
    await seedPendingResume(fx);
    expect(
      await fx.journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', LATER, 'commit-pending')),
    ).toMatchObject({ outcome: 'appended' });
    expect(
      await fx.journal.append({
        ...laneRunIntentEntry(nextEntryId(), RUN_ID, `${RUN_ID}/stop@cli`, null, LATER),
        mode: 'graceful',
        expectedRevision: 2,
      } as LaneRunJournalEntryRecord),
    ).toMatchObject({ outcome: 'appended' });
    expect(await apply(fx)).toMatchObject({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'stop-pending' });
    expect((await fx.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
  });

  it('refuses with stale-revision on revision mismatch', async () => {
    const requested = await seededEscalation();
    expect(await request(requested, { expectedRevision: 9 })).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    expect(requested.inspectCalls.count).toBe(0);

    const applied = await seededEscalation();
    expect(
      await applied.journal.append({
        ...laneRunIntentEntry(nextEntryId(), RUN_ID, RESUME_CLI_KEY, null, NOW),
        expectedRevision: 9,
      } as LaneRunJournalEntryRecord),
    ).toMatchObject({ outcome: 'appended' });
    expect(await apply(applied)).toMatchObject({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'stale-revision' });
    expect((await applied.repo.get(RUN_ID))?.parked).toEqual(FIX_PARK);
    expect((await entriesForRun(applied)).some((entry) => entry.mode === 'commit-pending')).toBe(false);
  });

  it('refuses escalation when history exceeds 256 entries', () => {
    const history = Array.from({ length: PARK_ESCALATION_HISTORY_MAX + 1 }, () => ({ kind: 'conduct', state: 'parked' }));
    expect(history).toHaveLength(257);
    expect(decideParkEscalation(FIX_PARK, history, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'history-too-long' });
    const enormous = [] as unknown[];
    enormous.length = 1_000_000;
    expect(decideParkEscalation(FIX_PARK, enormous, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'history-too-long' });
  });

  it('refuses escalation when worktree is clean', () => {
    expect(decideParkEscalation(FIX_PARK, [{ kind: 'conduct', state: 'parked' }], { trackedFilesChanged: 0 })).toEqual({
      kind: 'stay-parked',
      reason: 'worktree-clean',
    });
  });
});
