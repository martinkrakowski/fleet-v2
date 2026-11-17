// Lane SH7b: RecordShadowDayUseCase exercised directly with fakes for every
// dependency — no CLI, no composition (that is SH8a).
import { describe, expect, it } from 'vitest';

import type { CutoverShadowCriterion } from '../../../domain/cutover-records.js';
import type { DaemonEventRecord } from '../../../domain/daemon-events.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildMergeKey } from '../../../domain/lane-run-keys.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { ShadowLedger } from '../../../domain/shadow-evidence-ledger.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import type { ImportTrainStateKey, ImportTrainStateResult } from '../../ports/in/ImportTrainStatePort.in-port.js';
import type { LegacyTrainEventsRead, LegacyTrainStateRead } from '../../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { ShadowLedgerReadResult } from '../../ports/out/ShadowEvidencePort.out-port.js';
import type { RecordShadowDayRequest, RecordShadowDayResult } from '../../ports/in/RecordShadowDayPort.in-port.js';
import {
  RecordShadowDayUseCase,
  type RecordShadowDayDependencies,
} from '../RecordShadowDayUseCase.use-case.js';

const OWNER = 'octo';
const REPO = 'train';
const REPOSITORY = { owner: OWNER, repo: REPO };
const REPO_DIGEST = '0123456789ab';
const LEGACY_STATE_DIR = '/state/legacy';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const RELEASE = 'c'.repeat(40);
const DAY = '2026-11-16';
const NOW = '2026-11-17T12:00:00.000Z';
const DEADLINE = '2026-11-17T12:05:00.000Z';
const PAST_DEADLINE = '2026-11-17T11:00:00.000Z';
const NOT_IMPLEMENTED: readonly CutoverShadowCriterion[] = [
  'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S10', 'S11', 'S13',
];

/** A valid ULID-shaped id carrying `n` (O1b-1 pattern: `[0-7][Crockford]{25}`). */
function ulid(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let rest = n;
  let id = '0';
  for (let i = 0; i < 25; i += 1) {
    id += alphabet[rest % alphabet.length];
    rest = Math.floor(rest / alphabet.length);
  }
  return id;
}

function shellResultLine(atIso: string, pr: number, headOid: string): string {
  return JSON.stringify({ at: atIso, kind: 'result', outcome: 'merged', pr, headOid, detail: '' });
}

function mergeKeyFor(pr: number, headOid: string): string {
  const built = buildMergeKey({
    repoDigest: REPO_DIGEST,
    pullRequest: pr,
    head12: headOid.slice(0, 12),
    action: 'merge-pr',
    attemptOrdinal: null,
    retry: null,
    retryProof: null,
  });
  if (!built.ok) {
    throw new Error(`fixture merge key refused: ${built.error}`);
  }
  return built.key;
}

interface JournalEntryInit {
  readonly kind: 'intent' | 'result';
  readonly key: string;
  readonly outcome?: string;
  readonly reasonCode?: string;
  readonly recordedAtIso: string;
}

function journalEntry(init: JournalEntryInit): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId: ulid(1),
    kind: init.kind,
    key: init.key,
    runId: null,
    recordedAtIso: init.recordedAtIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: (init.outcome as LaneRunJournalEntryRecord['outcome']) ?? null,
    reasonCode: init.reasonCode ?? null,
    detail: null,
    grantId: null,
    state: null,
  } as LaneRunJournalEntryRecord;
}

function daemonJobEvent(index: number, day: string): DaemonEventRecord {
  const hour = String(Math.floor(index / 60) % 24).padStart(2, '0');
  const minute = String(index % 60).padStart(2, '0');
  return {
    version: 1,
    eventId: ulid(10_000 + index),
    tickId: `tick-${ulid(index + 1)}`,
    jobId: `merge-pass:${REPO_DIGEST}`,
    kind: 'job',
    key: null,
    entryId: null,
    outcome: 'completed',
    reasonCode: null,
    recordedAtIso: `${day}T${hour}:${minute}:00Z`,
  };
}

interface Fixture {
  readonly shellLines: string[];
  readonly journalEntries: LaneRunJournalEntryRecord[];
  readonly queueEntries: MergeQueueEntryRecord[];
  readonly daemonEvents: DaemonEventRecord[];
  /** The S8 shell-state read, overridable per test. */
  shellState: LegacyTrainStateRead;
  /** The S8 import dry-run's keys, overridable per test. */
  importKeys: ImportTrainStateKey[];
}

