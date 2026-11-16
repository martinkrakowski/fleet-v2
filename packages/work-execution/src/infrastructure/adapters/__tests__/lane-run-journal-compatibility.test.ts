import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nextLaneRunAction } from '../../../domain/lane-run-decider.js';
import type { LaneRunAttemptFact, LaneRunDecision, LaneRunFacts } from '../../../domain/lane-run-decider.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  laneRunJournalDispatchResult,
  laneRunJournalPendingIntent,
  laneRunJournalState,
  laneRunJournalStopFacts,
  readLaneRunJournalEntry,
  readLaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import {
  LANE_RUN_MAX_RETRY,
  buildLaneRunStepKey,
  buildMergeKey,
  laneRunMergeEnqueueKey,
  laneRunPremergeKey,
  laneRunResumeKey,
  laneRunStopForceKey,
  laneRunStopKey,
  parseLaneRunKey,
  requestKey,
  reaperRepairKey,
} from '../../../domain/lane-run-keys.js';
import type { LaneRunKeyResult } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunAttemptPlacement, laneRunGateFact, laneRunPremergePost } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import {
  LANE_RUN_JOURNAL_STORE_VERSION_POLICY,
  LaneRunJournalAdapter,
  parseVersionedLaneRunJournalStateRecord,
} from '../LaneRunJournalAdapter.adapter.js';
import {
  ReadOnlyStateStoreError,
  StateFileUnknownVersionError,
  StateFileUnreadableReadOnlyError,
} from '../file-store.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const OTHER_RUN_ID = 'run-01JB0000000000000000000001';
const HEAD12 = '0123456789ab';
const ULID = '01JB0000000000000000000000';
const NOW = '2026-11-05T10:00:00.000Z';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function mustBuild(result: LaneRunKeyResult): string {
  if (!result.ok) {
    throw new Error('unreachable: key builder');
  }
  return result.key;
}

/** A raw on-disk entry: exactly the required entry keys plus the optional ones a fixture names. */
type RawEntry = Omit<LaneRunJournalEntryRecord, 'schemaVersion'> & { readonly schemaVersion?: number };

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function intent(key: string, extra: Partial<RawEntry> = {}): RawEntry {
  const parsed = parseLaneRunKey(key);
  const runId =
    parsed !== null &&
    (parsed.kind === 'step' || parsed.kind === 'stop' || parsed.kind === 'resume' ||
      parsed.kind === 'premerge' || parsed.kind === 'merge-enqueue')
      ? parsed.runId
      : RUN_ID;
  const mode = parsed !== null && parsed.kind === 'stop' ? parsed.mode : null;
  const expectedRevision = parsed !== null && (parsed.kind === 'stop' || parsed.kind === 'resume') ? 1 : null;
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: nextEntryId(),
    kind: 'intent',
    key,
    runId,
    recordedAtIso: NOW,
    mode,
    expectedRevision,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
    schemaVersion: 1,
    ...extra,
  };
}

function result(key: string, outcome: LaneRunJournalOutcome, extra: Partial<RawEntry> = {}): RawEntry {
  const parsed = parseLaneRunKey(key);
  const runId =
    parsed !== null &&
    (parsed.kind === 'step' || parsed.kind === 'stop' || parsed.kind === 'resume' ||
      parsed.kind === 'premerge' || parsed.kind === 'merge-enqueue')
      ? parsed.runId
      : RUN_ID;
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: nextEntryId(),
    kind: 'result',
    key,
    runId,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
    schemaVersion: 1,
    ...extra,
  };
}

function conduct(state: LaneRunStateValue): RawEntry {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: nextEntryId(),
    kind: 'conduct',
    key: null,
    runId: RUN_ID,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state,
    schemaVersion: 1,
  };
}

/**
 * Every released run-journal key format, one fixture group per format era.
 * The strings are the released formats; builders are used only where they
 * already produce exactly the released shape (documented by the shape test).
 */
interface ReleasedKeyFixture {
  readonly label: string;
  readonly keys: readonly string[];
}

