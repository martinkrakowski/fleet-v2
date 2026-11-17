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
/**
 * `buildVerdicts`'s `recordedAtIso` for any single `execute()` call against
 * a fresh harness started at `NOW`: exactly one S8 sample pair is taken, so
 * the fake clock advances by exactly one `sleep(150_000)` (the default
 * sample gap) before verdicts are built, and nothing else advances it.
 * `NOW` plus 150 real seconds is `2026-11-17T12:02:30.000Z`.
 */
const RECORDED_AT_ISO = '2026-11-17T12:02:30.000Z';
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

type SyntheticStep = 'intent' | 'completed' | 'refused' | 'ambiguous';

/**
 * Entries for one non-merge key, in append order. S1 skips a key
 * `parseLaneRunKey` does not accept; S9 still tallies it.
 */
function syntheticKey(key: string, steps: readonly SyntheticStep[]): LaneRunJournalEntryRecord[] {
  const recordedAtIso = `${DAY}T11:00:00.000Z`;
  return steps.map((step) => journalEntry({
    kind: step === 'intent' ? 'intent' : 'result',
    key,
    ...(step === 'intent' ? {} : { outcome: step }),
    recordedAtIso,
  }));
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
  /** The S9 state-check sample, overridable so two passes can differ only in `checked`. */
  stateCheck: { checked: number; bad: number };
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
    stateCheck: { checked: 5, bad: 0 },
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
  /** Makes the fleet queue's `listMergeEntries` throw on every subsequent call, for S8's fleet-read-threw case. */
  setQueueThrows(): void;
  forceConflicts(): void;
}