/** The S8 shell state matching the clean fixture: one live entry on `main`. */
function cleanShellState(): LegacyTrainStateRead {
  return {
    queue: { status: 'read', lines: [`7 ${HEAD_A} main`] },
    parked: { status: 'read', lines: [] },
    chains: { status: 'absent' },
    batch: { status: 'absent' },
    inprogress: { status: 'read', lines: [] },
    batchesEnabled: { status: 'read', lines: [] },
  };
}

/** The S8 import dry-run keys matching the clean fixture: the same single entry. */
function cleanImportKeys(): ImportTrainStateKey[] {
  return [{ pullRequest: 7, headOid: HEAD_A, base: 'main', source: 'queue', disposition: 'would-import' }];
}

/** A refused import dry-run answer for S8's sample. */
function refusedImport(): ImportTrainStateResult {
  return { outcome: 'refused', reason: 'legacy-unreadable' };
}

/** A successful dry-run answer over `keys`. */
function dryRunImport(keys: readonly ImportTrainStateKey[]): ImportTrainStateResult {
  return {
    outcome: 'dry-run',
    wouldImport: keys.length,
    unknownLineNumbers: [],
    notImportableBase: 0,
    alreadyQueued: 0,
    parkedLines: 0,
    chainFiles: 0,
    batchLines: 0,
    inprogressLines: 0,
    unknownBySource: { queue: [], parked: [], inprogress: [] },
    keys,
    keysTruncated: false,
  };
}

/** A clean fixture for `day`: one shell merge exactly matched by the fleet side. */
function cleanFixture(day: string): Fixture {
  const shellLines = [shellResultLine(`${day}T10:00:00Z`, 7, HEAD_A)];
  const key = mergeKeyFor(7, HEAD_A);
  const journalEntries = [
    journalEntry({ kind: 'intent', key, recordedAtIso: `${day}T09:59:00Z` }),
    journalEntry({
      kind: 'result',
      key,
      outcome: 'dry-run',
      reasonCode: 'would-merge',
      recordedAtIso: `${day}T10:00:30Z`,
    }),
  ];
  const queueEntries = [
    {
      entryId: ulid(2),
      pullRequest: 7,
      headOid: HEAD_A,
      state: 'queued',
      repository: REPOSITORY,
      repoDigest: REPO_DIGEST,
    },
  ] as unknown as MergeQueueEntryRecord[];
  const daemonEvents: DaemonEventRecord[] = [];
  for (let index = 0; index < 800; index += 1) {
    daemonEvents.push(daemonJobEvent(index, day));
  }
  return {
    shellLines,
    journalEntries,
    queueEntries,
    daemonEvents,
    shellState: cleanShellState(),
    importKeys: cleanImportKeys(),
  };
}

interface Harness {
  readonly deps: RecordShadowDayDependencies;
  readonly evidence: {
    read: () => Promise<ShadowLedgerReadResult>;
    compareAndSet: (request: {
      expectedRevision: number;
      next: ShadowLedger;
      deadlineIso?: string;
    }) => Promise<
      | { outcome: 'saved'; ledger: ShadowLedger }
      | { outcome: 'conflict'; currentRevision: number | null }
      | { outcome: 'refused'; reason: 'invalid-request' }
    >;
    calls: { read: number; cas: number };
    stored: ShadowLedger | null;
  };
  readonly otherCalls: { legacy: number; legacyState: number; queue: number; journal: number; daemon: number; checkState: number; import: number };
  /** The `ms` value of every fake `sleep` call, in order. */
  readonly sleeps: readonly number[];
  setNow(iso: string): void;
  setLedgerRead(result: ShadowLedgerReadResult): void;
  setImportDryRun(result: ImportTrainStateResult): void;
  forceConflicts(): void;
}