const COLLECT_LEGACY = `${RUN_ID}/r0/collect/0`;
const COLLECT_LEGACY_RETRY = `${RUN_ID}/r0/collect/0/retry1`;
const MERGE_STEP_KEY = `${RUN_ID}/r0/merge/0@${HEAD12}`;
const MERGE_PR_RETRY_KEY = mustBuild(buildMergeKey({
  repoDigest: HEAD12, pullRequest: 42, head12: HEAD12, action: 'merge-pr', attemptOrdinal: null, retry: 1,
  retryProof: { postconditionAbsent: true, priorOutcome: 'not-started' },
}));

const RELEASED_KEY_FORMAT_FIXTURES: readonly ReleasedKeyFixture[] = [
  {
    label: 'collect-legacy-ordinalless',
    keys: [COLLECT_LEGACY, COLLECT_LEGACY_RETRY],
  },
  {
    label: 'collect-current-attempt-ordinal',
    keys: [`${RUN_ID}/r0/collect/0/a1`, `${RUN_ID}/r0/collect/0/a1/retry1`],
  },
  {
    label: 'step-pre-ks7b-merge',
    keys: [MERGE_STEP_KEY],
  },
  {
    label: 'step-standard',
    keys: [
      `${RUN_ID}/r0/prepare/0/a1`,
      `${RUN_ID}/r0/dispatch/0/a1`,
      `${RUN_ID}/r0/gate/0@${HEAD12}`,
      `${RUN_ID}/r0/brief-check/0@${HEAD12}`,
      `${RUN_ID}/r0/code-review/0@${HEAD12}`,
      `${RUN_ID}/r0/pre-merge/0@${HEAD12}`,
      `${RUN_ID}/r0/accept/0@${HEAD12}`,
      `${RUN_ID}/r0/open-pr/0@${HEAD12}`,
      `${RUN_ID}/r0/push/0@${HEAD12}`,
      `${RUN_ID}/r0/ci/0@${HEAD12}`,
      `${RUN_ID}/r0/park/0`,
      `${RUN_ID}/r0/reconcile/0`,
    ],
  },
  {
    label: 'premerge-and-merge-enqueue',
    keys: [
      mustBuild(laneRunPremergeKey(RUN_ID, 0, HEAD12)),
      mustBuild(laneRunMergeEnqueueKey(RUN_ID, 0, HEAD12)),
    ],
  },
  {
    label: 'control-stop-and-resume',
    keys: [
      mustBuild(laneRunStopKey(RUN_ID, 'web')),
      mustBuild(laneRunStopForceKey(RUN_ID, 'cli')),
      mustBuild(laneRunResumeKey(RUN_ID, 1, 'cli')),
    ],
  },
  {
    label: 'channel-request-and-reaper',
    keys: [
      mustBuild(requestKey(ULID)),
      mustBuild(reaperRepairKey('attempt-1', 'dead-attempt', ULID)),
    ],
  },
  {
    label: 'merge-queue-keys',
    keys: [
      mustBuild(buildMergeKey({ repoDigest: HEAD12, pullRequest: 42, head12: HEAD12, action: 'merge-pr', attemptOrdinal: null, retry: null })),
      MERGE_PR_RETRY_KEY,
      mustBuild(buildMergeKey({ repoDigest: HEAD12, pullRequest: 42, head12: HEAD12, action: 'macos-verify', attemptOrdinal: 1, retry: null })),
    ],
  },
];

const LEGACY_ENTRY_SHAPES: readonly { readonly label: string; readonly entry: RawEntry }[] = [
  { label: 'pre-KF-14a entry without detail', entry: omitDetail(intent(COLLECT_LEGACY)) },
  { label: 'pre-Q5a entry without schemaVersion', entry: omitSchemaVersion(intent(COLLECT_LEGACY)) },
];

function omitDetail(entry: RawEntry): RawEntry {
  const copy: Record<string, unknown> = { ...entry };
  delete copy.detail;
  return copy as RawEntry;
}

function omitSchemaVersion(entry: RawEntry): RawEntry {
  const copy: Record<string, unknown> = { ...entry };
  delete copy.schemaVersion;
  return copy as RawEntry;
}

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-run-journal-compat-'));
  dirs.push(dir);
  return dir;
}