function makeHarness(fixture: Fixture, nowIso: string): Harness {
  let now = nowIso;
  let ledgerReadOverride: ShadowLedgerReadResult | null = null;
  let importOverride: ImportTrainStateResult | null = null;
  let queueThrows = false;
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
        if (queueThrows) {
          throw new Error('fleet queue read failed');
        }
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
      return fixture.stateCheck;
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
    setQueueThrows: () => {
      queueThrows = true;
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

/**
 * The canonical S9 summary digest, rebuilt here exactly as the use case
 * builds it: S9 carries its evaluator's state-integrity counts into the
 * digest, so two evaluations landing on the same {status, reason} pair are
 * no longer indistinguishable to it.
 */
function expectedS9Digest(day: string, status: string, reason: string, counts: {
  stateChecked: number;
  stateBad: number;
  journalKeys: number;
  duplicateIntents: number;
  duplicateResults: number;
  resultsAfterFinal: number;
  orphanResults: number;
  unreconciledIntents: number;
}): string {
  return sha256HexDigest(
    JSON.stringify({
      criterion: 'S9',
      day,
      status,
      reason,
      stateChecked: counts.stateChecked,
      stateBad: counts.stateBad,
      journalKeys: counts.journalKeys,
      duplicateIntents: counts.duplicateIntents,
      duplicateResults: counts.duplicateResults,
      resultsAfterFinal: counts.resultsAfterFinal,
      orphanResults: counts.orphanResults,
      unreconciledIntents: counts.unreconciledIntents,
    }),
  );
}

/**
 * The canonical S12 summary digest, rebuilt here exactly as the use case
 * builds it: S12 carries its evaluator's tick-health counts into the digest,
 * so two evaluations landing on the same {status, reason} pair are no longer
 * indistinguishable to it.
 */
function expectedS12Digest(day: string, status: string, reason: string, counts: {
  totalTicks: number;
  budgetOverruns: number;
  starvedJobs: number;
}): string {
  return sha256HexDigest(
    JSON.stringify({
      criterion: 'S12',
      day,
      status,
      reason,
      totalTicks: counts.totalTicks,
      budgetOverruns: counts.budgetOverruns,
      starvedJobs: counts.starvedJobs,
    }),
  );
}

/**
 * The canonical S8 summary digest, rebuilt here exactly as the use case
 * builds it: S8 excludes its eight live-sample counts (they have no
 * per-item timestamp and are not scoped to UTC day `D`), so its digest
 * hashes only `{ criterion, day, status, reason }`.
 */
function expectedS8Digest(day: string, status: string, reason: string): string {
  return sha256HexDigest(
    JSON.stringify({
      criterion: 'S8',
      day,
      status,
      reason,
    }),
  );
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
    expect(dayRecord?.verdicts.S1).toEqual({
      verdict: 'pass',
      reason: 'merge-set-equal',
      digest: expectedS1Digest(DAY, 'pass', 'merge-set-equal', {
        mergesCompared: 1,
        excludedBatchMerges: 0,
        compared: 1,
        divergences: 0,
      }),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'pass',
      reason: 'intake-equal',
      digest: expectedS8Digest(DAY, 'pass', 'intake-equal'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S9).toEqual({
      verdict: 'pass',
      reason: 'state-consistent',
      digest: expectedS9Digest(DAY, 'pass', 'state-consistent', {
        stateChecked: 5,
        stateBad: 0,
        journalKeys: 1,
        duplicateIntents: 0,
        duplicateResults: 0,
        resultsAfterFinal: 0,
        orphanResults: 0,
        unreconciledIntents: 0,
      }),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S12?.digest).toBe(expectedS12Digest(DAY, 'pass', 'ticks-within-budget', {
      totalTicks: 800,
      budgetOverruns: 0,
      starvedJobs: 0,
    }));
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('two S9 evaluations with the same pass/state-consistent and different stateChecked get different digests', async () => {
    const fewerFixture = cleanFixture(DAY);
    fewerFixture.stateCheck = { checked: 5, bad: 0 };
    const moreFixture = cleanFixture(DAY);
    moreFixture.stateCheck = { checked: 10, bad: 0 };
    const harnessFewer = makeHarness(fewerFixture, NOW);
    const harnessMore = makeHarness(moreFixture, NOW);
    const resultFewer = await new RecordShadowDayUseCase(harnessFewer.deps).execute(makeRequest());
    const resultMore = await new RecordShadowDayUseCase(harnessMore.deps).execute(makeRequest());
    expectRecorded(resultFewer);
    expectRecorded(resultMore);
    expect(resultFewer.recorded.S9).toBe('pass');
    expect(resultMore.recorded.S9).toBe('pass');

    const digestFewer = harnessFewer.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S9?.digest;
    const digestMore = harnessMore.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S9?.digest;
    const shared = {
      stateBad: 0,
      journalKeys: 1,
      duplicateIntents: 0,
      duplicateResults: 0,
      resultsAfterFinal: 0,
      orphanResults: 0,
      unreconciledIntents: 0,
    };
    expect(digestFewer).toBe(expectedS9Digest(DAY, 'pass', 'state-consistent', { stateChecked: 5, ...shared }));
    expect(digestMore).toBe(expectedS9Digest(DAY, 'pass', 'state-consistent', { stateChecked: 10, ...shared }));
    expect(digestFewer).not.toBe(digestMore);
  });

  it('two S9 evaluations whose duplicateIntents and duplicateResults are swapped get different digests', async () => {
    // Pins a swap of those two fields in canonicalSummary. The clean fixture
    // contributes one reconciled key. Each side then adds four keys so every
    // other count matches: one side is 1 duplicate intent and 2 duplicate
    // results, the other is those two counts swapped. A result-after-final
    // that is not itself a duplicate result pads the smaller side, so
    // resultsAfterFinal stays 2 either way. Swapping the two fields in the
    // summary makes each digest equal the other's expected summary.
    const shared = {
      stateChecked: 5,
      stateBad: 0,
      journalKeys: 5,
      resultsAfterFinal: 2,
      orphanResults: 0,
      unreconciledIntents: 0,
    };
    const intents1Results2 = { ...shared, duplicateIntents: 1, duplicateResults: 2 };
    const intents2Results1 = { ...shared, duplicateIntents: 2, duplicateResults: 1 };
    const withKeys = (keys: readonly (readonly [string, readonly SyntheticStep[]])[]): Fixture => {
      const fixture = cleanFixture(DAY);
      for (const [key, steps] of keys) {
        fixture.journalEntries.push(...syntheticKey(key, steps));
      }
      return fixture;
    };
    const harnessOne = makeHarness(withKeys([
      ['k-di', ['intent', 'intent', 'completed']],
      ['k-dr-1', ['intent', 'completed', 'refused']],
      ['k-dr-2', ['intent', 'completed', 'refused']],
      ['k-quiet', ['intent', 'completed']],
    ]), NOW);
    const harnessTwo = makeHarness(withKeys([
      ['k-di-1', ['intent', 'intent', 'completed']],
      ['k-di-2', ['intent', 'intent', 'completed']],
      ['k-dr', ['intent', 'completed', 'refused']],
      ['k-raf', ['intent', 'completed', 'ambiguous']],
    ]), NOW);
    const resultOne = await new RecordShadowDayUseCase(harnessOne.deps).execute(makeRequest());
    const resultTwo = await new RecordShadowDayUseCase(harnessTwo.deps).execute(makeRequest());
    expectRecorded(resultOne);
    expectRecorded(resultTwo);
    expect(resultOne.recorded.S9).toBe('fail');
    expect(resultTwo.recorded.S9).toBe('fail');

    const dayOne = harnessOne.evidence.stored?.days.find((entry) => entry.day === DAY);
    const dayTwo = harnessTwo.evidence.stored?.days.find((entry) => entry.day === DAY);
    const expectedOne = expectedS9Digest(DAY, 'fail', 'journal-duplicate-intent', intents1Results2);
    const expectedTwo = expectedS9Digest(DAY, 'fail', 'journal-duplicate-intent', intents2Results1);
    expect(expectedOne).not.toBe(expectedTwo);
    expect(dayOne?.verdicts.S9).toEqual({
      verdict: 'fail',
      reason: 'journal-duplicate-intent',
      digest: expectedOne,
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayTwo?.verdicts.S9).toEqual({
      verdict: 'fail',
      reason: 'journal-duplicate-intent',
      digest: expectedTwo,
      recordedAtIso: RECORDED_AT_ISO,
    });
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
    // S1 never evaluated on this path, so `mergesCompared` stays at its
    // unset default rather than a stale or guessed count.
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.mergesCompared).toBeNull();
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
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'fail',
      reason: 'enqueue-coverage-divergence',
      digest: expectedS8Digest(DAY, 'fail', 'enqueue-coverage-divergence'),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  it('two S8 evaluations with the same status/reason but different live queue counts get the same digest (live-sample counts are excluded from S8)', async () => {
    const HEAD_C = 'd'.repeat(40);

    const fixtureA = cleanFixture(DAY);
    fixtureA.shellState = {
      ...fixtureA.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `8 ${HEAD_B} main`] },
    };
    const harnessA = makeHarness(fixtureA, NOW);
    const resultA = await new RecordShadowDayUseCase(harnessA.deps).execute(makeRequest());
    expectRecorded(resultA);
    expect(resultA.recorded.S8).toBe('fail');
    const dayRecordA = harnessA.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecordA?.verdicts.S8).toEqual({
      verdict: 'fail',
      reason: 'enqueue-coverage-divergence',
      digest: expectedS8Digest(DAY, 'fail', 'enqueue-coverage-divergence'),
      recordedAtIso: RECORDED_AT_ISO,
    });

    const fixtureB = cleanFixture(DAY);
    fixtureB.shellState = {
      ...fixtureB.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `8 ${HEAD_B} main`, `9 ${HEAD_C} main`] },
    };
    const harnessB = makeHarness(fixtureB, NOW);
    const resultB = await new RecordShadowDayUseCase(harnessB.deps).execute(makeRequest());
    expectRecorded(resultB);
    expect(resultB.recorded.S8).toBe('fail');
    const dayRecordB = harnessB.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecordB?.verdicts.S8).toEqual({
      verdict: 'fail',
      reason: 'enqueue-coverage-divergence',
      digest: expectedS8Digest(DAY, 'fail', 'enqueue-coverage-divergence'),
      recordedAtIso: RECORDED_AT_ISO,
    });

    // Same {status, reason} pair in both ('fail'/'enqueue-coverage-divergence'),
    // even though the underlying shell-side coverage changed (one missing
    // key vs two): the eight live counts are excluded from S8's digest, so
    // the digests must be equal and a re-run against moved live queue state
    // no longer reports a spurious 'verdict-conflict' for the same verdict.
    expect(dayRecordA?.verdicts.S8?.digest).toBe(dayRecordB?.verdicts.S8?.digest);
  });

  it('answers unchanged when only the live queue grew between two S8 passes with the same verdict (live-sample counts excluded from the S8 digest)', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const afterFirst = harness.evidence.stored;
    const casCallsAfterFirst = harness.evidence.calls.cas;
    const s1VerdictBefore = afterFirst?.days.find((entry) => entry.day === DAY)?.verdicts.S1;

    // A later deadline: the two S8 samples' real (faked) 150s wall-clock
    // gaps of two runs would otherwise cross this request's deadline.
    fixture.shellState = {
      ...fixture.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `8 ${HEAD_B} main`] },
    };
    fixture.queueEntries.push({
      entryId: ulid(3),
      pullRequest: 8,
      headOid: HEAD_B,
      state: 'queued',
      repository: REPOSITORY,
      repoDigest: REPO_DIGEST,
    } as unknown as MergeQueueEntryRecord);
    fixture.importKeys.push({ pullRequest: 8, headOid: HEAD_B, base: 'main', source: 'queue', disposition: 'would-import' });

    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));
    expect(result.outcome).toBe('unchanged');
    expect(result.recorded.S8).toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'pass',
      reason: 'intake-equal',
      digest: expectedS8Digest(DAY, 'pass', 'intake-equal'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    // The idempotent re-run must not call compareAndSet again: doing so
    // with `next` at the same revision as `expectedRevision` would be a
    // malformed CAS request per ShadowEvidencePort's contract.
    expect(harness.evidence.calls.cas).toBe(casCallsAfterFirst);
    expect(harness.evidence.stored).toEqual(afterFirst);
    // Queued entries are not merged PRs in S1's merge set, so S1's digest is unaffected.
    expect(dayRecord?.verdicts.S1).toEqual(s1VerdictBefore);
  });

  it('refuses an S8 pass->fail verdict flip between runs with verdict-conflict and leaves the ledger untouched', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const before = harness.evidence.stored;

    // A shell live entry the fleet queue never sees, so S8 flips from
    // 'pass'/'intake-equal' to 'fail'/'enqueue-coverage-divergence'.
    fixture.shellState = {
      ...fixture.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `8 ${HEAD_B} main`] },
    };
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored).toEqual(before);
    expect(harness.evidence.stored?.revision).toBe(1);
  });

  it('two days with the same S12 pass/ticks-within-budget and different tick counts get different digests', async () => {
    const fewerDay = DAY;
    const moreDay = '2026-11-15';
    const fewerFixture = cleanFixture(fewerDay);
    const moreFixture = cleanFixture(moreDay);
    const fewer = { ...fewerFixture, daemonEvents: fewerFixture.daemonEvents.slice(0, 720) };
    const more = { ...moreFixture, daemonEvents: moreFixture.daemonEvents.slice(0, 721) };
    const harnessFewer = makeHarness(fewer, NOW);
    const harnessMore = makeHarness(more, NOW);
    const resultFewer = await new RecordShadowDayUseCase(harnessFewer.deps).execute(makeRequest({ day: fewerDay }));
    const resultMore = await new RecordShadowDayUseCase(harnessMore.deps).execute(makeRequest({ day: moreDay }));
    expectRecorded(resultFewer);
    expectRecorded(resultMore);
    expect(resultFewer.recorded.S12).toBe('pass');
    expect(resultMore.recorded.S12).toBe('pass');

    const digestFewer = harnessFewer.evidence.stored?.days.find((entry) => entry.day === fewerDay)?.verdicts.S12?.digest;
    const digestMore = harnessMore.evidence.stored?.days.find((entry) => entry.day === moreDay)?.verdicts.S12?.digest;
    expect(digestFewer).toBe(expectedS12Digest(fewerDay, 'pass', 'ticks-within-budget', {
      totalTicks: 720,
      budgetOverruns: 0,
      starvedJobs: 0,
    }));
    expect(digestMore).toBe(expectedS12Digest(moreDay, 'pass', 'ticks-within-budget', {
      totalTicks: 721,
      budgetOverruns: 0,
      starvedJobs: 0,
    }));
    expect(digestFewer).not.toBe(digestMore);
  });

  it('equivalent S12 event sets in different orders produce the same digest', async () => {
    const forward = cleanFixture(DAY);
    const reversed = {
      ...cleanFixture(DAY),
      daemonEvents: cleanFixture(DAY).daemonEvents.slice().reverse(),
    };
    const harnessForward = makeHarness(forward, NOW);
    const harnessReversed = makeHarness(reversed, NOW);
    const resultForward = await new RecordShadowDayUseCase(harnessForward.deps).execute(makeRequest());
    const resultReversed = await new RecordShadowDayUseCase(harnessReversed.deps).execute(makeRequest());
    expectRecorded(resultForward);
    expectRecorded(resultReversed);

    const expected = expectedS12Digest(DAY, 'pass', 'ticks-within-budget', {
      totalTicks: 800,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    const digestForward = harnessForward.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S12?.digest;
    const digestReversed = harnessReversed.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S12?.digest;
    expect(digestForward).toBe(expected);
    expect(digestReversed).toBe(expected);
    expect(digestForward).toBe(digestReversed);
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

  it("evaluates S8 normally, not forced into shell-state-incomplete, when batchesEnabled: { status: 'absent' } (SH7b fix round 4 — corrects the round-2 'finding 1' test above, which wrongly asserted this same ordinary case as incomplete)", async () => {
    const fixture = cleanFixture(DAY);
    // The field itself is present (not undefined, which is the genuinely
    // unknown case per its own doc comment) and reports 'absent': a shell
    // with no batching configured has no `batches/enabled` file at all, a
    // confident known-empty read exactly like `cutover.ts`'s own handling
    // of this field (`batchesEnabled.status === 'absent' ? 0 : ...`), never
    // "unreadable or missing" (only 'unreadable' and `undefined` are that).
    // Both samples' shell reads are otherwise clean, so S8 must reach a
    // real comparison, not an early incomplete-bailout.
    fixture.shellState = { ...fixture.shellState, batchesEnabled: { status: 'absent' } };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    expect(result.recorded).toEqual({ S1: 'pass', S8: 'pass', S9: 'pass', S12: 'pass' });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'pass',
      reason: 'intake-equal',
      digest: expectedS8Digest(DAY, 'pass', 'intake-equal'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it("evaluates S8 normally, not forced into shell-state-incomplete, when inprogress: { status: 'absent' } (an idle shell train with no in-progress head file, not unknown evidence; SH7b fix round 4)", async () => {
    const fixture = cleanFixture(DAY);
    // The field itself is present (not undefined) and reports 'absent': an
    // idle shell train has no in-progress head file at all, a confident
    // known-empty read, never "unreadable or missing" — only 'unreadable'
    // triggers incomplete for this source, matching `parsedShellSource`'s
    // corrected handling and `cutover.ts`'s own treatment of this field.
    fixture.shellState = { ...fixture.shellState, inprogress: { status: 'absent' } };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    expect(result.recorded).toEqual({ S1: 'pass', S8: 'pass', S9: 'pass', S12: 'pass' });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    // A real pass reached by comparison, not an early incomplete-bailout:
    // the full verdict (status, reason, digest and its counts) matches the
    // clean fixture's own S8 verdict exactly, since an absent `inprogress`
    // contributes the same zero keys the clean fixture's empty-lines
    // `inprogress` already contributed.
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'pass',
      reason: 'intake-equal',
      digest: expectedS8Digest(DAY, 'pass', 'intake-equal'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('deduplicates shellLive to one entry, not two, when the same (pullRequest, headOid, base) key appears in both queue and inprogress — the documented crash-leftover case, a single live PR, not a real duplicate (SH7b fix round 4)', async () => {
    const fixture = cleanFixture(DAY);
    // `cutover.ts`'s own doc comment on the `inprogress` field: the shell
    // train head "has left the queue but has not merged", so the SAME
    // PR/head can legitimately still be named by a stale `queue` line left
    // over from an earlier crash. The clean fixture's queue already names
    // PR 7 on `main`; naming it again on `inprogress` reproduces exactly
    // that overlap, not two distinct live PRs.
    fixture.shellState = {
      ...fixture.shellState,
      inprogress: { status: 'read', lines: [`7 ${HEAD_A} main`] },
    };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    // Undeduplicated, the comparator would see PR 7 twice on the shell side
    // and report it as an `invalid-item` divergence shared by both
    // samples, which fails S8 with a false `enqueue-coverage-divergence`
    // from this documented overlap alone. Deduplicated, the shell side
    // carries PR 7 exactly once — identical to the clean fixture's own
    // single-entry comparison — and S8 reaches the same real pass.
    expect(result.recorded).toEqual({ S1: 'pass', S8: 'pass', S9: 'pass', S12: 'pass' });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'pass',
      reason: 'intake-equal',
      digest: expectedS8Digest(DAY, 'pass', 'intake-equal'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('keeps the documented queue/inprogress overlap collapsed to one entry, not two — same key in BOTH queue and inprogress, nowhere else (SH7b fix round 5; re-verifying round 4\'s own case still holds under the narrowed fix)', async () => {
    const fixture = cleanFixture(DAY);
    // Identical to round 4's own case: the clean fixture's queue already
    // names PR 7 on `main`; naming it again on `inprogress` reproduces the
    // documented crash-leftover overlap, nowhere else.
    fixture.shellState = {
      ...fixture.shellState,
      inprogress: { status: 'read', lines: [`7 ${HEAD_A} main`] },
    };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    // Collapsed to one entry: the shell side carries PR 7 exactly once,
    // identical to the clean fixture's own single-entry comparison, so S8
    // reaches the same real pass — not a false divergence from a normal,
    // documented shell state alone.
    expect(result.recorded).toEqual({ S1: 'pass', S8: 'pass', S9: 'pass', S12: 'pass' });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toEqual({
      verdict: 'pass',
      reason: 'intake-equal',
      digest: expectedS8Digest(DAY, 'pass', 'intake-equal'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('does NOT collapse the same key appearing TWICE within queue alone, nowhere else — a genuine duplicate, not the documented overlap, must still trip compareShadowEnqueueSets\'s invalid-item detection (SH7b fix round 5)', async () => {
    const fixture = cleanFixture(DAY);
    // The SAME queue line twice: not a queue/inprogress overlap (inprogress
    // stays empty), and not a parked/queue overlap either — a plain,
    // same-source repeat, which is the genuine anomaly
    // `compareShadowEnqueueSets`'s own duplicate detection is designed to
    // catch. Left broadly deduplicated (round 4's bug), this would collapse
    // to one entry and S8 would wrongly record a clean pass, hiding a real
    // anomaly in the shell's own queue file.
    fixture.shellState = {
      ...fixture.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `7 ${HEAD_A} main`] },
    };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    // Both occurrences reach the comparator untouched, so its own
    // same-side duplicate detection fires: PR 7's identity is excluded from
    // both sides' maps and reported as an `invalid-item` divergence,
    // persistent across both samples, which fails S8 with a real
    // `enqueue-coverage-divergence` — never a false pass from a silently
    // hidden duplicate.
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8?.verdict).toBe('fail');
    expect(dayRecord?.verdicts.S8?.reason).toBe('enqueue-coverage-divergence');
  });

  it('does NOT collapse the same key appearing in both parked and queue — an undocumented, unapproved cross-source overlap, must still trip the same invalid-item detection (SH7b fix round 5)', async () => {
    const fixture = cleanFixture(DAY);
    // PR 7/HEAD_A/main named on `parked` (the shell's 6-field record: `pr
    // head reason attempt notBefore base`) AND on `queue` (unchanged from
    // the clean fixture), nowhere on `inprogress`. Only the queue/inprogress
    // combination is documented as a legitimate overlap (`cutover.ts`'s own
    // doc comment on the `inprogress` field) — a parked/queue repeat is not
    // that case, and must be treated exactly like any other genuine
    // duplicate.
    fixture.shellState = {
      ...fixture.shellState,
      parked: { status: 'read', lines: [`7 ${HEAD_A} retry-timeout 0 0 main`] },
    };
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    // Same mechanics as the within-queue duplicate above: both occurrences
    // reach the comparator untouched, PR 7's identity is excluded from both
    // sides' maps and reported `invalid-item`, persistent across both
    // samples, failing S8 for real — never silently hidden by a dedupe that
    // reaches past the one documented combination.
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8?.verdict).toBe('fail');
    expect(dayRecord?.verdicts.S8?.reason).toBe('enqueue-coverage-divergence');
  });

  it('reports S8 unevaluated, not a false import-divergence, when the import dry-run report is truncated (SH7b finding 2)', async () => {
    const fixture = cleanFixture(DAY);
    // Two shell live entries on `main`, both samples; the import dry-run is
    // truncated and reports only one of them, which (uncorrected) would
    // make `importPresent` permanently miss the second and manufacture a
    // persistent import-fidelity divergence instead of surfacing that the
    // report was capped.
    fixture.shellState = {
      ...fixture.shellState,
      queue: { status: 'read', lines: [`7 ${HEAD_A} main`, `8 ${HEAD_B} main`] },
    };
    const harness = makeHarness(fixture, NOW);
    const truncatedKeys: ImportTrainStateKey[] = [
      { pullRequest: 7, headOid: HEAD_A, base: 'main', source: 'queue', disposition: 'would-import' },
    ];
    // Built directly, not via `dryRunImport` + spread: spreading its
    // declared union return type (`ImportTrainStateResult`) onto a new
    // literal fails type-checking, since one union member (`refused`) has
    // no `keysTruncated` field to merge an override onto.
    const truncatedImport: ImportTrainStateResult = {
      outcome: 'dry-run',
      wouldImport: truncatedKeys.length,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 0,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      inprogressLines: 0,
      unknownBySource: { queue: [], parked: [], inprogress: [] },
      keys: truncatedKeys,
      keysTruncated: true,
    };
    harness.setImportDryRun(truncatedImport);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S8')).toBe('shell-state-incomplete');
    expect(result.recorded.S8).toBeUndefined();
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('reports S8 unevaluated, not a false coverage-divergence failure, when the fleet queue read throws on both samples (SH7b finding 3)', async () => {
    const fixture = cleanFixture(DAY);
    // The clean fixture's shell AND import sides already report PR 7 live;
    // with the fleet read throwing on every sample, an empty `fleetLive`
    // (uncorrected) would be mistaken for "genuinely zero live entries" and
    // manufacture a persistent, false coverage divergence against that key.
    const harness = makeHarness(fixture, NOW);
    harness.setQueueThrows();
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S8')).toBe('shell-state-incomplete');
    expect(result.recorded.S8).toBeUndefined();
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