function makeHarness(fixture: Fixture, nowIso: string): Harness {
  let now = nowIso;
  let ledgerReadOverride: ShadowLedgerReadResult | null = null;
  let importOverride: ImportTrainStateResult | null = null;
  let stored: ShadowLedger | null = null;
  let forceConflict = false;
  const evidenceCalls = { read: 0, cas: 0 };
  const sleeps: number[] = [];
  const otherCalls = { legacy: 0, legacyState: 0, queue: 0, journal: 0, daemon: 0, checkState: 0, import: 0 };

  const evidence = {
    read: async (): Promise<ShadowLedgerReadResult> => {
      evidenceCalls.read += 1;
      if (ledgerReadOverride !== null) {
        return ledgerReadOverride;
      }
      return stored === null ? { status: 'missing' } : { status: 'ok', ledger: stored };
    },
    compareAndSet: async (request: { expectedRevision: number; next: ShadowLedger }) => {
      evidenceCalls.cas += 1;
      const currentRevision = stored === null ? 0 : stored.revision;
      if (forceConflict || currentRevision !== request.expectedRevision) {
        return { outcome: 'conflict' as const, currentRevision };
      }
      // Mirrors ShadowEvidenceAdapter#resolveNext: `next.revision` must be
      // exactly `expectedRevision + 1`. An idempotent no-op CAS call (the
      // bug this fix round closes) is refused here exactly as the real
      // adapter refuses it, so a regression fails this fake the same way
      // it would fail against the real adapter.
      if (request.next.revision !== request.expectedRevision + 1) {
        return { outcome: 'refused' as const, reason: 'invalid-request' as const };
      }
      stored = request.next;
      return { outcome: 'saved' as const, ledger: request.next };
    },
    calls: evidenceCalls,
    get stored(): ShadowLedger | null {
      return stored;
    },
  };

  const deps: RecordShadowDayDependencies = {
    evidence: {
      read: evidence.read,
      compareAndSet: evidence.compareAndSet,
    },
    legacy: {
      readLegacyTrainState: async () => {
        otherCalls.legacyState += 1;
        return fixture.shellState;
      },
      readLegacyTrainEvents: async (): Promise<LegacyTrainEventsRead> => {
        otherCalls.legacy += 1;
        return { status: 'read', lines: fixture.shellLines };
      },
    },
    queue: {
      listMergeEntries: async () => {
        otherCalls.queue += 1;
        return fixture.queueEntries;
      },
    },
    journal: {
      listForKeyPrefix: async () => {
        otherCalls.journal += 1;
        return fixture.journalEntries;
      },
    },
    daemonEvents: {
      readAfterCursor: async () => {
        otherCalls.daemon += 1;
        return { ok: true as const, events: fixture.daemonEvents, nextCursor: null };
      },
    },
    checkState: async () => {
      otherCalls.checkState += 1;
      return { checked: 5, bad: 0 };
    },
    importDryRun: {
      importTrainState: async () => {
        otherCalls.import += 1;
        return importOverride ?? dryRunImport(fixture.importKeys);
      },
    },
    // The fake gap advances the harness clock so the two samples'
    // `takenAtIso` values are really `sampleGapMs` apart.
    sleep: async (ms) => {
      sleeps.push(ms);
      now = new Date(Date.parse(now) + ms).toISOString();
    },
    computeDigest: sha256HexDigest,
    repoDigestOf: () => REPO_DIGEST,
    releaseSha: async () => RELEASE,
    nowIso: () => now,
    settings: { excludeBatchMerges: false },
  };

  return {
    deps,
    evidence,
    otherCalls,
    sleeps,
    setNow: (iso) => {
      now = iso;
    },
    setLedgerRead: (result) => {
      ledgerReadOverride = result;
    },
    setImportDryRun: (result) => {
      importOverride = result;
    },
    forceConflicts: () => {
      forceConflict = true;
    },
  };
}