async function writeJournal(dir: string, rawEntries: readonly RawEntry[]): Promise<string> {
  const target = path.join(dir, 'run-journal.json');
  await writeFile(target, JSON.stringify(rawEntries), 'utf8');
  return target;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// The decider's fixture helpers (mirrored from lane-run-decider.test.ts), so
// replayed journals can be projected into facts and advanced.
// ---------------------------------------------------------------------------

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

function record(): LaneRunRecord {
  const created = LaneRun.create({ ...BASE_RECORD });
  expect(created.success).toBe(true);
  if (!created.success) {
    throw new Error('unreachable: fixture must be a valid LaneRun record');
  }
  return created.value.toRecord();
}

function attemptFact(overrides: Partial<LaneRunAttemptFact> = {}): LaneRunAttemptFact {
  return {
    attemptId: 'attempt-example-1',
    round: 0,
    seatIndex: 0,
    phase: 'running',
    stopReason: 'none',
    deadlineIso: null,
    stopsIssued: 0,
    dispatchResult: 'started',
    collection: null,
    ...overrides,
  };
}

function baseFacts(overrides: Partial<LaneRunFacts> = {}): LaneRunFacts {
  return {
    state: 'ready',
    halted: false,
    stopMode: null,
    stopRequestedAtIso: null,
    stopGraceMinutes: 45,
    pendingIntent: null,
    admission: 'admitted',
    costCeilingReached: false,
    implementerSeat: { ok: true, seatIndex: 0 },
    reviewSeat: { ok: true, seatIndex: 0 },
    roundSeatIndexes: [],
    attempt: null,
    head12: null,
    acceptedHead12: null,
    gate: 'none',
    gateCongestion: null,
    gateUnknown: null,
    briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
    codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
    preMerge: 'none',
    premergePost: 'none',
    mergeEnqueue: 'none',
    acceptance: 'none',
    acceptanceRetry: null,
    ci: 'pending',
    pr: null,
    refusedStep: null,
    merge: { oneWayDoor: false, policyGrant: true },
    ...overrides,
  };
}

const SEALED_COLLECTION = { commits: 2, manifest: 'sealed' as const, headUnchanged: false };

// ---------------------------------------------------------------------------

describe('released run-journal key-format fixtures', () => {
  it('replays every released key-format fixture from run-journal.json on disk', async () => {
    for (const fixture of RELEASED_KEY_FORMAT_FIXTURES) {
      const dir = await stateDir();
      const rawEntries = fixture.keys.map((key) => intent(key));
      const target = await writeJournal(dir, rawEntries);
      const adapter = new LaneRunJournalAdapter({ stateDir: dir, readOnly: true });

      const listed = await adapter.listForRun(RUN_ID);
      expect(listed.map((entry) => entry.key)).toEqual(rawEntries.map((entry) => entry.key));
      for (const entry of listed) {
        expect(entry.schemaVersion).toBe(LANE_RUN_JOURNAL_STORE_VERSION_POLICY.writerVersion);
        expect(parseLaneRunKey(entry.key)).not.toBeNull();
      }
      expect(await adapter.listForKey(rawEntries[0].key ?? '')).toHaveLength(1);
      const grouped = await adapter.listForRuns([RUN_ID]);
      expect(grouped.get(RUN_ID)?.length).toBe(rawEntries.length);

      for (const raw of rawEntries) {
        expect(parseVersionedLaneRunJournalStateRecord(raw)).toEqual({
          status: 'ok',
          record: expect.objectContaining({ key: raw.key }),
          schemaVersion: 1,
        });
        expect(readLaneRunJournalEntry(raw)).toEqual({ ok: true, entry: expect.objectContaining({ key: raw.key }) });
        expect(readLaneRunJournalEntryRecord(raw).ok).toBe(true);
      }
      expect(target).toBe(path.join(dir, 'run-journal.json'));
    }
  });

  it('covers the released key shapes literally', () => {
    expect(COLLECT_LEGACY).toBe(`${RUN_ID}/r0/collect/0`);
    expect(COLLECT_LEGACY_RETRY).toBe(`${RUN_ID}/r0/collect/0/retry1`);
    expect(parseLaneRunKey(`${RUN_ID}/r0/collect/0/a1`)).toMatchObject({ kind: 'step', step: 'collect', attemptOrdinal: 1 });
    expect(parseLaneRunKey(`${RUN_ID}/r0/collect/0/a1/retry1`)).toMatchObject({ kind: 'step', step: 'collect', attemptOrdinal: 1, retry: 1 });
    expect(MERGE_STEP_KEY).toBe(`${RUN_ID}/r0/merge/0@${HEAD12}`);
    expect(mustBuild(laneRunPremergeKey(RUN_ID, 0, HEAD12))).toBe(`${RUN_ID}/r0/premerge@${HEAD12}`);
    expect(mustBuild(laneRunMergeEnqueueKey(RUN_ID, 0, HEAD12))).toBe(`${RUN_ID}/r0/merge-enqueue@${HEAD12}`);
    expect(mustBuild(laneRunStopKey(RUN_ID, 'web'))).toBe(`${RUN_ID}/stop@web`);
    expect(mustBuild(laneRunStopForceKey(RUN_ID, 'cli'))).toBe(`${RUN_ID}/stop-force@cli`);
    expect(mustBuild(laneRunResumeKey(RUN_ID, 1, 'cli'))).toBe(`${RUN_ID}/park/1/resume@cli`);
    expect(mustBuild(requestKey(ULID))).toBe(`request/${ULID}`);
    expect(mustBuild(reaperRepairKey('attempt-1', 'dead-attempt', ULID))).toBe(`reaper/attempt-1/dead-attempt@${ULID}`);
    expect(MERGE_PR_RETRY_KEY).toBe(`merge/${HEAD12}/42/${HEAD12}/merge-pr/r1`);
    const byLabel = new Map(RELEASED_KEY_FORMAT_FIXTURES.map((fixture) => [fixture.label, fixture.keys]));
    expect(byLabel.get('step-standard')).toHaveLength(12);
  });

  it('replays the legacy entry record shapes (pre-KF-14a detail, pre-Q5a schemaVersion)', async () => {
    const dir = await stateDir();
    const rawEntries = LEGACY_ENTRY_SHAPES.map((shape) => shape.entry);
    await writeJournal(dir, rawEntries);
    const listed = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID);
    expect(listed).toHaveLength(2);
    for (const entry of listed) {
      // Both legacy shapes read as the current record: detail null, schema 1.
      expect(entry.detail).toBeNull();
      expect(entry.schemaVersion).toBe(1);
      expect(parseLaneRunKey(entry.key)).toMatchObject({ kind: 'step', step: 'collect', attemptOrdinal: null });
    }
    for (const shape of LEGACY_ENTRY_SHAPES) {
      expect(readLaneRunJournalEntry(shape.entry)).toEqual({ ok: true, entry: expect.objectContaining({ key: COLLECT_LEGACY }) });
      expect(parseVersionedLaneRunJournalStateRecord(shape.entry)).toMatchObject({ status: 'ok', schemaVersion: 1 });
    }
  });
});

describe('replay-and-advance on the current build', () => {
  it('advances a run with a pending pre-2026-11-05 ordinal-less collect intent and retry', async () => {
    const dir = await stateDir();
    const rawEntries = [conduct('collecting'), intent(COLLECT_LEGACY), intent(COLLECT_LEGACY_RETRY)];
    await writeJournal(dir, rawEntries);
    const entries = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID);

    expect(laneRunJournalState(entries, RUN_ID)).toBe('collecting');
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toEqual({
      key: COLLECT_LEGACY_RETRY, step: 'collect', reconciliation: 'unread',
    });
    const facts = baseFacts({
      state: laneRunJournalState(entries, RUN_ID),
      pendingIntent: laneRunJournalPendingIntent(entries, RUN_ID),
      attempt: attemptFact({ phase: 'ended' }),
    });
    const decision: LaneRunDecision = nextLaneRunAction(record(), facts, NOW);
    expect(decision).toEqual({ kind: 'reconcile', step: 'collect', key: COLLECT_LEGACY_RETRY });

    // The same journal with only the base collect intent pending reconciles that key.
    const baseDir = await stateDir();
    const baseEntries = [conduct('collecting'), intent(COLLECT_LEGACY)];
    await writeJournal(baseDir, baseEntries);
    const baseProjected = await new LaneRunJournalAdapter({ stateDir: baseDir, readOnly: true }).listForRun(RUN_ID);
    const basePending = laneRunJournalPendingIntent(baseProjected, RUN_ID);
    expect(basePending).toEqual({ key: COLLECT_LEGACY, step: 'collect', reconciliation: 'unread' });
    expect(nextLaneRunAction(record(), baseFacts({
      state: laneRunJournalState(baseProjected, RUN_ID),
      pendingIntent: basePending,
      attempt: attemptFact({ phase: 'ended' }),
    }), NOW)).toEqual({ kind: 'reconcile', step: 'collect', key: COLLECT_LEGACY });
  });

  it('advances a run with a completed pre-2026-11-05 ordinal-less collect intent to gate', async () => {
    const dir = await stateDir();
    const prepareKey = `${RUN_ID}/r0/prepare/0/a1`;
    const dispatchKey = `${RUN_ID}/r0/dispatch/0/a1`;
    const rawEntries = [
      { ...intent(prepareKey), mintedId: 'attempt-example-1' },
      result(prepareKey, 'completed', { reasonCode: 'prepared' }),
      intent(dispatchKey),
      result(dispatchKey, 'completed', { reasonCode: 'dispatch-started' }),
      intent(COLLECT_LEGACY),
      result(COLLECT_LEGACY, 'completed', { reasonCode: 'collected' }),
      conduct('gating'),
    ];
    await writeJournal(dir, rawEntries);
    const entries = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID);

    expect(laneRunJournalState(entries, RUN_ID)).toBe('gating');
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toBeNull();
    expect(laneRunJournalDispatchResult(entries, dispatchKey)).toBe('started');
    const facts = baseFacts({
      state: laneRunJournalState(entries, RUN_ID),
      attempt: attemptFact({
        phase: 'collected',
        collection: SEALED_COLLECTION,
        dispatchResult: laneRunJournalDispatchResult(entries, dispatchKey),
      }),
      head12: HEAD12,
    });
    expect(nextLaneRunAction(record(), facts, NOW)).toEqual({
      kind: 'act', step: 'gate', key: `${RUN_ID}/r0/gate/0@${HEAD12}`, round: 0, seatIndex: 0, head12: HEAD12, retry: null,
    });
  });

  it('replays and advances a pre-KS7b journal carrying the one-way merge step key', async () => {
    const dir = await stateDir();
    const rawEntries = [
      intent(`${RUN_ID}/r0/prepare/0/a1`),
      result(`${RUN_ID}/r0/prepare/0/a1`, 'completed', { reasonCode: 'prepared' }),
      intent(`${RUN_ID}/r0/dispatch/0/a1`),
      result(`${RUN_ID}/r0/dispatch/0/a1`, 'completed', { reasonCode: 'dispatch-started' }),
      intent(`${RUN_ID}/r0/collect/0/a1`),
      result(`${RUN_ID}/r0/collect/0/a1`, 'completed', { reasonCode: 'collected' }),
      intent(`${RUN_ID}/r0/gate/0@${HEAD12}`),
      result(`${RUN_ID}/r0/gate/0@${HEAD12}`, 'completed', { reasonCode: 'gate-passed' }),
      intent(`${RUN_ID}/r0/accept/0@${HEAD12}`),
      result(`${RUN_ID}/r0/accept/0@${HEAD12}`, 'completed', { reasonCode: 'accepted' }),
      intent(`${RUN_ID}/r0/open-pr/0@${HEAD12}`),
      result(`${RUN_ID}/r0/open-pr/0@${HEAD12}`, 'completed', { reasonCode: 'pr-opened' }),
      conduct('merging'),
      intent(MERGE_STEP_KEY),
    ];
    await writeJournal(dir, rawEntries);
    const entries = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID);

    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toEqual({
      key: MERGE_STEP_KEY, step: 'merge', reconciliation: 'unread',
    });
    expect(laneRunGateFact(entries, RUN_ID, HEAD12)).toBe('passed');
    const facts = baseFacts({
      state: laneRunJournalState(entries, RUN_ID),
      pendingIntent: laneRunJournalPendingIntent(entries, RUN_ID),
      head12: HEAD12,
      acceptedHead12: HEAD12,
      pr: { state: 'merged', head12: HEAD12, containsLaneHead: true },
      attempt: attemptFact({ phase: 'collected', collection: SEALED_COLLECTION }),
    });
    expect(nextLaneRunAction(record(), facts, NOW)).toEqual({
      kind: 'reconcile', step: 'merge', key: MERGE_STEP_KEY,
    });
  });

  it('rejects building a legacy ordinal-less collect key while keeping the old-form reader', () => {
    expect(buildLaneRunStepKey({
      runId: RUN_ID, round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: null, head12: null, retry: null,
    })).toEqual({ ok: false, error: 'LaneRun key attemptOrdinal does not match its step' });
    expect(parseLaneRunKey(COLLECT_LEGACY)).toEqual({
      kind: 'step', runId: RUN_ID, round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: null, head12: null, retry: null,
    });
  });

  it('replays journal facts through the projection helpers', async () => {
    const dir = await stateDir();
    const prepareKey = `${RUN_ID}/r0/prepare/0/a1`;
    const premergeKey = mustBuild(laneRunPremergeKey(RUN_ID, 0, HEAD12));
    const rawEntries = [
      { ...intent(prepareKey), mintedId: 'attempt-example-1' },
      intent(premergeKey),
      result(premergeKey, 'completed', { reasonCode: 'premerge-success' }),
      intent(`${RUN_ID}/stop@web`),
    ];
    await writeJournal(dir, rawEntries);
    const entries = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID);

    expect(laneRunAttemptPlacement(entries, RUN_ID, 'attempt-example-1')).toEqual({ round: 0, seatIndex: 0 });
    expect(laneRunPremergePost(entries, RUN_ID, HEAD12)).toBe('success');
    expect(laneRunJournalStopFacts(entries, RUN_ID)).toEqual({
      stopMode: 'graceful', stopRequestedAtIso: NOW,
    });
    expect(laneRunGateFact(entries, RUN_ID, null)).toBe('none');
  });
});