function makeRequest(overrides: Partial<RecordShadowDayRequest> = {}): RecordShadowDayRequest {
  return {
    repository: REPOSITORY,
    legacyStateDir: LEGACY_STATE_DIR,
    day: DAY,
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

/** The recorded/unchanged arm of the result union. */
type RecordedResult = Extract<RecordShadowDayResult, { outcome: 'recorded' | 'unchanged' }>;

/** Narrows a result to its recorded/unchanged arm or fails the test. */
function expectRecorded(result: RecordShadowDayResult): asserts result is RecordedResult {
  if (result.outcome !== 'recorded' && result.outcome !== 'unchanged') {
    throw new Error(`expected a recorded outcome, got ${result.outcome}`);
  }
}

/** The canonical S1 summary digest, rebuilt here exactly as the use case builds it. */
function expectedS1Digest(day: string, status: string, reason: string, counts: {
  mergesCompared: number;
  excludedBatchMerges: number;
  compared: number;
  divergences: number;
}): string {
  return sha256HexDigest(
    JSON.stringify({
      criterion: 'S1',
      day,
      status,
      reason,
      mergesCompared: counts.mergesCompared,
      excludedBatchMerges: counts.excludedBatchMerges,
      compared: counts.compared,
      divergences: counts.divergences,
      excludeBatchMerges: false,
    }),
  );
}

function expectedSimpleDigest(criterion: 'S8' | 'S9' | 'S12', day: string, status: string, reason: string): string {
  return sha256HexDigest(JSON.stringify({ criterion, day, status, reason }));
}

/** Every not-yet-built criterion is always in `unevaluated`, exactly once. */
function expectNotImplementedUnevaluated(
  unevaluated: readonly { criterion: CutoverShadowCriterion; reason: string }[],
): void {
  const reasons = new Map(unevaluated.map((entry) => [entry.criterion, entry.reason]));
  for (const criterion of NOT_IMPLEMENTED) {
    expect(reasons.get(criterion)).toBe('not-implemented');
  }
  expect(unevaluated.filter((entry) => entry.reason === 'not-implemented')).toHaveLength(NOT_IMPLEMENTED.length);
}

describe('RecordShadowDayUseCase', () => {
  it('records S1, S9 and S12 as passes on a clean fixture', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    expect(result.outcome).toBe('recorded');
    expect(result.recorded).toEqual({
      S1: 'pass',
      S8: 'pass',
      S9: 'pass',
      S12: 'pass',
    });
    expect(result.revision).toBe(1);
    const stored = harness.evidence.stored;
    expect(stored).not.toBeNull();
    const dayRecord = stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.mergesCompared).toBe(1);
    expect(dayRecord?.releaseSha).toBe(RELEASE);
    expect(dayRecord?.verdicts.S1).toMatchObject({ verdict: 'pass', reason: 'merge-set-equal' });
    expect(dayRecord?.verdicts.S1?.digest).toBe(
      expectedS1Digest(DAY, 'pass', 'merge-set-equal', {
        mergesCompared: 1,
        excludedBatchMerges: 0,
        compared: 1,
        divergences: 0,
      }),
    );
    expect(dayRecord?.verdicts.S8?.digest).toBe(expectedSimpleDigest('S8', DAY, 'pass', 'intake-equal'));
    expect(dayRecord?.verdicts.S9?.digest).toBe(expectedSimpleDigest('S9', DAY, 'pass', 'state-consistent'));
    expect(dayRecord?.verdicts.S12?.digest).toBe(expectedSimpleDigest('S12', DAY, 'pass', 'ticks-within-budget'));
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('answers unchanged when the same inputs are recorded a second time, without a second (no-op) compareAndSet call', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const afterFirst = harness.evidence.stored;
    const casCallsAfterFirst = harness.evidence.calls.cas;
    expect(casCallsAfterFirst).toBe(1);

    // A later deadline: the two S8 samples' real (faked) 150s wall-clock
    // gaps of two runs would otherwise cross this request's deadline.
    const request = makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' });
    const result = await useCase.execute(request);
    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    expect(result.revision).toBe(1);
    // The idempotent re-run must not call compareAndSet again: doing so
    // with `next` at the same revision as `expectedRevision` would be a
    // malformed CAS request per ShadowEvidencePort's contract.
    expect(harness.evidence.calls.cas).toBe(casCallsAfterFirst);
    expect(harness.evidence.stored).toEqual(afterFirst);
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it("filters a live queue entry from another repository out of S1's merge set, compensating for MergeQueueRepositoryAdapter#listMergeEntries not filtering by the query's repository itself", async () => {
    const fixture = cleanFixture(DAY);
    // Same pull request, same 12-char head prefix as the real live entry,
    // but a different full head and a different repository/repoDigest. If
    // this use case did not defensively filter the adapter's (unfiltered)
    // result by repoDigest, this entry would land in the same
    // `pullRequest:head12` bucket as the real entry inside
    // `evaluateShadowMergeSet`'s head-resolution index, making the lookup
    // ambiguous and turning a genuine pass into a false
    // `fail`/`fleet-head-ambiguous` verdict.
    const contaminatingHead = `${'a'.repeat(12)}${'c'.repeat(28)}`;
    fixture.queueEntries.push({
      entryId: ulid(3),
      pullRequest: 7,
      headOid: contaminatingHead,
      state: 'queued',
      repository: { owner: 'foreign', repo: 'other' },
      repoDigest: 'fedcba987654',
    } as unknown as MergeQueueEntryRecord);
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
  });

  it('refuses a changed re-run with verdict-conflict and leaves the ledger untouched', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const before = harness.evidence.stored?.days[0].verdicts.S1;

    fixture.shellLines.push(shellResultLine(`${DAY}T11:00:00Z`, 8, HEAD_B));
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored?.days[0].verdicts.S1).toEqual(before);
    expect(harness.evidence.stored?.revision).toBe(1);
  });

  it('reports S1 unevaluated when the legacy events read is unavailable and still records S9 and S12', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    delete (harness.deps.legacy as unknown as Partial<Record<string, unknown>>).readLegacyTrainEvents;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    expect(result.recorded).toEqual({ S8: 'pass', S9: 'pass', S12: 'pass' });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S1')).toBe('shell-events-unavailable');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('refuses a day too close to now as too-early', async () => {
    const harness = makeHarness(cleanFixture('2026-11-17'), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ day: '2026-11-17' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'too-early' });
    expect(harness.evidence.calls.cas).toBe(0);
  });

  it('refuses the still-running current day without any write even when omitted day defaults', async () => {
    const harness = makeHarness(cleanFixture('2026-11-17'), '2026-11-18T00:05:00.000Z');
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ day: undefined, deadlineIso: '2026-11-18T00:10:00.000Z' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'too-early' });
  });

  it('refuses a day more than 7 calendar days old as too-old', async () => {
    const harness = makeHarness(cleanFixture('2026-11-09'), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ day: '2026-11-09' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'too-old' });
  });

  it('refuses a malformed repository as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ repository: { owner: '..', repo: REPO } }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.evidence.calls.read).toBe(0);
  });

  it('answers unknown ledger-unreadable and writes nothing when the ledger is unreadable', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    harness.setLedgerRead({ status: 'unreadable' });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());

    expect(result).toEqual({ outcome: 'unknown', reason: 'ledger-unreadable' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('answers unknown ledger-unknown-version for a ledger above the supported schema version', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    harness.setLedgerRead({ status: 'unknown-version' });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'ledger-unknown-version' });
  });

  it('answers unknown ledger-busy after two consecutive compare-and-set conflicts', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    harness.forceConflicts();
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());

    expect(result).toEqual({ outcome: 'unknown', reason: 'ledger-busy' });
    expect(harness.evidence.calls.read).toBe(2);
    expect(harness.evidence.calls.cas).toBe(2);
    expect(harness.evidence.stored).toBeNull();
  });

  it('answers unknown deadline-exceeded with no dependency call after the check', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ deadlineIso: PAST_DEADLINE }),
    );

    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(harness.evidence.calls.read).toBe(0);
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.otherCalls).toEqual({ legacy: 0, legacyState: 0, queue: 0, journal: 0, daemon: 0, checkState: 0, import: 0 });
  });

  it('evaluates S9 only for yesterday and records S1 and S12 for an older day', async () => {
    const olderDay = '2026-11-15';
    const harness = makeHarness(cleanFixture(olderDay), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ day: olderDay }),
    );

    expectRecorded(result);
    expect(result.recorded).toEqual({ S1: 'pass', S12: 'pass' });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S9')).toBe('snapshot-only-for-yesterday');
    expect(reasons.get('S8')).toBe('snapshot-only-for-yesterday');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('records S8 as a fail when a divergence persists across both samples', async () => {
    const fixture = cleanFixture(DAY);
    // A shell live entry the fleet queue never sees, in BOTH samples.
    fixture.shellState = {
      ...fixture.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `8 ${HEAD_B} main`] },
    };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S8).toBe('fail');
    const stored = harness.evidence.stored;
    const dayRecord = stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
    expect(dayRecord?.verdicts.S8?.digest).toBe(
      expectedSimpleDigest('S8', DAY, 'fail', 'enqueue-coverage-divergence'),
    );
  });

  it('reports S8 unevaluated when the import dry-run is refused, still recording S1, S9 and S12', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    harness.setImportDryRun(refusedImport());
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    expect(result.recorded).toEqual({ S1: 'pass', S9: 'pass', S12: 'pass' });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S8')).toBe('import-unavailable');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('sleeps exactly once, for exactly the default 150000 ms gap, between the two S8 samples', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S8).toBe('pass');
    expect(harness.sleeps).toEqual([150_000]);
    // Both samples were really taken: one shell-state and one import dry-run
    // read per sample.
    expect(harness.otherCalls.legacyState).toBe(2);
    expect(harness.otherCalls.import).toBe(2);
  });

  it('refuses a malformed day as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ day: '2026-13-40' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('never lists a not-yet-built criterion as evaluated in any outcome', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const outcomes = [
      await useCase.execute(makeRequest()),
      await useCase.execute(makeRequest()),
      await useCase.execute(makeRequest({ day: '2026-11-15' })),
    ];
    for (const result of outcomes) {
      if (result.outcome === 'refused' || result.outcome === 'unknown') {
        continue;
      }
      expectNotImplementedUnevaluated(result.unevaluated);
      const evaluated = new Set(Object.keys(result.recorded));
      for (const criterion of NOT_IMPLEMENTED) {
        expect(evaluated.has(criterion)).toBe(false);
      }
    }
  });
});