describe('refusals', () => {
  it('returns null/error on empty key and empty array on ENOENT', async () => {
    expect(parseLaneRunKey('')).toBeNull();
    expect(parseLaneRunKey('   ')).toBeNull();
    const read = readLaneRunJournalEntry({});
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.length).toBeGreaterThan(0);
    }
    const dir = await stateDir();
    const listed = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID);
    expect(listed).toEqual([]);
  });

  it('throws StateFileUnreadableReadOnlyError on unreadable run-journal.json in readOnly mode', async () => {
    for (const bytes of [Buffer.from('{not json', 'utf8'), Buffer.from([0xff, 0xfe, 0x00, 0x81])]) {
      const dir = await stateDir();
      const target = path.join(dir, 'run-journal.json');
      await writeFile(target, bytes);
      await expect(
        new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID),
      ).rejects.toBeInstanceOf(StateFileUnreadableReadOnlyError);
      // No quarantine copy in readOnly mode: the file is untouched.
      expect(await readFile(target)).toEqual(bytes);
    }
  });

  it('refuses malformed journal entries and secret-shaped fields without echoing', async () => {
    const unknownKey = intent('not-a-run-journal-key');
    const mismatchedRun = intent(COLLECT_LEGACY, { runId: OTHER_RUN_ID });
    const badEntryId = intent(COLLECT_LEGACY, { entryId: 'not-a-ulid' });
    const secret = fakeSecretShape();
    const secretShaped = intent(COLLECT_LEGACY, { mintedId: secret });

    for (const raw of [unknownKey, mismatchedRun, badEntryId, secretShaped]) {
      expect(readLaneRunJournalEntry(raw).ok).toBe(false);
      expect(parseVersionedLaneRunJournalStateRecord(raw)).toEqual({ status: 'invalid' });
    }
    const secretRead = readLaneRunJournalEntry(secretShaped);
    expect(secretRead.ok).toBe(false);
    if (!secretRead.ok) {
      expect(secretRead.error).not.toContain(secret);
    }

    const dir = await stateDir();
    await writeJournal(dir, [unknownKey]);
    await expect(
      new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID),
    ).rejects.toBeInstanceOf(StateFileUnreadableReadOnlyError);
  });

  it('refuses unknown schemaVersion with StateFileUnknownVersionError', async () => {
    const future: RawEntry = { ...intent(COLLECT_LEGACY), schemaVersion: 99 };
    const recordRead = readLaneRunJournalEntryRecord(future);
    expect(recordRead).toEqual({ ok: false, reason: 'unknown-schema-version' });
    expect(parseVersionedLaneRunJournalStateRecord(future)).toEqual({ status: 'unknown-version' });

    const dir = await stateDir();
    await writeJournal(dir, [future]);
    await expect(
      new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID),
    ).rejects.toBeInstanceOf(StateFileUnknownVersionError);
  });

  it('refuses non-array run-journal.json and ignores non-string ids in listForRuns', async () => {
    for (const body of ['{}', '"str"']) {
      const dir = await stateDir();
      await writeFile(path.join(dir, 'run-journal.json'), body, 'utf8');
      await expect(
        new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRun(RUN_ID),
      ).rejects.toBeInstanceOf(StateFileUnreadableReadOnlyError);
    }

    const dir = await stateDir();
    await writeJournal(dir, [intent(COLLECT_LEGACY)]);
    const grouped = await new LaneRunJournalAdapter({ stateDir: dir, readOnly: true }).listForRuns([
      RUN_ID,
      42 as unknown as string,
      null as unknown as string,
    ]);
    expect([...grouped.keys()]).toEqual([RUN_ID]);
    expect(grouped.get(RUN_ID)?.length).toBe(1);
  });

  it('handles null inputs safely without throwing', () => {
    expect(parseLaneRunKey(null)).toBeNull();
    expect(readLaneRunJournalEntry(null).ok).toBe(false);
    expect(parseVersionedLaneRunJournalStateRecord(null)).toEqual({ status: 'invalid' });
    const entries = [intent(COLLECT_LEGACY), conduct('collecting')];
    expect(laneRunJournalPendingIntent(entries, null as unknown as string)).toBeNull();
    expect(laneRunJournalState(entries, null as unknown as string)).toBe('ready');
  });

  it('catches throwing getters in entry and key readers without throwing', () => {
    const hostile = Object.defineProperty({}, 'key', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(readLaneRunJournalEntry(hostile).ok).toBe(false);
    expect(readLaneRunJournalEntryRecord(hostile)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseVersionedLaneRunJournalStateRecord(hostile)).toEqual({ status: 'invalid' });
    expect(buildLaneRunStepKey(hostile as Parameters<typeof buildLaneRunStepKey>[0]).ok).toBe(false);
  });

  it('refuses append in readOnly mode and parks when retry budget is exhausted', async () => {
    const dir = await stateDir();
    const rawEntries = [intent(COLLECT_LEGACY)];
    const target = await writeJournal(dir, rawEntries);
    const before = await readFile(target);
    const adapter = new LaneRunJournalAdapter({ stateDir: dir, readOnly: true });
    await expect(adapter.append(intent(COLLECT_LEGACY))).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    expect(await readFile(target)).toEqual(before);

    // The journal shows the gate retry budget exhausted (retry 9 failed to
    // decide): the run parks instead of advancing past LANE_RUN_MAX_RETRY.
    const exhaustedKey = `${RUN_ID}/r0/gate/0@${HEAD12}/retry${LANE_RUN_MAX_RETRY}`;
    const exhaustedDir = await stateDir();
    const exhaustedEntries = [
      conduct('gating'),
      intent(exhaustedKey),
      result(exhaustedKey, 'ambiguous'),
    ];
    await writeJournal(exhaustedDir, exhaustedEntries);
    const entries = await new LaneRunJournalAdapter({ stateDir: exhaustedDir, readOnly: true }).listForRun(RUN_ID);
    const pendingIntent = laneRunJournalPendingIntent(entries, RUN_ID);
    expect(pendingIntent).toEqual({ key: exhaustedKey, step: 'gate', reconciliation: 'ambiguous' });
    const facts = baseFacts({
      state: laneRunJournalState(entries, RUN_ID),
      pendingIntent,
      attempt: attemptFact({ phase: 'collected', collection: SEALED_COLLECTION }),
      head12: HEAD12,
    });
    expect(nextLaneRunAction(record(), facts, NOW)).toEqual({
      kind: 'park', reason: 'ambiguous', qualifier: 'gate', parkedFrom: 'gating',
    });
  });
});
