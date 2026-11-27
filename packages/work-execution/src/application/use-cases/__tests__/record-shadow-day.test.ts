// Lane SH7b: RecordShadowDayUseCase exercised directly with fakes for every
// dependency — no CLI, no composition (that is SH8a).
import { describe, expect, it } from 'vitest';

import type { CutoverShadowCriterion } from '../../../domain/cutover-records.js';
import type { DaemonEventRecord } from '../../../domain/daemon-events.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey, buildMergeKey, laneRunPremergeKey } from '../../../domain/lane-run-keys.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import {
  recordShadowAttestation,
  SHADOW_ATTESTATION_FACTS,
  SHADOW_ONE_TIME_REQUIREMENTS,
  type ShadowAttestationLedger,
} from '../../../domain/shadow-attestations.js';
import type { ShadowLedger } from '../../../domain/shadow-evidence-ledger.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import type { ImportTrainStateKey, ImportTrainStateResult } from '../../ports/in/ImportTrainStatePort.in-port.js';
import type { ChainListCommand, ChainRepositoryPort } from '../../ports/out/ChainRepositoryPort.out-port.js';
import type { LegacyTrainEventsRead, LegacyTrainStateRead } from '../../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { ShadowAttestationPort } from '../../ports/out/ShadowAttestationPort.out-port.js';
import type { ReleaseStorePort } from '../../ports/out/ReleaseStorePort.out-port.js';
import type {
  ShadowConformanceRunsDependencies,
  ShadowGateHeadsDependencies,
} from '../shadow-day/index.js';
import {
  readShadowConformanceRuns,
} from '../shadow-day/index.js';
import { extractShadowShellFacts } from '../../../domain/shadow-day-shell-facts.js';
import { parseShellTrainEvents } from '../../../domain/shell-train-events.js';
import type { ShadowLedgerReadResult } from '../../ports/out/ShadowEvidencePort.out-port.js';
import type { RecordShadowDayRequest, RecordShadowDayResult } from '../../ports/in/RecordShadowDayPort.in-port.js';
import {
  RecordShadowDayUseCase,
  evaluateShadowGrantCoverage,
  type RecordShadowDayDependencies,
} from '../RecordShadowDayUseCase.use-case.js';

const OWNER = 'octo';
const REPO = 'train';
const REPOSITORY = { owner: OWNER, repo: REPO };
const REPO_DIGEST = '0123456789ab';
const LEGACY_STATE_DIR = '/state/legacy';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_D = 'd'.repeat(40);
const HEAD_E = 'e'.repeat(40);
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
/** Empty since SH23: S13 left the shadow window for the retirement gate, so no criterion is stubbed. */
const NOT_IMPLEMENTED: readonly CutoverShadowCriterion[] = [];

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

/** A shell `head-moved` whose `from <40hex>` detail the facts extractor pairs. */
function shellHeadMovedLine(atIso: string, pr: number, fromHeadOid: string, toHeadOid: string): string {
  return JSON.stringify({
    at: atIso,
    kind: 'head-moved',
    outcome: 'moved',
    pr,
    headOid: toHeadOid,
    detail: `from ${fromHeadOid}`,
  });
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
  /** SH24b: a result's linked head oid (a `would-merge`/`would-supersede` successor head). */
  readonly linkedId?: string;
  /** SH24b fix: the journal record's `runId` (a run identity, not an entry identity). */
  readonly runId?: string;
  readonly recordedAtIso: string;
}

function journalEntry(init: JournalEntryInit): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId: ulid(1),
    kind: init.kind,
    key: init.key,
    runId: init.runId ?? null,
    recordedAtIso: init.recordedAtIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: (init.outcome as LaneRunJournalEntryRecord['outcome']) ?? null,
    reasonCode: init.reasonCode ?? null,
    detail: null,
    grantId: null,
    state: null,
    ...(init.linkedId === undefined ? {} : { linkedId: init.linkedId }),
  } as LaneRunJournalEntryRecord;
}

/** A shadow-mutation merge key (`merge/<digest>/<pr>/<head12>/<action>`), no ordinals (SH24a). */
function shadowMergeKey(
  pr: number,
  headOid: string,
  action: 'merge-pr' | 'would-drop' | 'would-park' | 'would-supersede' | 'would-already-merged',
): string {
  const built = buildMergeKey({
    repoDigest: REPO_DIGEST,
    pullRequest: pr,
    head12: headOid.slice(0, 12),
    action,
    attemptOrdinal: null,
    retry: null,
    retryProof: null,
  });
  if (!built.ok) {
    throw new Error(`fixture shadow merge key refused: ${built.error}`);
  }
  return built.key;
}

/** A still-live (`queued`) merge-queue entry the shadow pass never mutated. */
function queuedEntry(entryId: number, pr: number, headOid: string, enqueuedAtIso = `${DAY}T09:00:00.000Z`): MergeQueueEntryRecord {
  return {
    entryId: ulid(entryId),
    pullRequest: pr,
    headOid,
    state: 'queued',
    enqueuedAtIso,
    repository: REPOSITORY,
    repoDigest: REPO_DIGEST,
  } as unknown as MergeQueueEntryRecord;
}

/** A real parked (`state: 'parked'`) merge-queue entry, not a would-park result carrier. */
function parkedEntry(entryId: number, pr: number, headOid: string, enqueuedAtIso = `${DAY}T09:00:00.000Z`): MergeQueueEntryRecord {
  return { ...queuedEntry(entryId, pr, headOid, enqueuedAtIso), state: 'parked' } as unknown as MergeQueueEntryRecord;
}

/** An intent/result pair journaled for one shadow `would-*` key inside day `DAY`. */
function shadowOutcome(
  pr: number,
  headOid: string,
  action: 'merge-pr' | 'would-drop' | 'would-park' | 'would-supersede' | 'would-already-merged',
  reasonCode: string,
  atIso: string,
  linkedId?: string,
  runId?: string,
): LaneRunJournalEntryRecord[] {
  return [
    journalEntry({ kind: 'intent', key: shadowMergeKey(pr, headOid, action), recordedAtIso: atIso }),
    journalEntry({
      kind: 'result',
      key: shadowMergeKey(pr, headOid, action),
      outcome: 'dry-run',
      reasonCode,
      ...(linkedId === undefined ? {} : { linkedId }),
      ...(runId === undefined ? {} : { runId }),
      recordedAtIso: atIso,
    }),
  ];
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
      recordedAtIso: `${day}T09:59:30Z`,
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
  // OD7a3: a full day of regular one-minute ticks spanning [00:00Z, 24:00Z),
  // so the fixture meets the S12 coverage guards (last tick 23:59Z, gaps of
  // 60 s) and only coverage-specific tests need partial fixtures.
  for (let index = 0; index < 1440; index += 1) {
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
 * builds it: S9 carries only the five day-scoped, closed-day-deterministic
 * journal counts into the digest, so two evaluations landing on the same
 * {status, reason} pair with the same day-scoped journal shape are
 * indistinguishable to it, while the live samples (`stateChecked`, `stateBad`,
 * `unreconciledIntents`) are not.
 */
function expectedS9Digest(day: string, status: string, reason: string, counts: {
  journalKeys: number;
  duplicateIntents: number;
  duplicateResults: number;
  resultsAfterFinal: number;
  orphanResults: number;
}): string {
  return sha256HexDigest(
    JSON.stringify({
      criterion: 'S9',
      day,
      status,
      reason,
      journalKeys: counts.journalKeys,
      duplicateIntents: counts.duplicateIntents,
      duplicateResults: counts.duplicateResults,
      resultsAfterFinal: counts.resultsAfterFinal,
      orphanResults: counts.orphanResults,
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

/**
 * The canonical S4' summary digest, rebuilt here exactly as the use case
 * builds it: four day-scoped counts plus `headsDigest`, the digest over
 * every head's four identifying fields in the reader's own order
 * (`pushedAtIso`, then `headOid`). `unsettled` is excluded: an unsettled
 * head always leaves the day unevaluated, so every head on an evaluated day
 * is settled.
 */
function expectedS4Digest(
  day: string,
  status: string,
  reason: string,
  counts: { compared: number; agreeing: number; falsePasses: number; stricterFails: number },
  heads: readonly { headOid: string; conductorVerdict: string; pushedAtIso: string; ciGate: string }[],
): string {
  const ordered = [...heads].sort((a, b) =>
    a.pushedAtIso !== b.pushedAtIso ? (a.pushedAtIso < b.pushedAtIso ? -1 : 1) : a.headOid < b.headOid ? -1 : a.headOid > b.headOid ? 1 : 0,
  );
  const headsDigest = sha256HexDigest(
    JSON.stringify(
      ordered.map((head) => ({
        headOid: head.headOid,
        conductorVerdict: head.conductorVerdict,
        pushedAtIso: head.pushedAtIso,
        ciGate: head.ciGate,
      })),
    ),
  );
  return sha256HexDigest(
    JSON.stringify({
      criterion: 'S4',
      day,
      status,
      reason,
      compared: counts.compared,
      agreeing: counts.agreeing,
      falsePasses: counts.falsePasses,
      stricterFails: counts.stricterFails,
      headsDigest,
    }),
  );
}

/**
 * The canonical S6' summary digest: base only — every S6' count depends on
 * `readShadowConformanceRuns`, which reads live stores not time-bounded to
 * day `D`, so the counts are excluded and stay on the outcome as
 * non-digested diagnostics.
 */
function expectedS6Digest(day: string, status: string, reason: string): string {
  return sha256HexDigest(JSON.stringify({ criterion: 'S6', day, status, reason }));
}

/** The canonical S7 summary digest: base only, like S8 — both counts are live. */
function expectedS7Digest(day: string, status: string, reason: string): string {
  return sha256HexDigest(JSON.stringify({ criterion: 'S7', day, status, reason }));
}

/**
 * The canonical S5' summary digest: the base plus `compared` only. Per the
 * 2026-11-18 owner decision `compared` counts the resolved (`carry`/
 * `no-carry`) day-scoped decisions only, so it is resolver-dependent —
 * deterministic at `0` while the composition pins the resolver to
 * `'unknown'`. The unresolved diagnostics (`unresolvedCount`,
 * `unresolvedIds`) and the per-decision answers (`laxCarries`,
 * `stricterNoCarries`) stay on the outcome as non-digested diagnostics, so a
 * rerun whose only difference is which decisions stayed unresolved cannot
 * silently become a verdict conflict.
 */
function expectedS5Digest(day: string, status: string, reason: string, compared: number): string {
  return sha256HexDigest(JSON.stringify({ criterion: 'S5', day, status, reason, compared }));
}

/* -------------------------------------------------------------------------
 * SH19a: fakes for the conducted-facts readers (SH18a/SH18b) and the chain
 * store, driving the REAL `readShadowGateHeads` and `readShadowConformanceRuns`
 * application readers — no `vi.mock`.
 * ------------------------------------------------------------------------- */

/** A distinct 40-hex head oid carrying `n` in its tail. */
function oid(n: number): string {
  return `${'9'.repeat(36)}${n.toString(16).padStart(4, '0')}`;
}

/** A valid lane-run id (`run-` + ULID). */
function runId(n: number): string {
  return `run-${ulid(n)}`;
}

/** A step key `<runId>/r1/<step>/0@<head12>` as the readers parse it. */
function stepKey(id: string, step: 'push' | 'gate', headOid: string): string {
  const built = buildLaneRunStepKey({
    runId: id,
    round: 1,
    step,
    seatIndex: 0,
    attemptOrdinal: null,
    head12: headOid.slice(0, 12),
    retry: null,
  });
  if (!built.ok) {
    throw new Error(`fixture step key refused: ${built.error}`);
  }
  return built.key;
}

/** The premerge receipt key `<runId>/r1/premerge@<head12>`. */
function premergeKey(id: string, headOid: string): string {
  const built = laneRunPremergeKey(id, 1, headOid.slice(0, 12));
  if (!built.ok) {
    throw new Error(`fixture premerge key refused: ${built.error}`);
  }
  return built.key;
}

/** One conducted gate head the S4' reader assembles. */
interface GateHeadSpec {
  readonly headOid: string;
  readonly conductorVerdict: 'pass' | 'fail';
  readonly pushedAtIso: string;
  readonly ciGate: string;
}

/** One conducted run the S6' reader assembles. */
interface ConformanceRunSpec {
  readonly pr: number;
  readonly tier: 1 | 2;
  readonly headOid: string;
  /** `null` omits the premerge entry (rule 5 then refuses). */
  readonly premergeAtIso: string | null;
}

interface ConductedOptions {
  readonly gateHeads?: readonly GateHeadSpec[];
  readonly conformanceRuns?: readonly ConformanceRunSpec[];
  /** `unavailable` makes every forge read refuse (`forge-unavailable`). */
  readonly forgeOutcome?: 'found' | 'unavailable';
  /** Per-sha CI state override, for a later CI change between two runs. */
  readonly ciOverride?: Map<string, string>;
  /** The receipts read throws (`receipts-unavailable`). */
  readonly receiptsThrow?: boolean;
  /**
   * Collects, one per forge `readCommitContext` call, the deadline the
   * `readShadowGateHeads` reader derived for it (`nowIso` + `timeoutMs`):
   * the reader never hands a fake port the raw `deadlineIso`, only this
   * derived timeout, so the deadline is recorded reconstructed.
   */
  readonly forgeDeadlines?: string[];
}

/**
 * The combined conducted-facts dependency set: one store of runs, journals,
 * attempts, receipts and forge reads that the REAL readers consume. Every
 * conformance run's journal carries a `gate-passed` result at its own head
 * (rule 2) and — when `premergeAtIso` is set — a premerge success posted
 * before the merge (rule 5); every gate head's journal carries a completed
 * `push` (so the head reached the pull request) and its conductor gate
 * verdict. Conformance runs pass rules 3/4 through default passing receipts.
 */
function conductedFacts(options: ConductedOptions): ShadowConformanceRunsDependencies & ShadowGateHeadsDependencies {
  const runs: Record<string, unknown>[] = [];
  const journals = new Map<string, LaneRunJournalEntryRecord[]>();
  const attempts = new Map<string, { readonly artifacts: { readonly headCommit: string } | null }>();
  const receiptsByAttempt = new Map<string, readonly { kind: string; result: string }[]>();
  const ciBySha = new Map<string, string>();
  for (const spec of options.gateHeads ?? []) {
    ciBySha.set(spec.headOid, spec.ciGate);
  }
  let nextRun = 0;

  for (const spec of options.conformanceRuns ?? []) {
    const id = runId(100 + (nextRun += 1));
    runs.push({ runId: id, prNumber: spec.pr, tier: spec.tier, attemptIds: [`att-${spec.pr}`] });
    attempts.set(`att-${spec.pr}`, { artifacts: { headCommit: spec.headOid } });
    const entries = [
      journalEntry({
        kind: 'result',
        key: stepKey(id, 'gate', spec.headOid),
        outcome: 'completed',
        reasonCode: 'gate-passed',
        recordedAtIso: `${DAY}T08:00:00Z`,
      }),
    ];
    if (spec.premergeAtIso !== null) {
      entries.push(
        journalEntry({
          kind: 'result',
          key: premergeKey(id, spec.headOid),
          outcome: 'completed',
          reasonCode: 'premerge-success',
          recordedAtIso: spec.premergeAtIso,
        }),
      );
    }
    journals.set(id, entries);
    const reviews: { kind: string; result: string }[] = [{ kind: 'code-review', result: 'pass' }];
    if (spec.tier === 2) {
      reviews.push({ kind: 'pre-merge', result: 'pass' });
    }
    receiptsByAttempt.set(`att-${spec.pr}`, reviews);
  }

  for (const [index, spec] of (options.gateHeads ?? []).entries()) {
    const id = runId(100 + (nextRun += 1));
    runs.push({ runId: id, prNumber: 100_000 + index, tier: 1, attemptIds: [`att-g${index}`] });
    attempts.set(`att-g${index}`, { artifacts: { headCommit: spec.headOid } });
    journals.set(id, [
      journalEntry({
        kind: 'result',
        key: stepKey(id, 'push', spec.headOid),
        outcome: 'completed',
        recordedAtIso: spec.pushedAtIso,
      }),
      journalEntry({
        kind: 'result',
        key: stepKey(id, 'gate', spec.headOid),
        outcome: 'completed',
        reasonCode: spec.conductorVerdict === 'pass' ? 'gate-passed' : 'gate-failed',
        recordedAtIso: spec.pushedAtIso,
      }),
    ]);
  }

  return {
    runs: { list: async () => runs } as unknown as ShadowConformanceRunsDependencies['runs'],
    journal: {
      listForRuns: async (ids: readonly string[]) => {
        const grouped = new Map<string, readonly LaneRunJournalEntryRecord[]>();
        for (const id of ids) {
          const entries = journals.get(id);
          if (entries === undefined) {
            throw new Error(`fixture journal missing for ${id.length} char id`);
          }
          grouped.set(id, entries);
        }
        return grouped;
      },
    } as unknown as ShadowConformanceRunsDependencies['journal'],
    attempts: {
      findAttemptById: async (attemptId: string) => attempts.get(attemptId) ?? null,
    } as unknown as ShadowConformanceRunsDependencies['attempts'],
    receipts: {
      readReceiptsForHead: async (attemptId: string, headSha: string) => {
        if (options.receiptsThrow) {
          throw new Error('receipt store failed');
        }
        return {
          outcome: 'found' as const,
          verification: [],
          review: (receiptsByAttempt.get(attemptId) ?? []).map((receipt) => ({
            kind: receipt.kind,
            result: receipt.result,
            headSha,
          })),
        };
      },
    } as unknown as ShadowConformanceRunsDependencies['receipts'],
    forge: {
      readCommitContext: async (command: { headSha: string; timeoutMs?: number }) => {
        if (options.forgeDeadlines !== undefined && typeof command.timeoutMs === 'number') {
          options.forgeDeadlines.push(new Date(Date.parse(NOW) + command.timeoutMs).toISOString());
        }
        if (options.forgeOutcome === 'unavailable') {
          return { outcome: 'unavailable' };
        }
        return {
          outcome: 'found' as const,
          headSha: command.headSha,
          state: options.ciOverride?.get(command.headSha) ?? ciBySha.get(command.headSha) ?? 'success',
        };
      },
    } as unknown as ShadowGateHeadsDependencies['forge'],
    nowIso: () => NOW,
  };
}

/**
 * The chain store S7 lists: one fake record per given state, or a failing
 * store. `deadlineRecorder` (fix round: the deadline must be asserted)
 * collects the `deadlineIso` of every `listChains` call in order.
 */
function chainStore(
  statesOrFailure: readonly string[] | 'throws' | 'unreadable',
  deadlineRecorder?: string[],
): Pick<ChainRepositoryPort, 'listChains'> {
  return {
    listChains: async (command: ChainListCommand) => {
      deadlineRecorder?.push(command.deadlineIso);
      if (statesOrFailure === 'throws') {
        throw new Error('chain store failed');
      }
      if (statesOrFailure === 'unreadable') {
        return { status: 'unreadable' as const, reason: 'store-unreadable' };
      }
      return {
        status: 'ok' as const,
        records: statesOrFailure.map((state) => ({ state })) as never,
      };
    },
  };
}

/** The five merged pull requests whose conducted runs pass S6's floor. */
const CONFORMANCE_PRS: readonly { pr: number; tier: 1 | 2 }[] = [
  { pr: 7, tier: 1 },
  { pr: 8, tier: 1 },
  { pr: 9, tier: 1 },
  { pr: 10, tier: 2 },
  { pr: 11, tier: 2 },
];

function conformanceHeadOid(pr: number): string {
  return oid(500 + pr);
}

function conformanceMergeAtIso(pr: number): string {
  return `${DAY}T09:${String(10 + pr).padStart(2, '0')}:00Z`;
}

/**
 * A clean fixture extended to five in-window shell merges (pr 7 from the
 * clean fixture at 10:00, pr 8..11 earlier), each matched by a fleet journal
 * merge entry, so S1 still passes while S6' has five merged runs.
 */
function conformingFixture(): Fixture {
  const fixture = cleanFixture(DAY);
  for (const { pr } of CONFORMANCE_PRS) {
    if (pr === 7) {
      continue;
    }
    const headOid = conformanceHeadOid(pr);
    const atIso = conformanceMergeAtIso(pr);
    fixture.shellLines.push(shellResultLine(atIso, pr, headOid));
    const key = mergeKeyFor(pr, headOid);
    fixture.journalEntries.push(
      journalEntry({
        kind: 'intent',
        key,
        recordedAtIso: new Date(Date.parse(atIso) - 60_000).toISOString(),
      }),
      journalEntry({
        kind: 'result',
        key,
        outcome: 'dry-run',
        reasonCode: 'would-merge',
        recordedAtIso: new Date(Date.parse(atIso) - 30_000).toISOString(),
      }),
    );
    // S1 resolves a journaled would-merge's head against the LIVE queue
    // entries, so each extra merged pull request must also be live — on all
    // three S8 sides at once (shell queue line, fleet queue entry, import
    // dry-run key), or S8 would report a divergence instead.
    fixture.queueEntries.push({
      entryId: ulid(20 + pr),
      pullRequest: pr,
      headOid,
      state: 'queued',
      repository: REPOSITORY,
      repoDigest: REPO_DIGEST,
    } as unknown as MergeQueueEntryRecord);
    fixture.shellState = {
      ...fixture.shellState,
      queue: { status: 'read', lines: [...fixture.shellState.queue.status === 'read' ? fixture.shellState.queue.lines : [], `${pr} ${headOid} main`] },
    };
    fixture.importKeys.push({ pullRequest: pr, headOid, base: 'main', source: 'queue', disposition: 'would-import' });
  }
  return fixture;
}

function conformanceRunSpecs(): ConformanceRunSpec[] {
  return CONFORMANCE_PRS.map(({ pr, tier }) => ({
    pr,
    tier,
    headOid: pr === 7 ? HEAD_A : conformanceHeadOid(pr),
    premergeAtIso: `${DAY}T08:0${pr - 7}:00Z`,
  }));
}

/** Thirty agreeing gate heads (conductor pass, CI success), pushed on day D. */
function agreeingGateHeads(seed: number, count = 30): GateHeadSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    headOid: oid(seed + index),
    conductorVerdict: 'pass' as const,
    pushedAtIso: `${DAY}T07:${String(index).padStart(2, '0')}:00Z`,
    ciGate: 'success',
  }));
}

/**
 * `RecordShadowDayDependencies` declares the optional new dependencies
 * readonly, so tests set them through these escape hatches.
 */
function setConducted(
  harness: Harness,
  facts: ShadowConformanceRunsDependencies & ShadowGateHeadsDependencies,
  repository: { readonly owner: string; readonly repo: string } = REPOSITORY,
): void {
  (harness.deps as { conducted?: NonNullable<RecordShadowDayDependencies['conducted']> }).conducted = { repository, facts };
}

function setChains(harness: Harness, chains: Pick<ChainRepositoryPort, 'listChains'> | undefined): void {
  (harness.deps as { chains?: Pick<ChainRepositoryPort, 'listChains'> }).chains = chains;
}

type PremergeCarryAnswer = 'carry' | 'no-carry' | 'unknown';

function setPremergeCarry(
  harness: Harness,
  premergeCarry: NonNullable<RecordShadowDayDependencies['premergeCarry']> | undefined,
): void {
  (harness.deps as { premergeCarry?: RecordShadowDayDependencies['premergeCarry'] }).premergeCarry = premergeCarry;
}

/** A resolver that answers every decision the same way, recording what it saw. */
function constantPremergeCarry(
  answer: PremergeCarryAnswer,
  calls?: { readonly decisions: unknown[]; readonly deadlines: string[] },
): NonNullable<RecordShadowDayDependencies['premergeCarry']> {
  return async (input) => {
    if (calls !== undefined) {
      calls.decisions.push(input.decision);
      calls.deadlines.push(input.deadlineIso);
    }
    return answer;
  };
}

/** A resolver answering per pull request; an unlisted PR reads as `unknown`. */
function prMapPremergeCarry(
  answers: Readonly<Record<number, PremergeCarryAnswer>>,
): NonNullable<RecordShadowDayDependencies['premergeCarry']> {
  return async (input) => answers[input.decision.pullRequest] ?? 'unknown';
}

/** A resolver that throws on every call: the use case must read that as `unknown`. */
function throwingPremergeCarry(): NonNullable<RecordShadowDayDependencies['premergeCarry']> {
  return async () => {
    throw new Error('resolver failed');
  };
}

/* -------------------------------------------------------------------------
 * SH19b2: fakes for the one-time shadow criteria's sources — the sticky
 * attestation ledger store (SH16's read) and SH17's release-file inspector.
 * ------------------------------------------------------------------------- */

/** The deduplicated required test paths, in the criteria's own fixed order. */
const REQUIRED_TEST_PATHS: readonly string[] = [
  ...new Set(Object.values(SHADOW_ONE_TIME_REQUIREMENTS).flatMap((requirement) => [...requirement.tests])),
];

/** The canonical one-time summary digest: base only, like S8. */
function expectedOneTimeDigest(criterion: 'S2' | 'S3' | 'S10' | 'S11', day: string, status: string, reason: string): string {
  return sha256HexDigest(JSON.stringify({ criterion, day, status, reason }));
}

/** A valid attestation ledger carrying every one-time fact, observed on `observedDay`. */
function attestationLedger(observedDay: string = DAY): ShadowAttestationLedger {
  let ledger: unknown = null;
  for (const fact of SHADOW_ATTESTATION_FACTS) {
    const write = recordShadowAttestation(ledger, {
      fact,
      observedDay,
      releaseSha: RELEASE,
      reason: 'one-time-evidence',
      digest: 'e'.repeat(64),
      recordedAtIso: `${observedDay}T09:00:00.000Z`,
    });
    if (!write.ok) {
      throw new Error(`fixture attestation refused for ${fact.length} char fact`);
    }
    ledger = write.ledger;
  }
  return ledger as ShadowAttestationLedger;
}

/** Every required test present under the verified build, never quarantined.
 *
 * SH17's real `files` items are POSITIONAL and carry no `path`, so the fake's
 * items must not carry one either — the use case zips `files[i]` onto
 * `paths[i]` itself.
 */
function presentReleaseFiles(): { readonly present: boolean; readonly quarantined: boolean | null }[] {
  return REQUIRED_TEST_PATHS.map(() => ({ present: true, quarantined: false }));
}

interface OneTimeCalls {
  read: number;
  inspect: number;
  inputs: unknown[];
}

interface OneTimeOptions {
  /** The attestations store's `read` result; may throw or return anything. */
  read?: () => unknown;
  /** The release store's `inspectReleaseFiles` result; may throw or return anything. */
  inspect?: (input: { root: string; sha: string; paths: readonly string[] }) => unknown;
  /** The one release root the day's pinned sha is verified under. */
  releaseRoot?: string;
  /** Omits `inspectReleaseFiles` entirely (the optional method is absent). */
  omitInspect?: boolean;
}

/** The default one-time dependency set: a missing ledger store and a fully present release tree. */
function makeOneTime(options: OneTimeOptions = {}): NonNullable<RecordShadowDayDependencies['oneTime']> & { calls: OneTimeCalls } {
  const calls: OneTimeCalls = { read: 0, inspect: 0, inputs: [] };
  return {
    calls,
    attestations: {
      read: (async () => {
        calls.read += 1;
        if (options.read !== undefined) {
          return options.read() as Awaited<ReturnType<Pick<ShadowAttestationPort, 'read'>['read']>>;
        }
        return { status: 'missing' as const };
      }) as Pick<ShadowAttestationPort, 'read'>['read'],
    },
    releaseStore: (options.omitInspect === true
      ? {}
      : {
          inspectReleaseFiles: (async (input: { root: string; sha: string; paths: readonly string[] }) => {
            calls.inspect += 1;
            calls.inputs.push(input);
            if (options.inspect !== undefined) {
              return options.inspect(input);
            }
            return { outcome: 'read' as const, files: presentReleaseFiles() };
          }) as unknown as NonNullable<Pick<ReleaseStorePort, 'inspectReleaseFiles'>['inspectReleaseFiles']>,
        }) as Pick<ReleaseStorePort, 'inspectReleaseFiles'>,
    releaseRoot: options.releaseRoot ?? '/state/releases',
  };
}

function setOneTime(harness: Harness, oneTime: RecordShadowDayDependencies['oneTime']): void {
  (harness.deps as { oneTime?: RecordShadowDayDependencies['oneTime'] }).oneTime = oneTime;
}

/** The reasons map every one-time criterion is reported under. */
function unevaluatedReasons(result: RecordedResult): Map<CutoverShadowCriterion, string> {
  return new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
}

/**
 * One shell carry decision as a paired event pair: an update intent naming
 * the old head, then a `result`/`updated` line whose `detail` classifies the
 * update as carried or not carried.
 */
function shellCarryPair(
  intentAtIso: string,
  resultAtIso: string,
  pr: number,
  oldHeadOid: string,
  newHeadOid: string,
  carried: boolean,
): readonly [string, string] {
  return [
    JSON.stringify({ at: intentAtIso, kind: 'intent', outcome: 'update-branch', pr, headOid: oldHeadOid }),
    JSON.stringify({
      at: resultAtIso,
      kind: 'result',
      outcome: 'updated',
      pr,
      headOid: newHeadOid,
      detail: carried ? 'premerge carried (success)' : 'not carried: manual conflict',
    }),
  ];
}

/** A clean fixture with one in-day shell carry decision for pr 12 (carried). */
function carryFixture(): Fixture {
  const fixture = cleanFixture(DAY);
  fixture.shellLines.push(...shellCarryPair(`${DAY}T09:04:00Z`, `${DAY}T09:05:00Z`, 12, HEAD_B, HEAD_D, true));
  return fixture;
}

/** The fully wired harness for the passing fixture. */
function wiredHarness(fixture: Fixture, options: ConductedOptions = {}, chainStates: readonly string[] = ['landed', 'refused']): Harness {
  const harness = makeHarness(fixture, NOW);
  setConducted(harness, conductedFacts(options));
  setChains(harness, chainStore(chainStates));
  return harness;
}

/** Every not-yet-built criterion is always in `unevaluated`, exactly once, and S13 is never listed. */
function expectNotImplementedUnevaluated(
  unevaluated: readonly { criterion: CutoverShadowCriterion; reason: string }[],
): void {
  const reasons = new Map(unevaluated.map((entry) => [entry.criterion, entry.reason]));
  for (const criterion of NOT_IMPLEMENTED) {
    expect(reasons.get(criterion)).toBe('not-implemented');
  }
  expect(unevaluated.filter((entry) => entry.reason === 'not-implemented')).toHaveLength(NOT_IMPLEMENTED.length);
  // SH23: S13 moved to the retirement gate, so it is never recorded and never unevaluated.
  expect(reasons.has('S13')).toBe(false);
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
        journalKeys: 1,
        duplicateIntents: 0,
        duplicateResults: 0,
        resultsAfterFinal: 0,
        orphanResults: 0,
      }),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S12?.digest).toBe(expectedS12Digest(DAY, 'pass', 'ticks-within-budget', {
      totalTicks: 1440,
      budgetOverruns: 0,
      starvedJobs: 0,
    }));
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('two S9 evaluations with the same pass/state-consistent and different stateChecked get the same digest', async () => {
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
      journalKeys: 1,
      duplicateIntents: 0,
      duplicateResults: 0,
      resultsAfterFinal: 0,
      orphanResults: 0,
    };
    expect(digestFewer).toBe(expectedS9Digest(DAY, 'pass', 'state-consistent', shared));
    expect(digestMore).toBe(expectedS9Digest(DAY, 'pass', 'state-consistent', shared));
    // The live state-check sample is excluded from the S9 digest, so the two
    // runs hash the same summary despite different `stateChecked`.
    expect(digestFewer).toBe(digestMore);
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
      journalKeys: 5,
      resultsAfterFinal: 2,
      orphanResults: 0,
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

  it('answers unchanged when only next-day journal entries and the live state check changed between two S9 passes', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const afterFirst = harness.evidence.stored;
    const casCallsAfterFirst = harness.evidence.calls.cas;

    // Next-day journal activity on a non-merge key (S1 is untouched) and a
    // changed live state-check sample: both are outside S9's day-scoped
    // digest, so the re-run answers unchanged instead of verdict-conflict.
    fixture.journalEntries.push(
      journalEntry({ kind: 'intent', key: 'k-next-day', recordedAtIso: '2026-11-17T01:00:00Z' }),
      journalEntry({ kind: 'result', key: 'k-next-day', outcome: 'completed', recordedAtIso: '2026-11-17T01:01:00Z' }),
    );
    fixture.stateCheck = { checked: 9, bad: 0 };
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));
    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S9).toEqual({
      verdict: 'pass',
      reason: 'state-consistent',
      digest: expectedS9Digest(DAY, 'pass', 'state-consistent', {
        journalKeys: 1,
        duplicateIntents: 0,
        duplicateResults: 0,
        resultsAfterFinal: 0,
        orphanResults: 0,
      }),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(harness.evidence.calls.cas).toBe(casCallsAfterFirst);
    expect(harness.evidence.stored).toEqual(afterFirst);
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('answers unchanged when a same-key result lands just after the day boundary between two S9 passes', async () => {
    // Proves the `ms < dayEndMs` filter: without it, the appended D+1 result
    // on k-d would be a result-after-final sequence anomaly (and would add
    // day-foreign counts to the digest), turning this re-run into a
    // verdict-conflict instead of unchanged.
    const fixture = cleanFixture(DAY);
    fixture.journalEntries.push(...syntheticKey('k-d', ['intent', 'completed']));
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());

    fixture.journalEntries.push(
      journalEntry({ kind: 'result', key: 'k-d', outcome: 'refused', recordedAtIso: '2026-11-17T01:00:00Z' }),
    );
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));
    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S9).toEqual({
      verdict: 'pass',
      reason: 'state-consistent',
      digest: expectedS9Digest(DAY, 'pass', 'state-consistent', {
        journalKeys: 2,
        duplicateIntents: 0,
        duplicateResults: 0,
        resultsAfterFinal: 0,
        orphanResults: 0,
      }),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  it('refuses an in-day S9 journal change between runs with verdict-conflict and leaves the ledger untouched', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const before = harness.evidence.stored;

    // A new key with entries inside day D changes S9's day-scoped journalKeys
    // (1 -> 2) while verdict and reason stay equal: the digest differs, so the
    // re-run is refused and the ledger stays untouched.
    fixture.journalEntries.push(...syntheticKey('k-in-day', ['intent', 'completed']));
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored).toEqual(before);
    expect(harness.evidence.stored?.revision).toBe(1);
  });

  it('refuses an S9 pass->fail state-check flip between runs with verdict-conflict and leaves the ledger untouched', async () => {
    const fixture = cleanFixture(DAY);
    const harness = makeHarness(fixture, NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const before = harness.evidence.stored;

    // stateChecked/stateBad are excluded from the S9 digest, but the live
    // status/reason in the digest base still flip (pass/state-consistent ->
    // fail/state-check-failed), so the re-run is a deliberate
    // verdict-conflict, not a silent overwrite.
    fixture.stateCheck = { checked: 5, bad: 1 };
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored).toEqual(before);
    expect(harness.evidence.stored?.revision).toBe(1);
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

  it('SH24b: S1 resolves a superseded entry in-memory successor head from the journaled would-merge linkedId and S8 drops the would-superseded stale entry', async () => {
    const fixture = cleanFixture(DAY);
    const SUCCESSOR = HEAD_E;
    // The predecessor stays unmutated in merge-queue.json, but its
    // `would-supersede` result removes it from the shadow-effective live set.
    fixture.queueEntries.push(queuedEntry(3, 8, HEAD_B));
    fixture.journalEntries.push(
      ...shadowOutcome(8, HEAD_B, 'would-supersede', 'would-supersede', `${DAY}T10:01:00Z`),
      // The unpersisted in-memory successor: only the journaled `would-merge`
      // result (key head12 + `linkedId`) names its full 40-hex head.
      ...shadowOutcome(8, SUCCESSOR, 'merge-pr', 'would-merge', `${DAY}T10:02:00Z`, SUCCESSOR),
    );
    // The shell merged the successor, so S1's fleet set must resolve its
    // head — from `linkedId` via the supplement, not from the queue.
    fixture.shellLines.push(shellResultLine(`${DAY}T10:03:00Z`, 8, SUCCESSOR));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    // Without the `linkedId` supplement S1 reports `fleet-head-unresolved`;
    // without the `would-supersede` exclusion the stale predecessor enters
    // S1's fleet set (extra-in-fleet) and S8's `fleetLive` (a false,
    // sticky enqueue-coverage-divergence against a shell that never saw it).
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('pass');
  });

  it('SH24b: S8 excludes would-drop and would-already-merged entries from fleetLive so no sticky enqueue-coverage-divergence is recorded', async () => {
    const fixture = cleanFixture(DAY);
    // A dropped entry (every drop reason journals `would-drop`) and a
    // forge-confirmed merged PR (`buildMergedEntry` has no production
    // caller, so `isMergeQueueEntryLive` alone keeps it live): both stay
    // unmutated in merge-queue.json but are no longer shadow-effectively
    // live. The shell never enqueued either.
    fixture.queueEntries.push(queuedEntry(3, 9, HEAD_D));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-drop', 'would-drop', `${DAY}T10:01:00Z`));
    fixture.queueEntries.push(queuedEntry(4, 10, HEAD_E));
    fixture.journalEntries.push(
      ...shadowOutcome(10, HEAD_E, 'would-already-merged', 'would-already-merged', `${DAY}T10:02:00Z`),
    );
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('pass');
  });

  it('SH24b: an ordinary parked entry stays live and still diverges S8 exactly as on main', async () => {
    const fixture = cleanFixture(DAY);
    // `would-park` is not a shadow-terminal action: the journaled result
    // must NOT exclude the entry, so S8 still sees it as a fleet-side live
    // entry the shell never had and records the divergence.
    fixture.queueEntries.push(queuedEntry(3, 9, HEAD_D));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-park', 'would-park', `${DAY}T10:01:00Z`));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('SH24b: an interrupted would-drop intent closed as dry-run/shadow-intent-closed keeps the entry live in both S1 and S8', async () => {
    const fixture = cleanFixture(DAY);
    fixture.queueEntries.push(queuedEntry(3, 8, HEAD_B));
    fixture.journalEntries.push(
      // `closeOpenShadowIntents`'s closed interrupted intent: same
      // `would-drop` key, but reason `shadow-intent-closed` — never an
      // executed shadow mutation, so the entry must stay live.
      ...shadowOutcome(8, HEAD_B, 'would-drop', 'shadow-intent-closed', `${DAY}T10:01:00Z`),
      // The pass later recorded a real `would-merge` for the still-live
      // entry; the shell merged it, so S1 can only pass if the entry stayed
      // live in the head-resolution index (else `fleet-head-unresolved`).
      // The result deliberately carries NO `linkedId`: with one, S1 would
      // resolve the head through the supplement and the S1 half would be
      // vacuous — here S1 depends on liveness itself.
      ...shadowOutcome(8, HEAD_B, 'merge-pr', 'would-merge', `${DAY}T10:02:00Z`),
    );
    fixture.shellLines.push(shellResultLine(`${DAY}T10:03:00Z`, 8, HEAD_B));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    // S1 pass proves S1 liveness (head resolution), and S8's divergence
    // proves S8 liveness: HEAD_B is still in fleetLive while the shell
    // never enqueued it — wrongly excluding it would make S8 pass.
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
  });

  it('SH24b: a would-drop exclusion is bound to its own queue entry — a re-enqueue at the same head after the drop is live again', async () => {
    const fixture = cleanFixture(DAY);
    // The drop was journaled BEFORE this entry was enqueued: the record
    // predates the entry's `enqueuedAtIso`, so it cannot belong to THIS
    // entry (it named an earlier incarnation of the same key) and the
    // re-enqueued entry must be LIVE again — S8 must diverge, not pass.
    fixture.queueEntries.push(queuedEntry(3, 9, HEAD_D, `${DAY}T10:30:00.000Z`));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-drop', 'would-drop', `${DAY}T10:01:00Z`));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('SH24b fix: an equal timestamp with the SAME runId on entry and result keeps the entry live — a runId binds nothing, S8 diverges, never falsely passes', async () => {
    const fixture = cleanFixture(DAY);
    // The drop was journaled at EXACTLY this entry's `enqueuedAtIso`: an
    // equal timestamp cannot establish which incarnation of the key the
    // result belongs to. Even though the result carries the entry's own
    // (non-null) `runId`, a re-enqueue can reuse a `runId`, so it is not an
    // entry identity and must not exclude — the entry stays LIVE and S8
    // must diverge, not pass.
    fixture.queueEntries.push({ ...queuedEntry(3, 9, HEAD_D, `${DAY}T10:01:00.000Z`), runId: 'run-eq-1' } as unknown as MergeQueueEntryRecord);
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-drop', 'would-drop', `${DAY}T10:01:00.000Z`, undefined, 'run-eq-1'));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('SH24b: a would-drop result recorded 1 ms after the entry enqueue excludes the entry — S8 passes', async () => {
    const fixture = cleanFixture(DAY);
    // The drop was journaled strictly after this entry's `enqueuedAtIso` by
    // exactly 1 ms: the record is bound to THIS entry, the entry is
    // excluded from `fleetLive`, and S8 passes against the clean shell.
    fixture.queueEntries.push(queuedEntry(3, 9, HEAD_D, `${DAY}T10:01:00.000Z`));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-drop', 'would-drop', `${DAY}T10:01:00.001Z`));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S8).toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'pass' });
  });

  it('SH24b fix: an unparseable enqueue timestamp keeps the entry live even though the result parses — S8 diverges, never falsely passes', async () => {
    const fixture = cleanFixture(DAY);
    // The entry's `enqueuedAtIso` does not parse: the record cannot be bound
    // to the entry via the strictly-after rule (fail-closed), so the entry
    // stays LIVE — S8 must diverge, not pass, even though the result's own
    // timestamp is a valid instant strictly after the enqueue instant.
    fixture.queueEntries.push(queuedEntry(3, 9, HEAD_D, 'not-a-timestamp'));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-drop', 'would-drop', `${DAY}T10:01:00.001Z`));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('SH24b fix: an unparseable result timestamp keeps the entry live even though the enqueue timestamp parses — S8 diverges, never falsely passes', async () => {
    const fixture = cleanFixture(DAY);
    // The result's `recordedAtIso` does not parse: the strictly-after rule
    // cannot bind the record to the entry (fail-closed), so the entry stays
    // LIVE — S8 must diverge, not pass, and no timestamp arithmetic on an
    // unparsable value may silently exclude it.
    fixture.queueEntries.push(queuedEntry(3, 9, HEAD_D, `${DAY}T10:01:00.000Z`));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'would-drop', 'would-drop', 'not-a-timestamp'));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    // The unparseable result timestamp also makes S1's merge-set input
    // structurally invalid (a fleet result must carry a zoned ISO
    // `recordedAtIso`), so S1 is refused as unevaluated — itself a
    // fail-closed outcome, never a false pass.
    expect(result.unevaluated).toContainEqual({ criterion: 'S1', reason: 'invalid-input' });
    expect(result.recorded.S1).toBeUndefined();
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('SH24b: a real parked entry (state parked, no would-park result) stays live in S1 and S8', async () => {
    const fixture = cleanFixture(DAY);
    // A genuinely `parked` queue entry — not a queued entry carrying a
    // would-park result. `would-park` is not shadow-terminal and ordinary
    // parks never exclude, so the entry counts as live in both criteria:
    // S8 sees it in `fleetLive` (divergence against a shell that never
    // enqueued it), and S1 resolves the journaled would-merge's head12
    // against it — the result carries no `linkedId`, so S1 can only pass
    // through the live-entry index (else `fleet-head-unresolved`).
    fixture.queueEntries.push(parkedEntry(3, 9, HEAD_D));
    fixture.journalEntries.push(...shadowOutcome(9, HEAD_D, 'merge-pr', 'would-merge', `${DAY}T10:02:00Z`));
    fixture.shellLines.push(shellResultLine(`${DAY}T10:03:00Z`, 9, HEAD_D));
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S8).toMatchObject({ verdict: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it("SH24b: readLiveEntries' would-terminal exclusion keeps a dropped entry out of S1's head-resolution index — the stale would-merge cannot resolve", async () => {
    const fixture = cleanFixture(DAY);
    // One entry, dropped after a same-day would-merge dry-run was already
    // journaled for its head: the pass recorded `would-merge` at 10:00 and
    // the entry was then dropped at 10:01 (its `would-drop` is at or after
    // the entry's enqueue, so the exclusion binds to THIS entry). The
    // correct shadow rule keeps the dropped entry out of `readLiveEntries`'s
    // index, so the stale `would-merge` cannot resolve its head12 and S1
    // refuses with `fleet-head-unresolved`. If `readLiveEntries` ignored the
    // would-terminal exclusion, the dropped entry would stay in the index,
    // the stale result would resolve, and S1 would answer
    // `merge-set-divergence` (extra-in-fleet against a shell that never
    // merged) instead — so the pinned reason fails under that mutation.
    fixture.queueEntries.push(queuedEntry(3, 8, HEAD_B));
    fixture.journalEntries.push(
      ...shadowOutcome(8, HEAD_B, 'merge-pr', 'would-merge', `${DAY}T10:00:00Z`),
      ...shadowOutcome(8, HEAD_B, 'would-drop', 'would-drop', `${DAY}T10:01:00Z`),
    );
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S1).toMatchObject({ verdict: 'fail', reason: 'fleet-head-unresolved' });
  });

  it('SH24b: interrupted would-supersede and would-already-merged intents closed as dry-run/shadow-intent-closed keep their entries live in S1 and S8', async () => {
    const fixture = cleanFixture(DAY);
    fixture.queueEntries.push(queuedEntry(3, 8, HEAD_B), queuedEntry(4, 9, HEAD_D));
    fixture.journalEntries.push(
      // Closed interrupted intents on the other two shadow-terminal keys:
      // same keys an executed mutation would carry, but reason
      // `shadow-intent-closed` — never an executed shadow mutation, so
      // both entries stay live. Each entry also has a real `would-merge`
      // with NO `linkedId`, so S1's pass depends on the entry staying in
      // the head-resolution index (else `fleet-head-unresolved`).
      ...shadowOutcome(8, HEAD_B, 'would-supersede', 'shadow-intent-closed', `${DAY}T10:01:00Z`),
      ...shadowOutcome(8, HEAD_B, 'merge-pr', 'would-merge', `${DAY}T10:02:00Z`),
      ...shadowOutcome(9, HEAD_D, 'would-already-merged', 'shadow-intent-closed', `${DAY}T10:01:00Z`),
      ...shadowOutcome(9, HEAD_D, 'merge-pr', 'would-merge', `${DAY}T10:02:00Z`),
    );
    fixture.shellLines.push(
      shellResultLine(`${DAY}T10:03:00Z`, 8, HEAD_B),
      shellResultLine(`${DAY}T10:03:00Z`, 9, HEAD_D),
    );
    const harness = makeHarness(fixture, NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    // S1 pass proves S1 liveness (head resolution through the index), and
    // S8's divergence proves S8 liveness: both entries stay in `fleetLive`
    // while the shell never enqueued them — wrongly excluding them would
    // make S1 fail and S8 pass.
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S8).toBe('fail');
  });

  it('SH24b: when the journal prefix read is unavailable S1 is unevaluated with fleet-journal-unavailable and S8 is incomplete, never a pass', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    delete (harness.deps.journal as unknown as Partial<Record<string, unknown>>).listForKeyPrefix;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S1')).toBe('fleet-journal-unavailable');
    // S8 marks its samples incomplete (complete = false), so the evaluation
    // lands in unevaluated as unknown — never a manufactured pass.
    expect(reasons.get('S8')).toBe('shell-state-incomplete');
    expect(result.recorded.S8).toBeUndefined();
    expectNotImplementedUnevaluated(result.unevaluated);
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
    expectRecorded(result);
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
    // OD7a3: both days span the whole day so the S12 coverage guards hold;
    // the tick counts differ (720 vs 721 distinct in-day tick ids).
    const fewer = { ...fewerFixture, daemonEvents: fewerFixture.daemonEvents.filter((_, index) => index % 2 === 0) };
    const more = {
      ...moreFixture,
      daemonEvents: [...moreFixture.daemonEvents.filter((_, index) => index % 2 === 0), moreFixture.daemonEvents[1439]],
    };
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
      totalTicks: 1440,
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
      if (result.outcome === 'refused' || result.outcome === 'unknown' || result.outcome === 'skipped') {
        continue;
      }
      expectNotImplementedUnevaluated(result.unevaluated);
      const evaluated = new Set(Object.keys(result.recorded));
      for (const criterion of NOT_IMPLEMENTED) {
        expect(evaluated.has(criterion)).toBe(false);
      }
      // SH23: S13 is no longer recorded on any day.
      expect(evaluated.has('S13')).toBe(false);
    }
  });

  /* ----------------------------------------------------------------------
   * SH19a: S4', S6' and S7.
   * ---------------------------------------------------------------------- */

  it('records S1, S4, S6, S7, S8, S9 and S12 as passes in one CAS when every new dependency is wired', async () => {
    const gateHeads = agreeingGateHeads(0);
    const harness = wiredHarness(conformingFixture(), {
      gateHeads,
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);

    expect(result.outcome).toBe('recorded');
    expect(result.recorded).toEqual({
      S1: 'pass',
      S4: 'pass',
      S6: 'pass',
      S7: 'pass',
      S8: 'pass',
      S9: 'pass',
      S12: 'pass',
    });
    expect(result.revision).toBe(1);
    expect(harness.evidence.calls.cas).toBe(1);
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S4).toEqual({
      verdict: 'pass',
      reason: 'gate-verdicts-agree',
      digest: expectedS4Digest(DAY, 'pass', 'gate-verdicts-agree', {
        compared: 30,
        agreeing: 30,
        falsePasses: 0,
        stricterFails: 0,
      }, gateHeads),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S6).toEqual({
      verdict: 'pass',
      reason: 'conducted-runs-conform',
      digest: expectedS6Digest(DAY, 'pass', 'conducted-runs-conform'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S7).toEqual({
      verdict: 'pass',
      reason: 'chains-not-kept',
      digest: expectedS7Digest(DAY, 'pass', 'chains-not-kept'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('keeps the S1, S8, S9 and S12 digests byte-identical to origin/main when no new dependency is wired', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({ S1: 'pass', S8: 'pass', S9: 'pass', S12: 'pass' });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S1?.digest).toBe(expectedS1Digest(DAY, 'pass', 'merge-set-equal', {
      mergesCompared: 1,
      excludedBatchMerges: 0,
      compared: 1,
      divergences: 0,
    }));
    expect(dayRecord?.verdicts.S8?.digest).toBe(expectedS8Digest(DAY, 'pass', 'intake-equal'));
    expect(dayRecord?.verdicts.S9?.digest).toBe(expectedS9Digest(DAY, 'pass', 'state-consistent', {
      journalKeys: 1,
      duplicateIntents: 0,
      duplicateResults: 0,
      resultsAfterFinal: 0,
      orphanResults: 0,
    }));
    expect(dayRecord?.verdicts.S12?.digest).toBe(expectedS12Digest(DAY, 'pass', 'ticks-within-budget', {
      totalTicks: 1440,
      budgetOverruns: 0,
      starvedJobs: 0,
    }));
  });

  it('answers unchanged on a rerun with identical facts and every new dependency wired, without a second CAS', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const afterFirst = harness.evidence.stored;
    const casCallsAfterFirst = harness.evidence.calls.cas;

    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));
    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    expect(result.revision).toBe(1);
    expect(harness.evidence.calls.cas).toBe(casCallsAfterFirst);
    expect(harness.evidence.stored).toEqual(afterFirst);
  });

  it('reports S4 and S6 as not-wired when the conducted dependency is absent, leaving the others unchanged', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    setChains(harness, chainStore(['landed', 'refused']));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({ S1: 'pass', S7: 'pass', S8: 'pass', S9: 'pass', S12: 'pass' });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('not-wired');
    expect(reasons.get('S6')).toBe('not-wired');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('reports S7 as not-wired when the chains dependency is absent, leaving S4 and S6 passing', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setChains(harness, undefined);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({
      S1: 'pass', S4: 'pass', S6: 'pass', S8: 'pass', S9: 'pass', S12: 'pass',
    });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S7')).toBe('not-wired');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('reports S4 and S6 as repository-not-conducted when the request repository differs from the conducted repository', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setConducted(
      harness,
      conductedFacts({ gateHeads: agreeingGateHeads(0), conformanceRuns: conformanceRunSpecs() }),
      { owner: 'other', repo: 'train' },
    );
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({
      S1: 'pass', S7: 'pass', S8: 'pass', S9: 'pass', S12: 'pass',
    });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('repository-not-conducted');
    expect(reasons.get('S6')).toBe('repository-not-conducted');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('reports S4 unevaluated with the reader reason when the forge read is unavailable, still passing S6', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
      forgeOutcome: 'unavailable',
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBeUndefined();
    expect(result.recorded.S6).toBe('pass');
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('forge-unavailable');
  });

  it('reports S4 unevaluated (gate-comparison-incomplete) for more than 50 diverging heads through the real evaluator', async () => {
    const diverging = Array.from({ length: 51 }, (_, index) => ({
      headOid: oid(2_000 + index),
      conductorVerdict: 'fail' as const,
      pushedAtIso: `${DAY}T07:${String(index).padStart(2, '0')}:00Z`,
      ciGate: 'success',
    }));
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: diverging,
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('gate-comparison-incomplete');
  });

  it('reports S4 unevaluated (gate-heads-unsettled), never a pass, when a passing evaluation carries one unsettled head', async () => {
    const gateHeads = [
      ...agreeingGateHeads(0),
      { headOid: oid(900), conductorVerdict: 'pass' as const, pushedAtIso: `${DAY}T07:30:00Z`, ciGate: 'pending' },
    ];
    const harness = wiredHarness(conformingFixture(), {
      gateHeads,
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('gate-heads-unsettled');
  });

  it('reports S4 unevaluated (gate-heads-unsettled) when a failing evaluation carries one unsettled head', async () => {
    const gateHeads = [
      { headOid: oid(901), conductorVerdict: 'fail' as const, pushedAtIso: `${DAY}T07:00:00Z`, ciGate: 'success' },
      { headOid: oid(900), conductorVerdict: 'pass' as const, pushedAtIso: `${DAY}T07:01:00Z`, ciGate: 'pending' },
    ];
    const harness = wiredHarness(conformingFixture(), {
      gateHeads,
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('gate-heads-unsettled');
  });

  it('reports S4 unevaluated (no-settled-heads), never pass or fail, when zero conducted heads exist in the window', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: [],
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S4')).toBe('no-settled-heads');
    // Owner decision 2026-11-18: never `pass`, never `fail`. Every other
    // criterion still records, with byte-identical digests.
    expect(result.recorded).toEqual({
      S1: 'pass',
      S6: 'pass',
      S7: 'pass',
      S8: 'pass',
      S9: 'pass',
      S12: 'pass',
    });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S4).toBeUndefined();
    // Byte-identical digests: the zero-settled refusal changes nothing for
    // any other criterion. Compare against a twin run on the same fixture
    // where 30 settled heads exist and S4 records a pass.
    const twin = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const twinResult = await new RecordShadowDayUseCase(twin.deps).execute(makeRequest());
    expectRecorded(twinResult);
    expect(twinResult.recorded.S4).toBe('pass');
    const twinRecord = twin.evidence.stored?.days.find((entry) => entry.day === DAY);
    for (const criterion of ['S1', 'S6', 'S7', 'S8', 'S9', 'S12'] as const) {
      expect(dayRecord?.verdicts[criterion]).toBeDefined();
      expect(twinRecord?.verdicts[criterion]).toBeDefined();
      expect(typeof dayRecord?.verdicts[criterion]?.digest).toBe('string');
      expect(typeof twinRecord?.verdicts[criterion]?.digest).toBe('string');
      expect(dayRecord?.verdicts[criterion]?.digest).toBe(twinRecord?.verdicts[criterion]?.digest);
    }
  });

  it('reports S4 fail (too-few-agreeing-heads) when one settled agreeing head exists in the window', async () => {
    const gateHeads = agreeingGateHeads(0, 1);
    const harness = wiredHarness(conformingFixture(), {
      gateHeads,
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S4).toEqual({
      verdict: 'fail',
      reason: 'too-few-agreeing-heads',
      digest: expectedS4Digest(DAY, 'fail', 'too-few-agreeing-heads', {
        compared: 1,
        agreeing: 1,
        falsePasses: 0,
        stricterFails: 0,
      }, gateHeads),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  it('gives two S4 passes with equal counts but different head oids different digests', async () => {
    const headsA = agreeingGateHeads(0);
    const headsB = agreeingGateHeads(1_000);
    const harnessA = wiredHarness(conformingFixture(), { gateHeads: headsA, conformanceRuns: conformanceRunSpecs() });
    const harnessB = wiredHarness(conformingFixture(), { gateHeads: headsB, conformanceRuns: conformanceRunSpecs() });
    const resultA = await new RecordShadowDayUseCase(harnessA.deps).execute(makeRequest());
    const resultB = await new RecordShadowDayUseCase(harnessB.deps).execute(makeRequest());
    expectRecorded(resultA);
    expectRecorded(resultB);
    expect(resultA.recorded.S4).toBe('pass');
    expect(resultB.recorded.S4).toBe('pass');
    const digestA = harnessA.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S4?.digest;
    const digestB = harnessB.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S4?.digest;
    const counts = { compared: 30, agreeing: 30, falsePasses: 0, stricterFails: 0 };
    expect(digestA).toBe(expectedS4Digest(DAY, 'pass', 'gate-verdicts-agree', counts, headsA));
    expect(digestB).toBe(expectedS4Digest(DAY, 'pass', 'gate-verdicts-agree', counts, headsB));
    expect(digestA).not.toBe(digestB);
  });

  it('refuses a rerun whose S4 head later changed CI state with verdict-conflict and leaves the ledger untouched', async () => {
    const ciOverride = new Map<string, string>();
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
      ciOverride,
    });
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S4).toBe('pass');
    const before = harness.evidence.stored;

    // A later CI change on one settled head flips S4 from pass to a false
    // pass on day D while the counts' shape changes too: a deliberate
    // verdict-conflict, never a silent overwrite.
    ciOverride.set(oid(0), 'failure');
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored).toEqual(before);
    expect(harness.evidence.stored?.revision).toBe(1);
  });

  it('records S4 as a fail (gate-false-pass) for a false pass pushed on day D', async () => {
    const gateHeads = [
      { headOid: oid(7), conductorVerdict: 'pass' as const, pushedAtIso: `${DAY}T07:00:00Z`, ciGate: 'failure' },
    ];
    const harness = wiredHarness(conformingFixture(), {
      gateHeads,
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S4).toEqual({
      verdict: 'fail',
      reason: 'gate-false-pass',
      digest: expectedS4Digest(DAY, 'fail', 'gate-false-pass', {
        compared: 1,
        agreeing: 0,
        falsePasses: 1,
        stricterFails: 0,
      }, gateHeads),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  /**
   * A fixture whose shell carries one merge the fleet never would-merged
   * (pr 90): S1 fails with exactly one `missing-in-fleet` divergence.
   */
  function divergentFixture(): Fixture {
    const fixture = conformingFixture();
    fixture.shellLines.push(shellResultLine(`${DAY}T11:00:00Z`, 90, HEAD_E));
    return fixture;
  }

  const S1_DIVERGENCE = {
    totalCount: 1,
    items: [{ pr: 90, head12: HEAD_E.slice(0, 12), side: 'shell', code: 'missing-in-fleet' }],
  };

  it('surfaces S1, S4 and S6 divergenceDiagnostics on RecordShadowDayResult only for evaluated criteria with divergences', async () => {
    const gateHeads = [
      ...agreeingGateHeads(0),
      { headOid: oid(90), conductorVerdict: 'pass' as const, pushedAtIso: `${DAY}T07:30:00Z`, ciGate: 'failure' },
    ];
    const harness = wiredHarness(divergentFixture(), {
      gateHeads,
      // Run 11 loses its premerge receipt, so S6' fails with one
      // nonconforming run on D (tier 2 without a pre-merge receipt).
      conformanceRuns: conformanceRunSpecs().map((spec) => (spec.pr === 11 ? { ...spec, premergeAtIso: null } : spec)),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('fail');
    expect(result.recorded.S4).toBe('fail');
    expect(result.recorded.S6).toBe('fail');
    expect(result.divergenceDiagnostics).toEqual({
      S1: S1_DIVERGENCE,
      S4: { totalCount: 1, items: [{ pr: 0, head12: oid(90).slice(0, 12), side: 'fleet', code: 'false-pass' }] },
      S6: {
        totalCount: 1,
        items: [{ pr: 11, head12: conformanceHeadOid(11).slice(0, 12), side: 'fleet', code: 'premerge-not-posted-before-merge' }],
      },
    });
  });

  it('omits S4 and S6 from divergenceDiagnostics when conducted is absent', async () => {
    const harness = makeHarness(divergentFixture(), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBeUndefined();
    expect(result.recorded.S6).toBeUndefined();
    expect(result.divergenceDiagnostics).toEqual({ S1: S1_DIVERGENCE });
  });

  it('omits divergenceDiagnostics when criteria pass or fail to read sources', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
      // S4' cannot read the forge, so it is unevaluated, never divergent.
      forgeOutcome: 'unavailable',
      // S6' cannot read the review receipts, so it is unevaluated too, while
      // S1 passes with zero divergences on the matched fixture.
      receiptsThrow: true,
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S1).toBe('pass');
    expect(result.recorded.S4).toBeUndefined();
    expect(result.recorded.S6).toBeUndefined();
    expect(result).not.toHaveProperty('divergenceDiagnostics');
  });

  it('returns ledger-unreadable without divergenceDiagnostics when the evidence ledger cannot be read', async () => {
    const harness = makeHarness(divergentFixture(), NOW);
    harness.setLedgerRead({ status: 'unreadable' });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'ledger-unreadable' });
    expect(result).not.toHaveProperty('divergenceDiagnostics');
  });

  it('returns deadline-exceeded without divergenceDiagnostics when the deadline is reached', async () => {
    const harness = makeHarness(divergentFixture(), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ deadlineIso: PAST_DEADLINE }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(result).not.toHaveProperty('divergenceDiagnostics');
  });

  it('computes identical S1, S4 and S6 verdict digests with and without divergenceDiagnostics', async () => {
    // The day carries divergences on all three criteria, yet each digest is
    // byte-identical to the canonical summary recomputed here WITHOUT any
    // divergence diagnostics: the diagnostics are non-digested observability.
    const gateHeads = [
      ...agreeingGateHeads(0),
      { headOid: oid(90), conductorVerdict: 'pass' as const, pushedAtIso: `${DAY}T07:30:00Z`, ciGate: 'failure' },
    ];
    const harness = wiredHarness(divergentFixture(), {
      gateHeads,
      conformanceRuns: conformanceRunSpecs().map((spec) => (spec.pr === 11 ? { ...spec, premergeAtIso: null } : spec)),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S1?.digest).toBe(expectedS1Digest(DAY, 'fail', 'merge-set-divergence', {
      mergesCompared: 6,
      excludedBatchMerges: 0,
      compared: 5,
      divergences: 1,
    }));
    expect(dayRecord?.verdicts.S4?.digest).toBe(expectedS4Digest(DAY, 'fail', 'gate-false-pass', {
      compared: 31,
      agreeing: 30,
      falsePasses: 1,
      stricterFails: 0,
    }, gateHeads));
    expect(dayRecord?.verdicts.S6?.digest).toBe(expectedS6Digest(DAY, 'fail', 'premerge-not-posted-before-merge'));
  });

  it('reports S6 unevaluated (shell-events-unavailable) when the shell events read is unavailable', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    delete (harness.deps.legacy as unknown as Partial<Record<string, unknown>>).readLegacyTrainEvents;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S6')).toBe('shell-events-unavailable');
  });

  it('reports S6 unevaluated (shell-events-unavailable) when the shell events carry unknown lines', async () => {
    const fixture = conformingFixture();
    fixture.shellLines.push('not an event line');
    const harness = wiredHarness(fixture, {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S6')).toBe('shell-events-unavailable');
  });

  it('keeps closed day D S6 unchanged when a D+1 incomplete head move would otherwise alter the facts (day-end filter)', async () => {
    // The run's collected head differs from the merged head with no linking
    // head move, so S6 fails with `merged-head-unlinked`. A D+1 incomplete
    // head move for the same pull request, if not filtered to the day's own
    // end, would list the pull request in `headMovesIncompleteFor` and flip
    // the outcome to unknown (`head-moves-incomplete`) — a verdict change on
    // a closed day.
    const fixture = cleanFixture(DAY);
    const harness = wiredHarness(fixture, {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: [{ pr: 7, tier: 1, headOid: HEAD_B, premergeAtIso: null }],
    });
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S6).toBe('fail');
    const before = harness.evidence.stored;

    fixture.shellLines.push(
      JSON.stringify({ at: '2026-11-17T01:00:00Z', kind: 'head-moved', outcome: 'moved', pr: 7, headOid: HEAD_A, detail: 'x' }),
    );
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S6).toEqual({
      verdict: 'fail',
      reason: 'merged-head-unlinked',
      digest: expectedS6Digest(DAY, 'fail', 'merged-head-unlinked'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    // The rerun really re-evaluated S6: the filter excluded the D+1 event, so
    // the evaluated 'fail' verdict came back (not a skipped criterion riding
    // on the stored one). If the filter regressed to admitting every event,
    // the rerun would yield S6 unevaluated and this pair of assertions would
    // fail while the plain 'unchanged' above would still pass.
    expect(result.recorded.S6).toBe('fail');
    expect(result.unevaluated.map((entry) => entry.criterion)).not.toContain('S6');
    expect(harness.evidence.stored).toEqual(before);
  });

  it('reports S6 unevaluated (shell-merges-incomplete) for an unresolved merge inside the trailing window', async () => {
    const fixture = conformingFixture();
    fixture.shellLines.push(
      JSON.stringify({ at: '2026-11-15T10:00:00Z', kind: 'result', outcome: 'merged', pr: 0, headOid: '' }),
    );
    const harness = wiredHarness(fixture, {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S6')).toBe('shell-merges-incomplete');
  });

  it('reports S6 unevaluated with the reader reason when the receipts read is unavailable', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
      receiptsThrow: true,
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S6')).toBe('receipts-unavailable');
  });

  it('records S6 pass/conducted-runs-conform when a conducted run merged head is reached through headMoves within 32 hops', async () => {
    const pr = 8;
    const mergeHead = conformanceHeadOid(pr);
    const collectedHead = HEAD_B;
    const fixture = conformingFixture();
    // One hop, before the shell merge, from the run's collected head to the
    // merged head. Without this move the heads differ and S6 fails.
    fixture.shellLines.push(shellHeadMovedLine(`${DAY}T09:00:00Z`, pr, collectedHead, mergeHead));
    const specs = conformanceRunSpecs().map((spec) => (spec.pr === pr ? { ...spec, headOid: collectedHead } : spec));
    const harness = wiredHarness(fixture, {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: specs,
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S6).toEqual({
      verdict: 'pass',
      reason: 'conducted-runs-conform',
      digest: expectedS6Digest(DAY, 'pass', 'conducted-runs-conform'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(result.unevaluated.map((entry) => entry.criterion)).not.toContain('S6');
  });

  it('records S6 unevaluated/duplicate-run-conflict, never pass, when runs.list yields one runId with a conflicting tier', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const conducted = harness.deps.conducted;
    if (conducted === undefined) {
      throw new Error('conducted dependency missing');
    }
    const port = conducted.facts.runs as {
      list: () => Promise<readonly { readonly runId: string; readonly tier: 1 | 2 }[]>;
    };
    const originalList = port.list.bind(port);
    const echoed: { runId: string } = { runId: '' };
    port.list = async () => {
      const listed = await originalList();
      const first = listed[0];
      if (first === undefined) {
        throw new Error('fixture run missing');
      }
      echoed.runId = first.runId;
      return [...listed, { ...first, tier: first.tier === 1 ? 2 : 1 }];
    };
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBeUndefined();
    expect(result.recorded.S6).not.toBe('pass');
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S6')).toBe('duplicate-run-conflict');
    expect(echoed.runId.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.unevaluated)).not.toContain(echoed.runId);
  });

  it('records S6 fail/too-few-conforming-runs when an identical twin run is listed with four distinct conforming runs', async () => {
    // 3 Tier 1 + 1 Tier 2: below the 5-run floor. The fifth list entry is an
    // identical copy of one of those runs (same runId and the same fields),
    // so it must count once and must not become duplicate-run-conflict.
    const specs = conformanceRunSpecs().slice(0, 4);
    expect(specs.map((spec) => spec.tier)).toEqual([1, 1, 1, 2]);
    const specPrs = new Set(specs.map((spec) => spec.pr));
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: specs,
    });
    const conducted = harness.deps.conducted;
    if (conducted === undefined) {
      throw new Error('conducted dependency missing');
    }
    const port = conducted.facts.runs as {
      list: () => Promise<readonly {
        readonly runId: string;
        readonly tier: 1 | 2;
        readonly prNumber: number;
        readonly attemptIds: readonly string[];
      }[]>;
    };
    const originalList = port.list.bind(port);
    let presented = 0;
    let distinctRunIds = 0;
    port.list = async () => {
      const listed = await originalList();
      const conformance = listed.filter((run) => specPrs.has(run.prNumber));
      const first = conformance[0];
      if (first === undefined || conformance.length !== 4) {
        throw new Error('expected four distinct conforming runs');
      }
      const twin = {
        runId: first.runId,
        tier: first.tier,
        prNumber: first.prNumber,
        attemptIds: [...first.attemptIds],
      };
      expect(twin).toEqual({
        runId: first.runId,
        tier: first.tier,
        prNumber: first.prNumber,
        attemptIds: first.attemptIds,
      });
      const withTwin = [...listed, twin];
      const presentedRuns = withTwin.filter((run) => specPrs.has(run.prNumber));
      presented = presentedRuns.length;
      distinctRunIds = new Set(presentedRuns.map((run) => run.runId)).size;
      return withTwin;
    };

    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(presented).toBe(5);
    expect(distinctRunIds).toBe(4);
    expect(result.recorded.S6).toBe('fail');
    expect(result.recorded.S6).not.toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S6?.reason).toBe('too-few-conforming-runs');
    expect(dayRecord?.verdicts.S6).toEqual({
      verdict: 'fail',
      reason: 'too-few-conforming-runs',
      digest: expectedS6Digest(DAY, 'fail', 'too-few-conforming-runs'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(result.unevaluated.map((entry) => entry.criterion)).not.toContain('S6');
    expect(result.unevaluated.map((entry) => entry.reason)).not.toContain('duplicate-run-conflict');
  });

  it('records S6 fail/merged-head-unlinked, never pass, when the merged head is more than 32 headMoves away', async () => {
    const pr = 8;
    const mergeHead = conformanceHeadOid(pr);
    const hopCount = 33;
    const chain: string[] = [];
    for (let hop = 0; hop < hopCount; hop += 1) {
      chain.push(oid(3000 + hop));
    }
    chain.push(mergeHead);
    const fixture = conformingFixture();
    for (let hop = 0; hop < hopCount; hop += 1) {
      const from = chain[hop];
      const to = chain[hop + 1];
      if (from === undefined || to === undefined) {
        throw new Error('fixture hop missing');
      }
      fixture.shellLines.push(shellHeadMovedLine(`${DAY}T09:00:00Z`, pr, from, to));
    }
    const collectedHead = chain[0];
    if (collectedHead === undefined) {
      throw new Error('fixture chain missing');
    }
    const specs = conformanceRunSpecs().map((spec) => (spec.pr === pr ? { ...spec, headOid: collectedHead } : spec));
    const harness = wiredHarness(fixture, {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: specs,
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S6).toBe('fail');
    expect(result.recorded.S6).not.toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S6).toEqual({
      verdict: 'fail',
      reason: 'merged-head-unlinked',
      digest: expectedS6Digest(DAY, 'fail', 'merged-head-unlinked'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(result.unevaluated.map((entry) => entry.criterion)).not.toContain('S6');
  });

  it('reports S7 unevaluated (chain-state-unreadable), never a pass, when either side is unreadable', async () => {
    // The chain store throws.
    const throwing = wiredHarness(cleanFixture(DAY), {});
    setChains(throwing, chainStore('throws'));
    const thrownResult = await new RecordShadowDayUseCase(throwing.deps).execute(makeRequest());
    expectRecorded(thrownResult);
    const thrownReasons = new Map(thrownResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(thrownReasons.get('S7')).toBe('chain-state-unreadable');

    // The chain store answers unreadable.
    const unreadable = wiredHarness(cleanFixture(DAY), {});
    setChains(unreadable, chainStore('unreadable'));
    const unreadableResult = await new RecordShadowDayUseCase(unreadable.deps).execute(makeRequest());
    expectRecorded(unreadableResult);
    const unreadableReasons = new Map(unreadableResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(unreadableReasons.get('S7')).toBe('chain-state-unreadable');

    // The shell side's chains read is unreadable.
    const shellUnreadableFixture = cleanFixture(DAY);
    shellUnreadableFixture.shellState = {
      ...shellUnreadableFixture.shellState,
      chains: { status: 'unreadable' },
    };
    const shellUnreadable = wiredHarness(shellUnreadableFixture, {});
    const shellResult = await new RecordShadowDayUseCase(shellUnreadable.deps).execute(makeRequest());
    expectRecorded(shellResult);
    const shellReasons = new Map(shellResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(shellReasons.get('S7')).toBe('chain-state-unreadable');
  });

  it('gives two S7 runs with different live fleet and shell counts and the same verdict the same digest', async () => {
    // Side A: one inactive fleet chain and one active shell chain
    // (fleetActive 0, shellActive 1). Side B: three fleet chains, one active
    // (fleetActive 1), shell absent (shellActive 0). Same status/reason, so
    // the base-only digest must be equal.
    const shellActiveFixture = cleanFixture(DAY);
    shellActiveFixture.shellState = {
      ...shellActiveFixture.shellState,
      chains: { status: 'read', chains: [{ name: 'chain-a', lines: [] }] },
    };
    const harnessA = wiredHarness(shellActiveFixture, {}, ['landed']);
    const harnessB = wiredHarness(cleanFixture(DAY), {}, ['landed', 'refused', 'started']);
    const resultA = await new RecordShadowDayUseCase(harnessA.deps).execute(makeRequest());
    const resultB = await new RecordShadowDayUseCase(harnessB.deps).execute(makeRequest());
    expectRecorded(resultA);
    expectRecorded(resultB);
    expect(resultA.recorded.S7).toBe('fail');
    expect(resultB.recorded.S7).toBe('fail');
    const digestA = harnessA.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S7?.digest;
    const digestB = harnessB.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S7?.digest;
    expect(digestA).toBe(expectedS7Digest(DAY, 'fail', 'chain-active-while-retired'));
    expect(digestB).toBe(expectedS7Digest(DAY, 'fail', 'chain-active-while-retired'));
    expect(digestA).toBe(digestB);
  });

  it('fails S7 (chain-active-while-retired) for an active shell or fleet chain, and defers an older day', async () => {
    // An active shell chain fails the day even with no fleet chains.
    const shellActiveFixture = cleanFixture(DAY);
    shellActiveFixture.shellState = {
      ...shellActiveFixture.shellState,
      chains: { status: 'read', chains: [{ name: 'chain-a', lines: [] }] },
    };
    const shellHarness = wiredHarness(shellActiveFixture, {}, ['landed', 'refused']);
    const shellResult = await new RecordShadowDayUseCase(shellHarness.deps).execute(makeRequest());
    expectRecorded(shellResult);
    expect(shellResult.recorded.S7).toBe('fail');
    const shellDay = shellHarness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(shellDay?.verdicts.S7?.reason).toBe('chain-active-while-retired');

    // An active fleet chain fails the day too.
    const fleetHarness = wiredHarness(cleanFixture(DAY), {}, ['landed', 'intent-recorded']);
    const fleetResult = await new RecordShadowDayUseCase(fleetHarness.deps).execute(makeRequest());
    expectRecorded(fleetResult);
    expect(fleetResult.recorded.S7).toBe('fail');

    // An older day is only ever deferred: no live snapshot is taken for it.
    const olderDay = '2026-11-15';
    const olderHarness = wiredHarness(cleanFixture(olderDay), {}, ['landed', 'refused']);
    const olderResult = await new RecordShadowDayUseCase(olderHarness.deps).execute(makeRequest({ day: olderDay }));
    expectRecorded(olderResult);
    const reasons = new Map(olderResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S7')).toBe('snapshot-only-for-yesterday');
  });

  it('reads the shell events once and the shell state exactly twice per run with every new dependency wired', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(harness.otherCalls.legacy).toBe(1);
    expect(harness.otherCalls.legacyState).toBe(2);
  });

  it('refuses a rerun whose S4 verdict stays a fail while a settled head changed CI state between runs', async () => {
    // Two pushed heads whose conductor passed them but whose CI gates failed
    // them: two false passes on day D, so S4 records fail (gate-false-pass).
    const failingHeads: GateHeadSpec[] = [
      { headOid: oid(7), conductorVerdict: 'pass', pushedAtIso: `${DAY}T07:00:00Z`, ciGate: 'failure' },
      { headOid: oid(8), conductorVerdict: 'pass', pushedAtIso: `${DAY}T07:30:00Z`, ciGate: 'failure' },
    ];
    const ciOverride = new Map<string, string>();
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: failingHeads,
      conformanceRuns: conformanceRunSpecs(),
      ciOverride,
    });
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S4).toBe('fail');
    const before = harness.evidence.stored;

    // One settled head's CI state changes between runs, through the forge
    // override the reader reads. Its conductor verdict is unchanged, so the
    // day's S4 verdict stays a fail for the remaining false pass — and the
    // digest covers the heads' own fields (`headsDigest`), so the changed
    // head alone makes the rerun a verdict-conflict, never a silent
    // overwrite. (Among the two settled CI states the evaluator keeps —
    // success and failure — a single-head change also moves that head's own
    // classification, which is exactly why the heads must be in the digest.)
    ciOverride.set(oid(7), 'success');
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored).toEqual(before);
  });

  it("reports S7 unevaluated (chain-state-unreadable) when S8's state read throws so chains is undefined", async () => {
    const harness = wiredHarness(cleanFixture(DAY), {});
    (harness.deps.legacy as unknown as { readLegacyTrainState: () => Promise<never> }).readLegacyTrainState =
      async () => {
        throw new Error('legacy state read failed');
      };
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S7')).toBe('chain-state-unreadable');
  });

  it('keeps closed day D S6 passing with unchanged anomalies when a D+1 shell event would change the facts (day-end filter)', async () => {
    // D's S6 passes on the five conducted runs. A D+1 `result`/`updated`
    // event for pr 7 is an unpaired update: admitting it (dropping the
    // day-end filter) would put pr 7 in `headMovesIncompleteFor` and add a
    // D+1 `unpaired-update` anomaly, flipping the closed day's S6 to unknown
    // (`head-moves-incomplete`). The filter must exclude it from both.
    const fixture = conformingFixture();
    const harness = wiredHarness(fixture, {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S6).toBe('pass');
    const before = harness.evidence.stored;

    const dPlusOneEvent = JSON.stringify({
      at: '2026-11-17T01:00:00Z',
      kind: 'result',
      outcome: 'updated',
      pr: 7,
      headOid: HEAD_B,
      detail: 'x',
    });
    // Mutation proof: with the day's own bound applied here, the D+1 event is
    // excluded and the facts carry no anomaly for it; without the bound the
    // facts change in both the incomplete-head-move and anomaly fields.
    const parsed = parseShellTrainEvents([...fixture.shellLines, dPlusOneEvent]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const dayEndMs = Date.parse('2026-11-17T00:00:00.000Z');
      const bounded = parsed.events.filter((event) => Date.parse(event.atIso) < dayEndMs);
      const unbounded = extractShadowShellFacts(parsed.events);
      const boundedFacts = extractShadowShellFacts(bounded);
      expect(unbounded.ok && boundedFacts.ok).toBe(true);
      if (unbounded.ok && boundedFacts.ok) {
        expect(unbounded.facts.headMovesIncompleteFor).toEqual([7]);
        expect(unbounded.facts.anomalies).toEqual([{ atIso: '2026-11-17T01:00:00Z', code: 'unpaired-update' }]);
        expect(boundedFacts.facts.headMovesIncompleteFor).toEqual([]);
        expect(boundedFacts.facts.anomalies).toEqual([]);
      }
    }

    fixture.shellLines.push(dPlusOneEvent);
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    expect(result.recorded.S6).toBe('pass');
    expect(result.unevaluated.map((entry) => entry.criterion)).not.toContain('S6');
    expect(harness.evidence.stored).toEqual(before);
  });

  it('passes the request deadline to the chain store and to both conducted-facts readers', async () => {
    const chainDeadlines: string[] = [];
    const forgeDeadlines: string[] = [];
    const harness = wiredHarness(
      conformingFixture(),
      {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
        forgeDeadlines,
      },
      ['landed', 'refused'],
    );
    setChains(harness, chainStore(['landed', 'refused'], chainDeadlines));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S4).toBe('pass');
    expect(result.recorded.S6).toBe('pass');
    expect(result.recorded.S7).toBe('pass');
    const requestDeadline = makeRequest().deadlineIso as string;

    // `listChains` receives the request's deadline directly.
    expect(chainDeadlines).toEqual([requestDeadline]);

    // The gate-heads reader never hands a fake port the raw deadline, only
    // the forge timeout derived from it, so its recorded instant — the
    // reader's own clock plus that timeout — must reconstruct the deadline.
    expect(forgeDeadlines.length).toBeGreaterThan(0);
    for (const derived of forgeDeadlines) {
      expect(derived).toBe(requestDeadline);
    }

    // The conformance-runs reader compares the deadline it receives against
    // its own clock and surfaces it to no fake port, so its receipt of the
    // deadline is pinned reader-level: a past value is refused with
    // `deadline-exceeded` and the request's own deadline is not.
    const facts = conductedFacts({ conformanceRuns: conformanceRunSpecs() });
    const late = await readShadowConformanceRuns(facts, { mergedPullRequests: [7], deadlineIso: PAST_DEADLINE });
    expect(late.status).toBe('unknown');
    if (late.status === 'unknown') {
      expect(late.reason).toBe('deadline-exceeded');
    }
    const onTime = await readShadowConformanceRuns(facts, { mergedPullRequests: [7], deadlineIso: requestDeadline });
    expect(onTime.status).toBe('ok');
  });

  /* -------------------------------------------------------------------------
   * SH19b: S5' — the shell's premerge carry decisions replayed through the
   * fleet's answer, over the day-end shell facts shared with S6'.
   * ------------------------------------------------------------------------- */

  it("records S5 as pass (carry-decisions-equal) when the fleet's carry answers match the shell's", async () => {
    const calls = { decisions: [] as unknown[], deadlines: [] as string[] };
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('carry', calls));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S5).toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S5).toEqual({
      verdict: 'pass',
      reason: 'carry-decisions-equal',
      digest: expectedS5Digest(DAY, 'pass', 'carry-decisions-equal', 1),
      recordedAtIso: RECORDED_AT_ISO,
    });
    // The resolver saw the shell decision as fresh facts and the request's own deadline.
    expect(calls.decisions).toEqual([
      { pullRequest: 12, oldHeadOid: HEAD_B, newHeadOid: HEAD_D, atIso: `${DAY}T09:05:00Z`, shellCarry: 'carried' },
    ]);
    expect(calls.deadlines).toEqual([DEADLINE]);
  });

  it('records S5 as fail (carry-decision-differs) when fleet and shell carry decisions disagree', async () => {
    // The shell carried pr 12; a stricter fleet answer that did not carry it
    // is a disagreement, recorded as a definite fail — never glossed over.
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('no-carry'));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S5).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S5).toEqual({
      verdict: 'fail',
      reason: 'carry-decision-differs',
      digest: expectedS5Digest(DAY, 'fail', 'carry-decision-differs', 1),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  it('records S5 as pass (carry-decisions-equal) with compared 0 on a day with zero carry decisions', async () => {
    // The zero-decision policy: the evaluator's pass counts toward the
    // evidence window, and `compared: 0` is part of the digest.
    const harness = wiredHarness(cleanFixture(DAY), {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S5).toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S5).toEqual({
      verdict: 'pass',
      reason: 'carry-decisions-equal',
      digest: expectedS5Digest(DAY, 'pass', 'carry-decisions-equal', 0),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  it('reports S5 as not-wired when premergeCarry is absent, leaving other criteria unchanged', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({
      S1: 'pass', S4: 'pass', S6: 'pass', S7: 'pass', S8: 'pass', S9: 'pass', S12: 'pass',
    });
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S5')).toBe('not-wired');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('reports S5 unevaluated (shell-events-unavailable) when shell events are unavailable or have unknown lines', async () => {
    // The events read itself is unavailable.
    const unreadable = wiredHarness(cleanFixture(DAY), {});
    setPremergeCarry(unreadable, constantPremergeCarry('carry'));
    (unreadable.deps.legacy as { readLegacyTrainEvents?: unknown }).readLegacyTrainEvents = undefined;
    const unreadableResult = await new RecordShadowDayUseCase(unreadable.deps).execute(makeRequest());
    expectRecorded(unreadableResult);
    const unreadableReasons = new Map(unreadableResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(unreadableReasons.get('S5')).toBe('shell-events-unavailable');

    // The log parsed, but a line could not be recognized: an incomplete
    // shell record is never evidence either way.
    const fixture = cleanFixture(DAY);
    fixture.shellLines.push('x'.repeat(5000));
    const unknownLines = wiredHarness(fixture, {});
    setPremergeCarry(unknownLines, constantPremergeCarry('carry'));
    const unknownResult = await new RecordShadowDayUseCase(unknownLines.deps).execute(makeRequest());
    expectRecorded(unknownResult);
    const unknownReasons = new Map(unknownResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(unknownReasons.get('S5')).toBe('shell-events-unavailable');
  });

  it('pins the shell-facts-invalid reason mapping for S5 and S6 when the shared day-end extraction refuses (the NaN-`atIso` branch itself is unreachable through the real pipeline)', async () => {
    const harness = wiredHarness(cleanFixture(DAY), {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    // No invalid timestamp can reach the use case through the real parser:
    // `parseShellTrainEvents` validates every `at` as a calendar date-time and
    // demotes anything else to an unknown line (shell-events-unavailable), and
    // `extractShadowShellFacts` re-validates each `atIso` on its own input. So
    // the `shell-facts-invalid` path is unreachable through the real pipeline;
    // this test pins the reason mapping by making the shared day-end
    // extraction refuse once, the way a future parser change would.
    const prototype = RecordShadowDayUseCase.prototype as unknown as {
      extractBoundedShellFacts: (context: unknown, shell: unknown) => unknown;
    };
    const original = prototype.extractBoundedShellFacts;
    prototype.extractBoundedShellFacts = () => ({ ok: false, reason: 'shell-facts-invalid' });
    try {
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
      expect(reasons.get('S5')).toBe('shell-facts-invalid');
      expect(reasons.get('S6')).toBe('shell-facts-invalid');
    } finally {
      prototype.extractBoundedShellFacts = original;
    }
  });

  it('keeps closed day D S5 unchanged when a carry intent on D is only completed by a D+1 result', async () => {
    // The evaluator day-scopes the decisions it receives itself, so a
    // complete D+1 decision pair would be scoped away either way and would
    // not discriminate this filter for S5. The discriminating input is an
    // intent ON D whose classifying `result` lands on D+1: without the
    // day-end filter the D+1 result would pair with the day's own intent,
    // adding a carry decision (and a head move) for a pairing the closed
    // day never saw; with the filter the D+1 result is dropped and the
    // intent stays pending, so the closed day's carry facts are exactly the
    // in-day decision and the recorded verdict and digest stand. (The old
    // comment claimed a digest change on a closed day: a digest change is
    // exactly what must NOT happen — that claim was wrong.)
    const fixture = carryFixture();
    const harness = wiredHarness(fixture, {});
    const calls = { decisions: [] as unknown[], deadlines: [] as string[] };
    setPremergeCarry(harness, constantPremergeCarry('carry', calls));
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S5).toBe('pass');
    const before = harness.evidence.stored;

    fixture.shellLines.push(...shellCarryPair(`${DAY}T23:30:00Z`, '2026-11-17T00:30:00Z', 12, HEAD_D, HEAD_E, true));
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    expect(result.recorded.S5).toBe('pass');
    expect(result.unevaluated.map((entry) => entry.criterion)).not.toContain('S5');
    expect(harness.evidence.stored).toEqual(before);
    // Only the day's own decision was ever resolved (once per run); the
    // D+1-completed pairing never reached the resolver.
    const inDayDecision = {
      pullRequest: 12, oldHeadOid: HEAD_B, newHeadOid: HEAD_D, atIso: `${DAY}T09:05:00Z`, shellCarry: 'carried',
    };
    expect(calls.decisions).toEqual([inDayDecision, inDayDecision]);
  });

  it('reports S5 unevaluated (carry-pairing-incomplete) on an in-day unpaired update', async () => {
    // An `updated` result on D with no pending intent to pair is a pairing
    // anomaly on the recorded day itself: the shell's carry facts for D are
    // incomplete, so S5 is unevaluated, never a pass. Dropping the anomalies
    // from the evaluator's input would leave only the resolved decision and
    // this test would see a pass instead.
    const fixture = carryFixture();
    fixture.shellLines.push(JSON.stringify({ at: `${DAY}T15:00:00Z`, kind: 'result', outcome: 'updated', pr: 13, headOid: HEAD_E, detail: 'premerge carried (success)' }));
    const harness = wiredHarness(fixture, {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());

    expectRecorded(result);
    expect(result.recorded.S5).toBeUndefined();
    const reasons = new Map(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(reasons.get('S5')).toBe('carry-pairing-incomplete');
    expect(harness.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S5).toBeUndefined();
  });

  it('calls the premergeCarry resolver only for in-day decisions, once despite a D-1 decision', async () => {
    // Only the day's own decisions need the fleet's answer: a D-1 decision
    // is in the extracted facts (the day-end filter has no lower bound) but
    // is day-scoped away before resolution, so the resolver is called
    // exactly once — for the D decision.
    const fixture = carryFixture();
    fixture.shellLines.push(...shellCarryPair('2026-11-15T09:04:00Z', '2026-11-15T09:05:00Z', 12, HEAD_B, HEAD_D, true));
    const calls = { decisions: [] as unknown[], deadlines: [] as string[] };
    const harness = wiredHarness(fixture, {});
    setPremergeCarry(harness, constantPremergeCarry('carry', calls));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());

    expectRecorded(result);
    expect(result.recorded.S5).toBe('pass');
    expect(calls.decisions).toHaveLength(1);
    expect((calls.decisions[0] as { atIso: string }).atIso).toBe(`${DAY}T09:05:00Z`);
  });

  it('records S5 as pass (compared 0) with the unresolved diagnostics when premergeCarry throws, answers unknown, or answers out of set', async () => {
    // 2026-11-18 owner decision: a resolver throw, an `unknown` answer and an
    // out-of-set answer all map to `fleetCarry: 'unknown'` per decision —
    // recorded in the non-digested unresolved diagnostics, never refused as
    // `fleet-carry-unknown`, and the resolvable set is empty so the day
    // passes with `compared: 0` (while the composition pins the resolver to
    // `'unknown'` this is every day with a paired shell log).
    const expectedUnresolved = { unresolvedCount: 1, unresolvedIds: [`12@${HEAD_D.slice(0, 12)}`] };
    const expectedVerdict = {
      verdict: 'pass',
      reason: 'carry-decisions-equal',
      digest: expectedS5Digest(DAY, 'pass', 'carry-decisions-equal', 0),
      recordedAtIso: RECORDED_AT_ISO,
    };

    // The resolver throws.
    const throwing = wiredHarness(carryFixture(), {});
    setPremergeCarry(throwing, throwingPremergeCarry());
    const thrownResult = await new RecordShadowDayUseCase(throwing.deps).execute(makeRequest());
    expectRecorded(thrownResult);
    expect(thrownResult.recorded.S5).toBe('pass');
    expect(thrownResult.premergeCarry).toEqual(expectedUnresolved);
    expect(throwing.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S5).toEqual(expectedVerdict);

    // The resolver answers `unknown`.
    const unknown = wiredHarness(carryFixture(), {});
    setPremergeCarry(unknown, constantPremergeCarry('unknown'));
    const unknownResult = await new RecordShadowDayUseCase(unknown.deps).execute(makeRequest());
    expectRecorded(unknownResult);
    expect(unknownResult.recorded.S5).toBe('pass');
    expect(unknownResult.premergeCarry).toEqual(expectedUnresolved);
    expect(unknown.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S5).toEqual(expectedVerdict);

    // The resolver answers something outside the closed answer set: read as
    // `unknown`, never as a pass or a fail on the decision itself.
    const bogus = wiredHarness(carryFixture(), {});
    setPremergeCarry(bogus, (() => Promise.resolve('bogus' as PremergeCarryAnswer)) as NonNullable<RecordShadowDayDependencies['premergeCarry']>);
    const bogusResult = await new RecordShadowDayUseCase(bogus.deps).execute(makeRequest());
    expectRecorded(bogusResult);
    expect(bogusResult.recorded.S5).toBe('pass');
    expect(bogusResult.premergeCarry).toEqual(expectedUnresolved);
    expect(bogus.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S5).toEqual(expectedVerdict);
  });

  it('records S5 as pass (compared 1) when one decision is resolved and three are unresolved, digest unchanged from the all-resolved day', async () => {
    // The mixed day: pr 12 resolves to `carry`; prs 13-15 stay `unknown`.
    // `compared` counts the resolved decision only, so the S5' digest is the
    // exact digest of a day with the same single resolved decision and no
    // unresolved ones — the unresolved diagnostics are never digested.
    const HEAD_1 = '1'.repeat(40);
    const HEAD_2 = '2'.repeat(40);
    const HEAD_3 = '3'.repeat(40);
    const mixedFixture = carryFixture();
    mixedFixture.shellLines.push(
      ...shellCarryPair(`${DAY}T10:04:00Z`, `${DAY}T10:05:00Z`, 13, HEAD_A, HEAD_1, true),
      ...shellCarryPair(`${DAY}T11:04:00Z`, `${DAY}T11:05:00Z`, 14, HEAD_E, HEAD_2, true),
      ...shellCarryPair(`${DAY}T14:04:00Z`, `${DAY}T14:05:00Z`, 15, HEAD_B, HEAD_3, false),
    );
    const mixed = wiredHarness(mixedFixture, {});
    setPremergeCarry(mixed, prMapPremergeCarry({ 12: 'carry' }));
    const mixedResult = await new RecordShadowDayUseCase(mixed.deps).execute(makeRequest());
    expectRecorded(mixedResult);
    expect(mixedResult.recorded.S5).toBe('pass');
    expect(mixedResult.premergeCarry).toEqual({
      unresolvedCount: 3,
      unresolvedIds: [`13@${HEAD_1.slice(0, 12)}`, `14@${HEAD_2.slice(0, 12)}`, `15@${HEAD_3.slice(0, 12)}`],
    });
    const mixedDigest = mixed.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S5?.digest;
    expect(mixedDigest).toBe(expectedS5Digest(DAY, 'pass', 'carry-decisions-equal', 1));

    // The all-resolved twin: one resolved agree, zero unresolved — same digest.
    const allResolved = wiredHarness(carryFixture(), {});
    setPremergeCarry(allResolved, constantPremergeCarry('carry'));
    const allResolvedResult = await new RecordShadowDayUseCase(allResolved.deps).execute(makeRequest());
    expectRecorded(allResolvedResult);
    expect(allResolvedResult.premergeCarry).toEqual({ unresolvedCount: 0, unresolvedIds: [] });
    const allResolvedDigest = allResolved.evidence.stored?.days.find((entry) => entry.day === DAY)?.verdicts.S5?.digest;
    expect(allResolvedDigest).toBe(expectedS5Digest(DAY, 'pass', 'carry-decisions-equal', 1));
    expect(allResolvedDigest).toBe(mixedDigest);
  });

  it('records S5 as fail (carry-decision-differs) when a resolvable lax carry sits next to unresolved decisions', async () => {
    // Any resolvable lax carry still fails the day even when other decisions
    // are unresolved; the unresolved ones ride along as diagnostics only.
    // PR 12's shell log says `not carried` while the resolver answers
    // `'carry'` — a true lax carry — and that difference fails the day.
    const HEAD_1 = '1'.repeat(40);
    const laxFixture = cleanFixture(DAY);
    laxFixture.shellLines.push(
      ...shellCarryPair(`${DAY}T09:04:00Z`, `${DAY}T09:05:00Z`, 12, HEAD_B, HEAD_D, false),
      ...shellCarryPair(`${DAY}T10:04:00Z`, `${DAY}T10:05:00Z`, 13, HEAD_A, HEAD_1, true),
    );
    const harness = wiredHarness(laxFixture, {});
    setPremergeCarry(harness, prMapPremergeCarry({ 12: 'carry', 13: 'unknown' }));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S5).toBe('fail');
    expect(result.premergeCarry).toEqual({
      unresolvedCount: 1,
      unresolvedIds: [`13@${HEAD_1.slice(0, 12)}`],
    });
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S5).toEqual({
      verdict: 'fail',
      reason: 'carry-decision-differs',
      digest: expectedS5Digest(DAY, 'fail', 'carry-decision-differs', 1),
      recordedAtIso: RECORDED_AT_ISO,
    });
  });

  it('refuses a rerun whose premergeCarry answers change from unknown to carry with verdict-conflict and leaves the ledger untouched', async () => {
    // The first run's resolver answers `unknown` for every decision, so S5
    // records a pass with `compared: 0`. A rerun where the same decisions
    // resolve to `'carry'` records `compared: 1` — a different digest for the
    // same day — so the re-run is a deliberate verdict-conflict, never a
    // silent overwrite.
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('unknown'));
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S5).toBe('pass');
    expect(first.premergeCarry).toEqual({ unresolvedCount: 1, unresolvedIds: [`12@${HEAD_D.slice(0, 12)}`] });
    const before = harness.evidence.stored;

    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored).toEqual(before);
    expect(harness.evidence.stored?.revision).toBe(1);
  });

  it('aborts with deadline-exceeded when the deadline is reached before premergeCarry calls', async () => {
    const calls = { decisions: [] as unknown[], deadlines: [] as string[] };
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('carry', calls));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ deadlineIso: PAST_DEADLINE }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    // The deadline was already reached, so the resolver was never consulted.
    expect(calls.decisions).toEqual([]);
    expect(harness.evidence.stored).toBeNull();
  });

  it('aborts with deadline-exceeded when the deadline expires while the premergeCarry resolver is awaited', async () => {
    // The rerun path: the day is already recorded, so a rerun whose facts and
    // answers are identical answers `unchanged` — unless the deadline expires
    // while the resolver is awaited, in which case `call`'s re-check after
    // the awaited return aborts the run before the value is used. The rerun
    // uses the later 12:20 deadline: the rerun starts at 12:02:30 and the S8
    // sample sleep moves the clock to exactly 12:05:00, so with the default
    // deadline the second intake pre-check would abort before the resolver
    // was ever consulted; with 12:20 only the resolver's own delay crosses
    // the deadline.
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    const afterFirst = harness.evidence.stored;

    let resolverCalls = 0;
    // The clock is still on time when the resolver is called, and advances
    // past the deadline before the resolver returns.
    setPremergeCarry(harness, (input) => {
      resolverCalls += 1;
      harness.setNow(new Date(Date.parse(input.deadlineIso) + 60_000).toISOString());
      return Promise.resolve('carry');
    });
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    // The post-await re-check really fired on the resolver's awaited value.
    expect(resolverCalls).toBe(1);
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    // The ledger is untouched: the resolver's value was never used.
    expect(harness.evidence.stored).toEqual(afterFirst);
  });

  it('aborts with deadline-exceeded when the premergeCarry resolver rejects after the deadline passes', async () => {
    // The rejection path: `call` must re-check the deadline even when the
    // awaited operation REJECTS, otherwise S5 would treat the thrown answer
    // as an unresolved decision and a rerun could answer `unchanged` instead
    // of aborting with `deadline-exceeded`. The rerun uses the later 12:20
    // deadline (see the fulfilled twin above): with the default 12:05 one,
    // the rerun's S8 sample sleep lands the clock exactly on the deadline
    // and the intake pre-check aborts before the resolver is consulted.
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    const afterFirst = harness.evidence.stored;

    let resolverCalls = 0;
    // The clock is still on time when the resolver is called, and advances
    // past the deadline before the resolver rejects.
    setPremergeCarry(harness, (input) => {
      resolverCalls += 1;
      harness.setNow(new Date(Date.parse(input.deadlineIso) + 60_000).toISOString());
      return Promise.reject(new Error('resolver failed'));
    });
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(resolverCalls).toBe(1);
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(harness.evidence.stored).toEqual(afterFirst);
  });

  it('reports recorded when the ledger save lands after the deadline passes', async () => {
    // The ledger write is the one call exempt from `call`'s post-await
    // deadline re-check: once `compareAndSet` returns, the write has LANDED
    // durably even if the deadline passed while it was awaited, so its real
    // result is reported — a post-deadline `deadline-exceeded` would claim
    // nothing was written. The pre-write check still aborts before anything
    // is sent (pinned by the reached-before test above).
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const inner = harness.deps.evidence.compareAndSet.bind(harness.deps.evidence);
    harness.deps.evidence.compareAndSet = (request) => {
      // The deadline passes while the write is awaited; the save lands.
      harness.setNow(new Date(Date.parse(DEADLINE) + 60_000).toISOString());
      return inner(request);
    };
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());

    expectRecorded(result);
    expect(result.recorded.S5).toBe('pass');
  });

  it('aborts with deadline-exceeded when the ledger read rejects after the deadline passes', async () => {
    // The same rule for another port that goes through `call`: a rejection
    // landing after the deadline must abort the run, not surface as the
    // port's own threw-handling.
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    const afterFirst = harness.evidence.stored;

    harness.deps.evidence.read = () => {
      harness.setNow(new Date(Date.parse(DEADLINE) + 60_000).toISOString());
      return Promise.reject(new Error('ledger read failed'));
    };
    const result = await useCase.execute(makeRequest({ deadlineIso: DEADLINE }));

    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(harness.evidence.stored).toEqual(afterFirst);
  });

  it('answers unchanged on an S5 rerun with identical facts and answers, without a second CAS', async () => {
    const harness = wiredHarness(carryFixture(), {});
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const useCase = new RecordShadowDayUseCase(harness.deps);
    await useCase.execute(makeRequest());
    const afterFirst = harness.evidence.stored;
    const casCallsAfterFirst = harness.evidence.calls.cas;

    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));
    expectRecorded(result);
    expect(result.outcome).toBe('unchanged');
    expect(result.recorded.S5).toBe('pass');
    expect(result.premergeCarry).toEqual({ unresolvedCount: 0, unresolvedIds: [] });
    expect(harness.evidence.calls.cas).toBe(casCallsAfterFirst);
    expect(harness.evidence.stored).toEqual(afterFirst);
  });

  it('keeps S1, S4, S6, S7, S8, S9 and S12 digests byte-identical whether premergeCarry is present or absent', async () => {
    const without = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    const withoutResult = await new RecordShadowDayUseCase(without.deps).execute(makeRequest());
    expectRecorded(withoutResult);

    const withResolver = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setPremergeCarry(withResolver, constantPremergeCarry('carry'));
    const withResult = await new RecordShadowDayUseCase(withResolver.deps).execute(makeRequest());
    expectRecorded(withResult);
    expect(withResult.recorded.S5).toBe('pass');

    const withoutDay = without.evidence.stored?.days.find((entry) => entry.day === DAY);
    const withDay = withResolver.evidence.stored?.days.find((entry) => entry.day === DAY);
    for (const criterion of ['S1', 'S4', 'S6', 'S7', 'S8', 'S9', 'S12'] as const) {
      expect(withDay?.verdicts[criterion]).toBeDefined();
      expect(withoutDay?.verdicts[criterion]).toBeDefined();
      expect(typeof withDay?.verdicts[criterion]?.digest).toBe('string');
      expect(typeof withoutDay?.verdicts[criterion]?.digest).toBe('string');
      expect(withDay?.verdicts[criterion]?.digest).toBe(withoutDay?.verdicts[criterion]?.digest);
    }
  });

  /* -------------------------------------------------------------------------
   * SH19b2: S2, S3, S10, S11 — the one-time shadow criteria, judged from the
   * sticky attestation ledger plus the day's pinned release tree, recorded
   * again on every day with no already-passed shortcut.
   * ------------------------------------------------------------------------- */

  it("records S2, S3, S10, S11 as pass (one-time-evidence-present) when the ledger has every fact and every required test is present", async () => {
    const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }) });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S2).toBe('pass');
    expect(result.recorded.S3).toBe('pass');
    expect(result.recorded.S10).toBe('pass');
    expect(result.recorded.S11).toBe('pass');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    for (const criterion of ['S2', 'S3', 'S10', 'S11'] as const) {
      expect(dayRecord?.verdicts[criterion]).toEqual({
        verdict: 'pass',
        reason: 'one-time-evidence-present',
        digest: expectedOneTimeDigest(criterion, DAY, 'pass', 'one-time-evidence-present'),
        recordedAtIso: RECORDED_AT_ISO,
      });
    }
    // The store was read once and the inspector saw the SAME pinned sha the
    // day records, over exactly the deduplicated required test paths.
    expect(oneTime.calls.read).toBe(1);
    expect(oneTime.calls.inspect).toBe(1);
    expect(oneTime.calls.inputs).toEqual([
      { root: '/state/releases', sha: RELEASE, paths: REQUIRED_TEST_PATHS },
    ]);
  });

  it('reports S2, S3, S10, S11 as not-wired when oneTime is absent, leaving other criteria unchanged', async () => {
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setPremergeCarry(harness, constantPremergeCarry('carry'));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({
      S1: 'pass', S4: 'pass', S5: 'pass', S6: 'pass', S7: 'pass', S8: 'pass', S9: 'pass', S12: 'pass',
    });
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('not-wired');
    expect(reasons.get('S3')).toBe('not-wired');
    expect(reasons.get('S10')).toBe('not-wired');
    expect(reasons.get('S11')).toBe('not-wired');
    expectNotImplementedUnevaluated(result.unevaluated);
  });

  it('reports S2, S3, S10, S11 unevaluated (attestations-unreadable) on unknown-version, unreadable, or throwing attestation store', async () => {
    const statuses = [
      { status: 'unknown-version' },
      { status: 'unreadable' },
    ] as const;
    for (const readResult of [...statuses, 'throws']) {
      const oneTime = makeOneTime({
        read: () => {
          if (readResult === 'throws') {
            throw new Error('attestation store failed');
          }
          return readResult;
        },
      });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      expect(result.recorded.S2).toBeUndefined();
      expect(result.recorded.S3).toBeUndefined();
      expect(result.recorded.S10).toBeUndefined();
      expect(result.recorded.S11).toBeUndefined();
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('attestations-unreadable');
      expect(reasons.get('S3')).toBe('attestations-unreadable');
      expect(reasons.get('S10')).toBe('attestations-unreadable');
      expect(reasons.get('S11')).toBe('attestations-unreadable');
    }
  });

  it('reports S2, S3, S10, S11 unevaluated (attestations-unreadable) when attestations.read returns null, a primitive, or a getter-bearing object', async () => {
    const getterBearing: Record<string, unknown> = {};
    Object.defineProperty(getterBearing, 'status', { value: 'ok', enumerable: true });
    Object.defineProperty(getterBearing, 'ledger', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const trappedProxy = new Proxy(
      { status: 'missing' },
      {
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    const badResults: unknown[] = [null, 42, 'nope', getterBearing, trappedProxy];
    for (const readResult of badResults) {
      const oneTime = makeOneTime({ read: () => readResult });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      // execute must not throw out of any of these hostile reads.
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('attestations-unreadable');
      expect(reasons.get('S3')).toBe('attestations-unreadable');
      expect(reasons.get('S10')).toBe('attestations-unreadable');
      expect(reasons.get('S11')).toBe('attestations-unreadable');
    }
  });

  it('reports all four one-time criteria attestations-unreadable with a getter count of 0 when a missing attestation result carries a getter', async () => {
    let getterCalls = 0;
    const getterBearingMissing: Record<string, unknown> = {
      status: 'missing',
      get ledger() {
        getterCalls += 1;
        return {};
      },
    };
    const oneTime = makeOneTime({ read: () => getterBearingMissing });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('attestations-unreadable');
    expect(reasons.get('S3')).toBe('attestations-unreadable');
    expect(reasons.get('S10')).toBe('attestations-unreadable');
    expect(reasons.get('S11')).toBe('attestations-unreadable');
    expect(getterCalls).toBe(0);
  });

  it('reports all four one-time criteria attestations-unreadable when a missing attestation result carries an extra key', async () => {
    const extraKey: Record<string, unknown> = { status: 'missing', extra: 'nope' };
    const oneTime = makeOneTime({ read: () => extraKey });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('attestations-unreadable');
    expect(reasons.get('S3')).toBe('attestations-unreadable');
    expect(reasons.get('S10')).toBe('attestations-unreadable');
    expect(reasons.get('S11')).toBe('attestations-unreadable');
  });

  it('reports S2 and S3 unevaluated (not-yet-observed) when attestations are missing or observed after the day', async () => {
    // The store reports nothing stored.
    const missing = makeOneTime();
    const missingHarness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(missingHarness, missing);
    const missingResult = await new RecordShadowDayUseCase(missingHarness.deps).execute(makeRequest());
    expectRecorded(missingResult);
    const missingReasons = unevaluatedReasons(missingResult);
    expect(missingReasons.get('S2')).toBe('not-yet-observed');
    expect(missingReasons.get('S3')).toBe('not-yet-observed');
    // S10 and S11 have no required facts, so they still judge their release tests.
    expect(missingResult.recorded.S10).toBe('pass');
    expect(missingResult.recorded.S11).toBe('pass');

    // Every fact observed AFTER the recorded day is not yet observed either.
    const future = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger('2026-11-20') }) });
    const futureHarness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(futureHarness, future);
    const futureResult = await new RecordShadowDayUseCase(futureHarness.deps).execute(makeRequest());
    expectRecorded(futureResult);
    const futureReasons = unevaluatedReasons(futureResult);
    expect(futureReasons.get('S2')).toBe('not-yet-observed');
    expect(futureReasons.get('S3')).toBe('not-yet-observed');
    expect(futureResult.recorded.S10).toBe('pass');
    expect(futureResult.recorded.S11).toBe('pass');
  });

  it('reports S2, S10, S11 unevaluated (release-unpinned) when releaseSha is null', async () => {
    const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }) });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    (harness.deps as { releaseSha: () => Promise<string | null> }).releaseSha = async () => null;
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('release-unpinned');
    expect(reasons.get('S10')).toBe('release-unpinned');
    expect(reasons.get('S11')).toBe('release-unpinned');
    // S3 has no required tests, so its ledger facts still count.
    expect(result.recorded.S3).toBe('pass');
    // The inspector is never consulted for an unpinned day.
    expect(oneTime.calls.inspect).toBe(0);
  });

  it('refuses the request and records nothing when releaseSha is malformed', async () => {
    const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }) });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    (harness.deps as { releaseSha: () => Promise<string | null> }).releaseSha = async () => 'not-a-sha';
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    // The malformed sha is refused by writeDay's verdict write —
    // `recordShadowVerdicts` rejects the input as invalid-input — so nothing
    // is recorded at all and the inspector is never consulted.
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.evidence.stored).toBeNull();
    expect(oneTime.calls.inspect).toBe(0);
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) when inspectReleaseFiles is missing, throws, or returns not-found/unreadable', async () => {
    const cases: { label: string; options: OneTimeOptions }[] = [
      { label: 'method absent', options: { omitInspect: true } },
      {
        label: 'throws',
        options: {
          inspect: () => {
            throw new Error('release store failed');
          },
        },
      },
      { label: 'not-found', options: { inspect: () => ({ outcome: 'not-found' }) } },
      { label: 'unreadable', options: { inspect: () => ({ outcome: 'unreadable' }) } },
    ];
    for (const { options } of cases) {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }), ...options });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('release-tree-unreadable');
      expect(reasons.get('S10')).toBe('release-tree-unreadable');
      expect(reasons.get('S11')).toBe('release-tree-unreadable');
      // S3 requires no tests, so it still passes on the ledger facts.
      expect(result.recorded.S3).toBe('pass');
    }
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) when inspectReleaseFiles returns null, a primitive, or a getter-bearing outer result', async () => {
    const getterBearing: Record<string, unknown> = {};
    Object.defineProperty(getterBearing, 'outcome', { value: 'read', enumerable: true });
    Object.defineProperty(getterBearing, 'files', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const badResults: unknown[] = [null, 7, 'nope', getterBearing];
    for (const inspectResult of badResults) {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }), inspect: () => inspectResult });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('release-tree-unreadable');
      expect(reasons.get('S10')).toBe('release-tree-unreadable');
      expect(reasons.get('S11')).toBe('release-tree-unreadable');
    }
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) when inspectReleaseFiles returns non-array, length mismatch, null, non-plain item, or throwing getter', async () => {
    const nonPlainItem: object = Object.create({ isPlain: false }) as object;
    const getterItem: Record<string, unknown> = {};
    Object.defineProperty(getterItem, 'present', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const cases: unknown[] = [
      { outcome: 'read', files: 'nope' },
      { outcome: 'read', files: [{ present: true, quarantined: false }] },
      { outcome: 'read', files: [null, null, null] },
      { outcome: 'read', files: [nonPlainItem, nonPlainItem, nonPlainItem] },
      { outcome: 'read', files: [getterItem, getterItem, getterItem] },
    ];
    for (const inspectResult of cases) {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }), inspect: () => inspectResult });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('release-tree-unreadable');
      expect(reasons.get('S10')).toBe('release-tree-unreadable');
      expect(reasons.get('S11')).toBe('release-tree-unreadable');
    }
  });

  it('records S2, S10, S11 fail on absent or quarantined test and unevaluated on null quarantine', async () => {
    const oneTime = makeOneTime({
      read: () => ({ status: 'ok', ledger: attestationLedger() }),
      inspect: () => ({
        outcome: 'read',
        files: [
          { present: false, quarantined: false },
          { present: true, quarantined: true },
          { present: true, quarantined: null },
        ],
      }),
    });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S2).toBe('fail');
    expect(result.recorded.S10).toBe('fail');
    const dayRecord = harness.evidence.stored?.days.find((entry) => entry.day === DAY);
    expect(dayRecord?.verdicts.S2).toEqual({
      verdict: 'fail',
      reason: 'required-test-absent',
      digest: expectedOneTimeDigest('S2', DAY, 'fail', 'required-test-absent'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    expect(dayRecord?.verdicts.S10).toEqual({
      verdict: 'fail',
      reason: 'required-test-quarantined',
      digest: expectedOneTimeDigest('S10', DAY, 'fail', 'required-test-quarantined'),
      recordedAtIso: RECORDED_AT_ISO,
    });
    // A present file whose quarantine flag cannot be judged is unevaluated, never a pass.
    expect(result.recorded.S11).toBeUndefined();
    expect(unevaluatedReasons(result).get('S11')).toBe('release-test-unreadable');
    expect(result.recorded.S3).toBe('pass');
  });

  it('aborts with deadline-exceeded when deadline expires before or during oneTime reads', async () => {
    // Before: the deadline is already reached, so the store is never consulted.
    const before = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }) });
    const beforeHarness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(beforeHarness, before);
    const beforeResult = await new RecordShadowDayUseCase(beforeHarness.deps).execute(makeRequest({ deadlineIso: PAST_DEADLINE }));
    expect(beforeResult).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(before.calls.read).toBe(0);
    expect(before.calls.inspect).toBe(0);
    expect(beforeHarness.evidence.stored).toBeNull();

    // During: the rerun's deadline (12:20) is still ahead when the store is
    // called, and passes while it is awaited — `call`'s post-await re-check
    // must abort the run instead of answering from the value.
    const during = makeOneTime();
    const duringHarness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(duringHarness, during);
    const useCase = new RecordShadowDayUseCase(duringHarness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    const afterFirst = duringHarness.evidence.stored;

    during.attestations.read = (async () => {
      duringHarness.setNow(new Date(Date.parse('2026-11-17T12:20:00.000Z') + 60_000).toISOString());
      return { status: 'missing' } as const;
    }) as Pick<ShadowAttestationPort, 'read'>['read'];
    const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(duringHarness.evidence.stored).toEqual(afterFirst);
  });

  it('re-evaluates and records S2, S3, S10, S11 on two consecutive days without an already-passed shortcut', async () => {
    const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger('2026-11-14') }) });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const useCase = new RecordShadowDayUseCase(harness.deps);

    const first = await useCase.execute(makeRequest({ day: '2026-11-15' }));
    expectRecorded(first);
    expect(first.recorded.S2).toBe('pass');
    expect(first.recorded.S3).toBe('pass');
    expect(first.recorded.S10).toBe('pass');
    expect(first.recorded.S11).toBe('pass');

    const second = await useCase.execute(makeRequest({ day: DAY }));
    expectRecorded(second);
    expect(second.recorded.S2).toBe('pass');
    expect(second.recorded.S3).toBe('pass');
    expect(second.recorded.S10).toBe('pass');
    expect(second.recorded.S11).toBe('pass');

    const days = harness.evidence.stored?.days ?? [];
    expect(days).toHaveLength(2);
    for (const dayRecord of days) {
      for (const criterion of ['S2', 'S3', 'S10', 'S11'] as const) {
        expect(dayRecord.verdicts[criterion]?.verdict).toBe('pass');
      }
    }
    // No already-passed shortcut also means the sources were read again:
    // one store read and one release inspection per recorded day.
    expect(oneTime.calls.read).toBe(2);
    expect(oneTime.calls.inspect).toBe(2);
  });

  it('keeps S1, S4, S5, S6, S7, S8, S9 and S12 digests byte-identical whether oneTime is present or absent', async () => {
    const options = {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    };
    const without = wiredHarness(conformingFixture(), options);
    setPremergeCarry(without, constantPremergeCarry('carry'));
    const withoutResult = await new RecordShadowDayUseCase(without.deps).execute(makeRequest());
    expectRecorded(withoutResult);

    const withOneTime = wiredHarness(conformingFixture(), options);
    setPremergeCarry(withOneTime, constantPremergeCarry('carry'));
    setOneTime(withOneTime, makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }) }));
    const withResult = await new RecordShadowDayUseCase(withOneTime.deps).execute(makeRequest());
    expectRecorded(withResult);
    expect(withResult.recorded.S2).toBe('pass');

    const withoutDay = without.evidence.stored?.days.find((entry) => entry.day === DAY);
    const withDay = withOneTime.evidence.stored?.days.find((entry) => entry.day === DAY);
    for (const criterion of ['S1', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S12'] as const) {
      expect(withDay?.verdicts[criterion]).toBeDefined();
      expect(withoutDay?.verdicts[criterion]).toBeDefined();
      expect(typeof withDay?.verdicts[criterion]?.digest).toBe('string');
      expect(typeof withoutDay?.verdicts[criterion]?.digest).toBe('string');
      expect(withDay?.verdicts[criterion]?.digest).toBe(withoutDay?.verdicts[criterion]?.digest);
    }
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) when files is too LONG, array-like but not an array, or the outcome is not read despite valid files', async () => {
    const present = presentReleaseFiles();
    const arrayLike = {
      length: present.length,
      ...Object.fromEntries(present.map((item, index) => [String(index), item])),
    };
    const cases: unknown[] = [
      // One extra item: a too-long array must be refused exactly like a too-short one.
      { outcome: 'read', files: [...present, { present: true, quarantined: false }] },
      // Array-like ({length, 0, 1, ...}) that is not a real array is refused.
      { outcome: 'read', files: arrayLike },
      // A non-'read' outcome carrying valid-looking files is refused.
      { outcome: 'unreadable', files: present },
    ];
    for (const inspectResult of cases) {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }), inspect: () => inspectResult });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('release-tree-unreadable');
      expect(reasons.get('S10')).toBe('release-tree-unreadable');
      expect(reasons.get('S11')).toBe('release-tree-unreadable');
    }
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) when an item is a class instance or a proxy whose own present/quarantined are accessors', async () => {
    class ReleaseFile {}
    const classItem = new ReleaseFile();
    Object.defineProperty(classItem, 'present', { value: true, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(classItem, 'quarantined', { value: false, enumerable: true, writable: true, configurable: true });

    let getterCalls = 0;
    const accessorTarget: Record<string, unknown> = {};
    Object.defineProperty(accessorTarget, 'present', {
      get() {
        getterCalls += 1;
        return true;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(accessorTarget, 'quarantined', {
      get() {
        getterCalls += 1;
        return false;
      },
      enumerable: true,
      configurable: true,
    });
    const proxyItem: unknown = new Proxy(accessorTarget, {});

    const cases: unknown[] = [
      { outcome: 'read', files: [classItem, classItem, classItem] },
      { outcome: 'read', files: [proxyItem, proxyItem, proxyItem] },
    ];
    for (const inspectResult of cases) {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }), inspect: () => inspectResult });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('release-tree-unreadable');
      expect(reasons.get('S10')).toBe('release-tree-unreadable');
      expect(reasons.get('S11')).toBe('release-tree-unreadable');
      // The proxy's own getters must never have run.
      expect(getterCalls).toBe(0);
    }
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) with a getter count of 0 when the outer inspection result is non-plain or its outcome/files are accessors returning valid values', async () => {
    class InspectionResult {}
    const nonPlain = new InspectionResult();
    Object.defineProperty(nonPlain, 'outcome', { value: 'read', enumerable: true, writable: true, configurable: true });
    Object.defineProperty(nonPlain, 'files', { value: presentReleaseFiles(), enumerable: true, writable: true, configurable: true });

    let getterCalls = 0;
    const getterBearing: Record<string, unknown> = { outcome: 'read' };
    Object.defineProperty(getterBearing, 'files', {
      get() {
        getterCalls += 1;
        return presentReleaseFiles();
      },
      enumerable: true,
      configurable: true,
    });

    for (const inspectResult of [nonPlain as unknown, getterBearing as unknown]) {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }), inspect: () => inspectResult });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expectRecorded(result);
      const reasons = unevaluatedReasons(result);
      expect(reasons.get('S2')).toBe('release-tree-unreadable');
      expect(reasons.get('S10')).toBe('release-tree-unreadable');
      expect(reasons.get('S11')).toBe('release-tree-unreadable');
      // The files getter returned a fully valid list, so only the accessor
      // guard can explain the refusal — and it must never have run it.
      expect(getterCalls).toBe(0);
    }
  });

  it('reports all four one-time criteria attestations-unreadable when an ok attestation result carries an extra key', async () => {
    const extraKey = { status: 'ok', ledger: attestationLedger(), extra: 'nope' };
    const oneTime = makeOneTime({ read: () => extraKey });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('attestations-unreadable');
    expect(reasons.get('S3')).toBe('attestations-unreadable');
    expect(reasons.get('S10')).toBe('attestations-unreadable');
    expect(reasons.get('S11')).toBe('attestations-unreadable');
  });

  it('never calls inspectReleaseFiles and reports S2, S10, S11 unevaluated (release-tree-unreadable) when the release root is empty', async () => {
    const oneTime = makeOneTime({ releaseRoot: '   ' });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('release-tree-unreadable');
    expect(reasons.get('S10')).toBe('release-tree-unreadable');
    expect(reasons.get('S11')).toBe('release-tree-unreadable');
    // An empty root is a misconfiguration, never a readable tree: the
    // inspector must not be consulted at all.
    expect(oneTime.calls.inspect).toBe(0);
  });

  it('reports S2, S10, S11 unevaluated (release-tree-unreadable) when an item carries a non-boolean quarantined flag such as a string', async () => {
    const oneTime = makeOneTime({
      read: () => ({ status: 'ok', ledger: attestationLedger() }),
      inspect: () => ({
        outcome: 'read',
        files: presentReleaseFiles().map((item, index) =>
          index === 0 ? { present: true, quarantined: 'yes' } : item,
        ),
      }),
    });
    const harness = wiredHarness(conformingFixture(), {
      gateHeads: agreeingGateHeads(0),
      conformanceRuns: conformanceRunSpecs(),
    });
    setOneTime(harness, oneTime);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    // One bad flag poisons the whole zip: releaseTests is null, so every
    // test-dependent criterion is unevaluated, never partially judged.
    const reasons = unevaluatedReasons(result);
    expect(reasons.get('S2')).toBe('release-tree-unreadable');
    expect(reasons.get('S10')).toBe('release-tree-unreadable');
    expect(reasons.get('S11')).toBe('release-tree-unreadable');
  });

  it('aborts with deadline-exceeded when the deadline expires during inspectReleaseFiles, fulfilled or rejected', async () => {
    const run = async (fulfilled: boolean): Promise<void> => {
      const oneTime = makeOneTime({ read: () => ({ status: 'ok', ledger: attestationLedger() }) });
      const harness = wiredHarness(conformingFixture(), {
        gateHeads: agreeingGateHeads(0),
        conformanceRuns: conformanceRunSpecs(),
      });
      setOneTime(harness, oneTime);
      const useCase = new RecordShadowDayUseCase(harness.deps);
      const first = await useCase.execute(makeRequest());
      expectRecorded(first);
      const afterFirst = harness.evidence.stored;

      // The clock is still on time when the inspector is called, and advances
      // past the deadline before its value settles. The call counter keeps
      // counting, so the test proves the inspector WAS consulted.
      const inspect = oneTime.calls.inspect;
      (oneTime.releaseStore as { inspectReleaseFiles: unknown }).inspectReleaseFiles = async () => {
        oneTime.calls.inspect += 1;
        harness.setNow(new Date(Date.parse('2026-11-17T12:20:00.000Z') + 60_000).toISOString());
        if (fulfilled) {
          return { outcome: 'read', files: presentReleaseFiles() };
        }
        throw new Error('release store failed');
      };
      const result = await useCase.execute(makeRequest({ deadlineIso: '2026-11-17T12:20:00.000Z' }));

      expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
      expect(oneTime.calls.inspect).toBe(inspect + 1);
      expect(harness.evidence.stored).toEqual(afterFirst);
    };

    await run(true);
    await run(false);
  });
});

/**
 * OD7a2: scheduled mode (`--scheduled`) and the pure grant-coverage
 * evaluator. Scheduled mode fails closed BEFORE anything is written.
 */
describe('evaluateShadowGrantCoverage', () => {
  const DAY_START = '2026-11-16T00:00:00.000Z';
  const DAY_END = '2026-11-17T00:00:00.000Z';

  /** A minimal stored `merge:import-shadow` request record covering the whole of `DAY`. */
  function grantRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'shadow-import-test',
      state: 'approved',
      decisionRevision: 'rev-3',
      updatedAtIso: '2026-11-15T20:00:00.000Z',
      shadowImportGrant: {
        repository: { owner: OWNER, repo: REPO },
        expiresAtIso: '2026-11-18T00:00:00.000Z',
      },
      ...overrides,
    };
  }

  it('returns covered when approved before 00:00Z and expiring after the day end', () => {
    expect(evaluateShadowGrantCoverage(grantRecord(), DAY_START, DAY_END)).toEqual({ outcome: 'covered' });
  });

  it('returns not-covering when updatedAtIso is 12:00Z', () => {
    const evaluation = evaluateShadowGrantCoverage(
      grantRecord({ updatedAtIso: '2026-11-16T12:00:00.000Z' }),
      DAY_START,
      DAY_END,
    );
    expect(evaluation.outcome).toBe('not-covering');
  });

  it('returns not-covering when expiresAtIso is 18:00Z', () => {
    const evaluation = evaluateShadowGrantCoverage(
      grantRecord({ shadowImportGrant: { repository: { owner: OWNER, repo: REPO }, expiresAtIso: '2026-11-16T18:00:00.000Z' } }),
      DAY_START,
      DAY_END,
    );
    expect(evaluation.outcome).toBe('not-covering');
  });

  // OD7a2 fix round 7: the approval cutoff is inclusive at the day start —
  // `updatedAtIso` exactly at `00:00:00.000Z` is covered; one millisecond
  // later is not. Catches `> dayStart + 1ms` and other loosenings.
  it('treats updatedAtIso exactly at 00:00:00.000Z as covered and one millisecond later as not-covering', () => {
    expect(evaluateShadowGrantCoverage(grantRecord({ updatedAtIso: DAY_START }), DAY_START, DAY_END)).toEqual({
      outcome: 'covered',
    });
    expect(
      evaluateShadowGrantCoverage(grantRecord({ updatedAtIso: '2026-11-16T00:00:00.001Z' }), DAY_START, DAY_END),
    ).toEqual({ outcome: 'not-covering', reason: 'approved-after-day-start' });
  });

  // OD7a2 fix round 7: the grant must expire strictly AFTER the day ends —
  // `expiresAtIso` exactly at the day end is not-covering; one millisecond
  // after is covered. Catches `<=` becoming `<` and vice versa.
  it('treats expiresAtIso exactly at the day end as not-covering and one millisecond after as covered', () => {
    expect(
      evaluateShadowGrantCoverage(
        grantRecord({ shadowImportGrant: { repository: { owner: OWNER, repo: REPO }, expiresAtIso: DAY_END } }),
        DAY_START,
        DAY_END,
      ),
    ).toEqual({ outcome: 'not-covering', reason: 'expires-at-or-before-day-end' });
    expect(
      evaluateShadowGrantCoverage(
        grantRecord({
          shadowImportGrant: { repository: { owner: OWNER, repo: REPO }, expiresAtIso: '2026-11-17T00:00:00.001Z' },
        }),
        DAY_START,
        DAY_END,
      ),
    ).toEqual({ outcome: 'covered' });
  });

  it('returns not-covering when revoked or cancelled', () => {
    for (const state of ['cancelled', 'declined', 'expired']) {
      const evaluation = evaluateShadowGrantCoverage(grantRecord({ state }), DAY_START, DAY_END);
      expect(evaluation).toEqual({ outcome: 'not-covering', reason: 'grant-not-approved' });
    }
  });

  it('returns unavailable for a record whose prototype is neither Object.prototype nor null', () => {
    // OD7a2 fix round: the grant-record snapshot accepts only PLAIN objects
    // (`Object.prototype` or a `null` prototype). A crafted
    // `Object.create(customPrototype)` holding valid own fields is
    // `unavailable`, never `covered`.
    const customPrototype = { isPlain: false };
    const record: Record<string, unknown> = Object.create(customPrototype) as Record<string, unknown>;
    Object.assign(record, grantRecord());
    expect(evaluateShadowGrantCoverage(record, DAY_START, DAY_END)).toEqual({
      outcome: 'unavailable',
      reason: 'invalid-record',
    });
  });

  it('returns unavailable when fields are missing or malformed', () => {
    expect(evaluateShadowGrantCoverage(null, DAY_START, DAY_END).outcome).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(undefined, DAY_START, DAY_END).outcome).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(7, DAY_START, DAY_END).outcome).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(grantRecord({ state: 7 }), DAY_START, DAY_END).outcome).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(grantRecord({ updatedAtIso: 'not-a-date' }), DAY_START, DAY_END).outcome).toBe('unavailable');
    expect(
      evaluateShadowGrantCoverage(
        grantRecord({ shadowImportGrant: { repository: { owner: OWNER, repo: REPO }, expiresAtIso: 'nope' } }),
        DAY_START,
        DAY_END,
      ).outcome,
    ).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(grantRecord({ shadowImportGrant: undefined }), DAY_START, DAY_END).outcome).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(grantRecord(), 'not-a-date', DAY_END).outcome).toBe('unavailable');
    expect(evaluateShadowGrantCoverage(grantRecord({ decisionRevision: 7 }), DAY_START, DAY_END).outcome).toBe('unavailable');
  });

  it('refuses a sparse array with a hole', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse: unknown[] = [, ,];
    expect(evaluateShadowGrantCoverage(sparse, DAY_START, DAY_END)).toEqual({ outcome: 'unavailable', reason: 'invalid-record' });
  });

  it('refuses an array-like object', () => {
    const arrayLike = { length: 1, 0: grantRecord() };
    expect(evaluateShadowGrantCoverage(arrayLike, DAY_START, DAY_END).outcome).toBe('unavailable');
  });

  it('refuses an enormous-length sparse array before any traversal', () => {
    const enormous: unknown[] = new Array(2 ** 32 - 2);
    enormous[0] = grantRecord();
    expect(evaluateShadowGrantCoverage(enormous, DAY_START, DAY_END).outcome).toBe('unavailable');
  });

  it('never runs a getter on the root or on shadowImportGrant', () => {
    let rootCalls = 0;
    let grantCalls = 0;
    const record = {
      get state() {
        rootCalls += 1;
        return 'approved';
      },
      decisionRevision: 'rev-3',
      updatedAtIso: '2026-11-15T20:00:00.000Z',
      get shadowImportGrant() {
        grantCalls += 1;
        return { repository: { owner: OWNER, repo: REPO }, expiresAtIso: '2026-11-18T00:00:00.000Z' };
      },
    };
    const evaluation = evaluateShadowGrantCoverage(record, DAY_START, DAY_END);
    expect(evaluation.outcome).toBe('unavailable');
    expect(rootCalls).toBe(0);
    expect(grantCalls).toBe(0);
  });

  it('runs no get trap on a Proxy over a valid record and yields the plain data verdict', () => {
    let getCalls = 0;
    const valid = grantRecord();
    const proxy = new Proxy(valid, {
      get(target, key, receiver) {
        getCalls += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const evaluation = evaluateShadowGrantCoverage(proxy, DAY_START, DAY_END);
    expect(evaluation).toEqual({ outcome: 'covered' });
    expect(getCalls).toBe(0);
  });

  it('refuses prototype-polluting own keys produced by JSON.parse', () => {
    const polluted: unknown = JSON.parse(
      JSON.stringify(grantRecord()).replace('"id":"shadow-import-test"', '"__proto__":{"polluted":true},"id":"shadow-import-test"'),
    );
    expect(evaluateShadowGrantCoverage(polluted, DAY_START, DAY_END).outcome).toBe('unavailable');
  });

  it('refuses a non-enumerable own constructor key', () => {
    // OD7a2 fix round 6: `Reflect.ownKeys` sees non-enumerable and symbol own
    // keys that `Object.keys` would miss, so a hidden `constructor` is refused
    // as outside the allowed key set.
    const record: Record<string, unknown> = grantRecord();
    Object.defineProperty(record, 'constructor', {
      value: { polluted: true },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    expect(Object.keys(record).includes('constructor')).toBe(false);
    const evaluation = evaluateShadowGrantCoverage(record, DAY_START, DAY_END);
    expect(evaluation).toEqual({ outcome: 'unavailable', reason: 'invalid-record' });
  });

  it('discriminates covering from non-covering records (a constant verdict would fail)', () => {
    const before = evaluateShadowGrantCoverage(grantRecord(), DAY_START, DAY_END);
    const after = evaluateShadowGrantCoverage(grantRecord({ updatedAtIso: '2026-11-16T12:00:00.000Z' }), DAY_START, DAY_END);
    expect(before).toEqual({ outcome: 'covered' });
    expect(after.outcome).toBe('not-covering');
    expect(before).not.toEqual(after);
  });

  it('returns named reason codes, never an echo of the input (an identity function would fail)', () => {
    const record = grantRecord({ state: 'declined' });
    const evaluation = evaluateShadowGrantCoverage(record, DAY_START, DAY_END);
    expect(evaluation).not.toBe(record as unknown);
    expect(evaluation).toEqual({ outcome: 'not-covering', reason: 'grant-not-approved' });
    expect(NAMED_COVERAGE_REASONS.has((evaluation as { reason: string }).reason)).toBe(true);
  });
});

/** Every reason code `evaluateShadowGrantCoverage` may ever name. */
const NAMED_COVERAGE_REASONS: ReadonlySet<string> = new Set([
  'invalid-day-window',
  'invalid-record',
  'invalid-state',
  'grant-not-approved',
  'decision-revision-missing',
  'invalid-decision-revision',
  'updated-at-unparseable',
  'approved-after-day-start',
  'shadow-grant-missing',
  'expires-at-unparseable',
  'expires-at-or-before-day-end',
  'invalid-input',
]);

/** A clean fixture whose daemon `job` ticks all start at 14:00Z (an arming day). */
function afternoonFixture(day: string): Fixture {
  const fixture = cleanFixture(day);
  (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = fixture.daemonEvents.map((event, index) => ({
    ...event,
    recordedAtIso: `${day}T${String(14 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
  }));
  return fixture;
}

/**
 * OD7a2 fix round 7: a fixture whose in-day `job` ticks start exactly at
 * `firstRecordedAtIso` (millisecond precision) and continue once per minute
 * after it — 800 ticks, the clean fixture's count, so S12's tick count passes
 * and only the first-tick guard can hold the day.
 */
function fixtureWithFirstJobTick(day: string, firstRecordedAtIso: string): Fixture {
  const fixture = cleanFixture(day);
  function tickIso(minuteOffset: number): string {
    const hour = String(Math.floor(minuteOffset / 60)).padStart(2, '0');
    const minute = String(minuteOffset % 60).padStart(2, '0');
    return `${day}T${hour}:${minute}:00.000Z`;
  }
  (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = fixture.daemonEvents.map((event, index) => ({
    ...event,
    recordedAtIso: index === 0 ? firstRecordedAtIso : tickIso(15 + index),
  }));
  return fixture;
}

/** A scheduled harness: the given fixture plus a `shadowGrantCoverage` reader. */
function scheduledHarness(
  fixture: Fixture,
  coverage: (input: { day: string; repository: { owner: string; repo: string } }) => Promise<
    | { outcome: 'covered' }
    | { outcome: 'not-covering'; reason?: string }
    | { outcome: 'unavailable'; reason?: string }
  > = async () => ({ outcome: 'covered' }),
): Harness {
  const harness = makeHarness(fixture, NOW);
  const deps: RecordShadowDayDependencies = { ...harness.deps, shadowGrantCoverage: coverage };
  return { ...harness, deps };
}

/** Asserts a scheduled-mode guard hold: the typed skip and that nothing was written. */
function expectSkippedWithoutWrite(result: RecordShadowDayResult, reason: string): void {
  expect(result).toEqual({ outcome: 'skipped', reason });
}

describe('RecordShadowDayUseCase scheduled mode (OD7a2)', () => {
  const ARMING_DAY = '2026-11-15';

  it('scheduled mode skips arming day with first job tick at 14:00Z without writing and records next full day', async () => {
    const harness = scheduledHarness(afternoonFixture(ARMING_DAY));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ day: ARMING_DAY, scheduled: true }),
    );
    expectSkippedWithoutWrite(result, 'partial-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();

    // The next full day records normally under the same scheduled mode.
    const nextHarness = scheduledHarness(cleanFixture(DAY));
    const next = await new RecordShadowDayUseCase(nextHarness.deps).execute(makeRequest({ scheduled: true }));
    expectRecorded(next);
    expect(nextHarness.evidence.stored?.days.find((entry) => entry.day === DAY)).toBeDefined();
  });

  it('scheduled mode ignores status-only early events', async () => {
    const fixture = afternoonFixture(DAY);
    const statusEvent: DaemonEventRecord = {
      ...daemonJobEvent(0, DAY),
      kind: 'status',
      jobId: 'status:probe',
      recordedAtIso: `${DAY}T00:05:00.000Z`,
    };
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = [statusEvent, ...fixture.daemonEvents];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'partial-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  // OD7a2 fix round: a Proxy must not be able to make the validator's
  // descriptor reads and the later plain reads disagree. The snapshot path
  // reads descriptors only, so the `get` trap below (which would satisfy the
  // early-tick guard with a lying early `job`) never runs.
  it('treats a Proxy whose descriptors describe a late status event as the late status event, not the get-trap early job', async () => {
    const fixture = afternoonFixture(DAY);
    const lateStatus: DaemonEventRecord = {
      ...daemonJobEvent(0, DAY),
      kind: 'status',
      jobId: 'status:probe',
      recordedAtIso: `${DAY}T14:00:00.000Z`,
    };
    let getTrapCalls = 0;
    const lyingProxy: unknown = new Proxy(lateStatus, {
      get(target, property) {
        getTrapCalls += 1;
        if (property === 'kind') {
          return 'job';
        }
        if (property === 'recordedAtIso') {
          return `${DAY}T00:05:00.000Z`;
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    (fixture as { daemonEvents: unknown[] }).daemonEvents = [lyingProxy, ...fixture.daemonEvents];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    // The late `status` snapshot does not satisfy the early-tick guard: the
    // day is skipped as partial, and the lying early `job` is never seen.
    expectSkippedWithoutWrite(result, 'partial-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
    expect(getTrapCalls).toBe(0);
  });

  // OD7a2 fix round 7: the first-tick grace boundary is inclusive — the
  // earliest `job` tick at exactly `00:00Z + SHADOW_FIRST_TICK_GRACE_MS`
  // (`00:15:00.000Z`) passes the guard and the day records; one millisecond
  // later is refused as `partial-day`. Catches widening the grace.
  it('accepts a first job tick exactly at 00:15:00.000Z and refuses one at 00:15:00.001Z', async () => {
    const exactHarness = scheduledHarness(fixtureWithFirstJobTick(DAY, `${DAY}T00:15:00.000Z`));
    const exactResult = await new RecordShadowDayUseCase(exactHarness.deps).execute(makeRequest({ scheduled: true }));
    expectRecorded(exactResult);
    expect(exactHarness.evidence.stored?.days.find((entry) => entry.day === DAY)).toBeDefined();

    const lateHarness = scheduledHarness(fixtureWithFirstJobTick(DAY, `${DAY}T00:15:00.001Z`));
    const lateResult = await new RecordShadowDayUseCase(lateHarness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(lateResult, 'partial-day');
    expect(lateHarness.evidence.calls.cas).toBe(0);
    expect(lateHarness.evidence.stored).toBeNull();
  });

  // OD7a2 fix round 7: the request is snapshotted once at entry — a data
  // property `scheduled: true` redefined to `false` (from inside the coverage
  // reader stub, after `execute()` began) must not change the mode. If any
  // code path re-read the raw request, the day would silently drop out of
  // scheduled mode and record an arming day.
  // OD7a2 fix round 7: the raw request's `scheduled` property is read exactly
  // ONCE across the whole `execute()` — through its own data descriptor at the
  // entry snapshot — and never again afterwards. A second read would let a
  // later re-read see a redefined value and silently drop out of scheduled
  // mode; the descriptor-read counter below fails if any code path re-reads
  // the raw request.
  it('reads scheduled on the raw request exactly once across execute()', async () => {
    const harness = scheduledHarness(cleanFixture(DAY));
    const scheduledDescriptorReads: string[] = [];
    const proxied: RecordShadowDayRequest = new Proxy(makeRequest({ scheduled: true }), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'scheduled') {
          scheduledDescriptorReads.push('scheduled');
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(proxied);
    expectRecorded(result);
    expect(scheduledDescriptorReads).toEqual(['scheduled']);
    expect(harness.evidence.stored?.days.find((entry) => entry.day === DAY)).toBeDefined();
  });

  it('still treats the day as scheduled when the raw request scheduled data property is redefined to false after execute() begins', async () => {
    const request = makeRequest({ day: ARMING_DAY, scheduled: true });
    const harness = scheduledHarness(afternoonFixture(ARMING_DAY), async (input) => {
      void input;
      Object.defineProperty(request, 'scheduled', {
        value: false,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return { outcome: 'covered' as const };
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expectSkippedWithoutWrite(result, 'partial-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode skips partial-day ticks without writing and records next full day', async () => {
    const fixture = cleanFixture(DAY);
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = [daemonJobEvent(0, DAY), daemonJobEvent(1, DAY)];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'too-few-ticks');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();

    const nextHarness = scheduledHarness(cleanFixture(DAY));
    const next = await new RecordShadowDayUseCase(nextHarness.deps).execute(makeRequest({ scheduled: true }));
    expectRecorded(next);
  });

  it('scheduled mode skips when grant approved mid-day', async () => {
    const harness = scheduledHarness(cleanFixture(DAY), async () => ({
      outcome: 'not-covering' as const,
      reason: 'approved-after-day-start',
    }));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'grant-not-covering-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
    // The grant guard runs before the daemon events are even read.
    expect(harness.otherCalls.daemon).toBe(0);
  });

  it('scheduled mode skips when grant expires mid-day', async () => {
    const harness = scheduledHarness(cleanFixture(DAY), async () => ({
      outcome: 'not-covering' as const,
      reason: 'expires-at-or-before-day-end',
    }));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'grant-not-covering-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode skips when grant is revoked', async () => {
    const harness = scheduledHarness(cleanFixture(DAY), async () => ({
      outcome: 'not-covering' as const,
      reason: 'grant-not-approved',
    }));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'grant-not-covering-day');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode skips when grant is undeterminable', async () => {
    // (a) the coverage reader is not wired at all.
    const absent = makeHarness(cleanFixture(DAY), NOW);
    const absentResult = await new RecordShadowDayUseCase(absent.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(absentResult, 'grant-unavailable');
    expect(absent.evidence.calls.cas).toBe(0);
    // (b) the reader reports `unavailable`.
    const unavailable = scheduledHarness(cleanFixture(DAY), async () => ({ outcome: 'unavailable' as const }));
    const unavailableResult = await new RecordShadowDayUseCase(unavailable.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(unavailableResult, 'grant-unavailable');
    expect(unavailable.evidence.calls.cas).toBe(0);
    // (c) the reader throws.
    const threw = scheduledHarness(cleanFixture(DAY), async () => {
      throw new Error('coordination store down');
    });
    const threwResult = await new RecordShadowDayUseCase(threw.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(threwResult, 'grant-unavailable');
    expect(threw.evidence.calls.cas).toBe(0);
  });

  // OD7a2 fix round: the grant guard is an allow-list — recording may proceed
  // ONLY when the reader returns exactly `{ outcome: 'covered' }`. Every other
  // value (an unrecognized outcome, a malformed object, `null`) is skipped and
  // writes nothing.
  it.each([
    ['{ outcome: bogus }', { outcome: 'bogus' }],
    ['{ outcome: unknown }', { outcome: 'unknown' }],
    ['{}', {}],
    ['null', null],
  ])('scheduled mode writes nothing when the coverage reader returns %s', async (_name, value) => {
    const harness = scheduledHarness(
      cleanFixture(DAY),
      async () => value as { outcome: 'covered' },
    );
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'grant-unavailable');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode fails closed with unknown when daemon events are unreadable', async () => {
    for (const mode of ['throws', 'not-ok'] as const) {
      const harness = scheduledHarness(cleanFixture(DAY));
      const projection = harness.deps.daemonEvents as {
        readAfterCursor: () => Promise<unknown>;
      };
      projection.readAfterCursor =
        mode === 'throws'
          ? async () => {
              throw new Error('projection unreadable');
            }
          : async () => ({ ok: false as const, reason: 'invalid-cursor' as const });
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
      expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-unavailable' });
      expect(harness.evidence.calls.cas).toBe(0);
      expect(harness.evidence.stored).toBeNull();
    }
  });

  it('scheduled mode never throws on malformed daemon events and writes nothing', async () => {
    // OD7a2 fix round: the first-tick loop dereferences `event.kind` before
    // S12 validates the events, so `readAfterCursor` may hand it anything.
    // OD7a3 fix round 6: a malformed event FAILS CLOSED at the snapshot —
    // `snapshotEventsRead` snapshots every event exactly once, and an event
    // that fails to snapshot makes the WHOLE read `'malformed'`, which
    // stops the run as `daemon-events-corrupt` before anything is written,
    // never as a silently shortened event list.
    const harness = scheduledHarness(cleanFixture(DAY));
    const projection = harness.deps.daemonEvents as {
      readAfterCursor: () => Promise<unknown>;
    };
    projection.readAfterCursor = async () => ({ ok: true as const, events: [null, 42, {}], nextCursor: null });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode fails closed with unknown when one null event joins 800 valid in-day job ticks', async () => {
    // OD7a2 fix round 6: 800 good ticks plus ONE null must not pass S12 on a
    // shortened list — a single un-snapshotable event makes the whole read
    // (and so the whole S12 evaluation) unknown, and nothing is written.
    const fixture = cleanFixture(DAY);
    const valid = Array.from({ length: 800 }, (_, index) => daemonJobEvent(index, DAY));
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = [
      ...valid,
      null as unknown as DaemonEventRecord,
    ];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode fails closed with unknown when S12 evaluates unknown', async () => {
    const fixture = cleanFixture(DAY);
    // An event carrying an extra key fails the exact-keys record read, so S12
    // evaluates `unknown` while the first-tick guard (a valid 00:00Z job tick)
    // still passes.
    const malformed = { ...daemonJobEvent(0, DAY), extra: 1 } as unknown as DaemonEventRecord;
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = [malformed, ...fixture.daemonEvents];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 's12-unknown' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('refuses non-boolean scheduled', async () => {
    const harness = scheduledHarness(cleanFixture(DAY));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(
      makeRequest({ scheduled: 'true' as unknown as boolean }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.evidence.calls.cas).toBe(0);
  });

  it('refuses a throwing scheduled getter without running the run', async () => {
    const harness = scheduledHarness(cleanFixture(DAY));
    const request = {
      repository: REPOSITORY,
      legacyStateDir: LEGACY_STATE_DIR,
      day: DAY,
      get scheduled(): boolean {
        throw new Error('hostile getter');
      },
    } as unknown as RecordShadowDayRequest;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.evidence.calls.cas).toBe(0);
  });

  it('refuses a scheduled getter that flips from true to false between reads, writing nothing', async () => {
    const harness = scheduledHarness(cleanFixture(DAY));
    let reads = 0;
    const request = {
      repository: REPOSITORY,
      legacyStateDir: LEGACY_STATE_DIR,
      day: DAY,
      get scheduled(): boolean {
        reads += 1;
        return reads === 1;
      },
    } as unknown as RecordShadowDayRequest;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    // OD7a2 fix round: the request is snapshotted once at entry and an
    // accessor is refused, so the flip-flop getter never runs twice and can
    // never pass validation and then skip the scheduled guards.
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(reads).toBe(0);
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('accepts a Proxy over a valid scheduled request and records normally', async () => {
    const harness = scheduledHarness(cleanFixture(DAY));
    const proxied = new Proxy(makeRequest({ scheduled: true }), {});
    const result = await new RecordShadowDayUseCase(harness.deps).execute(proxied);
    expectRecorded(result);
  });

  it('returns deadline-exceeded when the deadline is reached during the scheduled tick-health precheck', async () => {
    const harness = scheduledHarness(cleanFixture(DAY), async (input) => {
      void input;
      // The grant read advances the fake clock past the deadline; the very
      // next precheck port call (the daemon-events read for S12) must then
      // abort the run with `deadline-exceeded`, never a skip or a write.
      harness.setNow(DEADLINE);
      return { outcome: 'covered' as const };
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('never rejects when the events are a null entry and one valid 00:00Z job tick, and writes nothing', async () => {
    // OD7a2 fix round 6: a null entry FAILS CLOSED. The un-snapshotable event
    // makes the whole read `'malformed'` (OD7a3 fix round 6: the snapshot is
    // all-or-nothing), stopping the run as `daemon-events-corrupt` before
    // the first-tick guard or S12 runs, never as a silently shortened event
    // list, and nothing is written.
    const fixture = cleanFixture(DAY);
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = [null, daemonJobEvent(0, DAY)] as unknown as DaemonEventRecord[];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('resolves to unknown and writes nothing when an event is a Proxy with a throwing getOwnPropertyDescriptor trap', async () => {
    // The event survives the own-data validator (its `kind`/`recordedAtIso`
    // are plain own data strings, so the validator's two probes succeed), but
    // the same trap throws for every projection key S12's exact-keys reader
    // requests. S12's reader catches the throw as malformed, the day is
    // undeterminable, and the scheduled run fails closed as unknown writing
    // nothing — never a sticky verdict, never a rejection.
    const fixture = cleanFixture(DAY);
    const poisoned = new Proxy(daemonJobEvent(0, DAY), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'kind' || key === 'recordedAtIso') {
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
        throw new Error('descriptor trap');
      },
    });
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = [poisoned] as unknown as DaemonEventRecord[];
    const harness = scheduledHarness(fixture);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 's12-unknown' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('resolves to unknown and writes nothing when a stubbed dependency throws inside the scheduled path', async () => {
    // A stub whose throw is swallowed by `call` would be a typed `threw`
    // (skip or unknown-daemon-events), so the backstop is exercised by a stub
    // that throws when the scheduled path READS its returned value, outside
    // the awaited call: any unexpected exception on that path must fail
    // closed as `scheduled-evaluation-failed` and write nothing.
    const harness = scheduledHarness(cleanFixture(DAY), async () => {
      return new Proxy(
        { outcome: 'covered' },
        {
          get(_target, key) {
            // `await` probes `.then` on the resolved value; letting that one
            // through lets the stub reach the caller, whose `.outcome` read
            // is what explodes.
            if (key === 'then') {
              return undefined;
            }
            throw new Error('coverage result exploded');
          },
        },
      ) as unknown as { outcome: 'covered' };
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'scheduled-evaluation-failed' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });
});

describe('RecordShadowDayUseCase S12 coverage guards and corrupt daemon-event lines (OD7a3)', () => {
  const PREV_DAY = '2026-11-15';

  /** The clean fixture with every tick at or after `hour` removed (the daemon died). */
  function deadFromFixture(hour: number): Fixture {
    const fixture = cleanFixture(DAY);
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = fixture.daemonEvents.filter(
      (event) => Date.parse(event.recordedAtIso) < Date.parse(`${DAY}T${String(hour).padStart(2, '0')}:00:00Z`),
    );
    return fixture;
  }

  /** The clean fixture with a 40-minute hole from 09:01Z to 09:40Z (indices 541..579). */
  function gapFixture(): Fixture {
    const fixture = cleanFixture(DAY);
    (fixture as { daemonEvents: DaemonEventRecord[] }).daemonEvents = fixture.daemonEvents.filter((event) => {
      const minute = (Date.parse(event.recordedAtIso) - Date.parse(`${DAY}T00:00:00Z`)) / 60_000;
      return minute <= 540 || minute >= 580;
    });
    return fixture;
  }

  /** The harness with the daemon-events read replaced by a fixed `DaemonEventCursorRead`. */
  function harnessWithRead(harness: Harness, read: unknown): Harness {
    const deps: RecordShadowDayDependencies = {
      ...harness.deps,
      daemonEvents: { readAfterCursor: async () => read as Awaited<ReturnType<typeof harness.deps.daemonEvents.readAfterCursor>> },
    };
    return { ...harness, deps };
  }

  /** A full-day read whose `eventPositions` are the natural 0..n-1 indexes. */
  function dayRead(events: readonly DaemonEventRecord[], droppedLines?: readonly number[], eventPositions?: readonly number[]): unknown {
    return {
      ok: true,
      events,
      nextCursor: null,
      eventPositions: eventPositions ?? events.map((_, index) => index),
      ...(droppedLines === undefined ? {} : { droppedLines }),
    };
  }

  it('scheduled mode skips late-last-tick when the daemon is dead from 13:00Z, writing nothing', async () => {
    const harness = scheduledHarness(deadFromFixture(13));
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'late-last-tick');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('scheduled mode skips coverage-gap for a 40-minute hole at 09:00Z, writing nothing', async () => {
    const harness = scheduledHarness(gapFixture());
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ scheduled: true }));
    expectSkippedWithoutWrite(result, 'coverage-gap');
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('manual mode refuses late-last-tick without writing to the ledger', async () => {
    const harness = makeHarness(deadFromFixture(13), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'late-last-tick' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('manual mode refuses coverage-gap without writing to the ledger', async () => {
    const harness = makeHarness(gapFixture(), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'coverage-gap' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  });

  it('manual mode still records a full day with regular ticks (the guards hold only on coverage failures)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S12).toBe('pass');
  });

  it('answers unknown daemon-events-corrupt when a dropped line is bracketed inside the day, writing nothing', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = dayRead(harness.deps ? cleanFixture(DAY).daemonEvents : [], [700]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
  });

  // OD7a3 fix round: the same bracketed corrupt line makes SCHEDULED mode
  // unknown too — scheduled prechecks must not turn a bracketed corrupt line
  // into a skip or a write.
  it('scheduled mode answers unknown daemon-events-corrupt for a valid bracketed droppedLines, writing nothing', async () => {
    const harness = scheduledHarness(cleanFixture(DAY));
    const read = dayRead(cleanFixture(DAY).daemonEvents, [700]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
  });

  it('reads a Proxy event whose recordedAtIso descriptor changes between reads exactly once, and a bracketed corrupt line still makes the day unknown', async () => {
    // OD7a3 fix round 6 (structural): `snapshotEventsRead` snapshots EVERY
    // event exactly once, immediately after the port returns, and every
    // downstream consumer (bracket, first-tick guard, S12 inputs) sees only
    // the frozen copies. So a Proxy event whose `recordedAtIso` own
    // descriptor returns a different value on each read is read exactly
    // once — the FIRST read is the one used everywhere — and a corrupt line
    // bracketed by in-day records still makes the day
    // `unknown/daemon-events-corrupt` with nothing written.
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let descriptorReads = 0;
    const base = daemonJobEvent(0, DAY);
    const shifting = new Proxy(base, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'recordedAtIso') {
          descriptorReads += 1;
          return {
            value:
              descriptorReads === 1
                ? (target as DaemonEventRecord).recordedAtIso
                : `${PREV_DAY}T00:00:00Z`,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    // One in-day parsed record at position 0, and a dropped line at
    // position 0 — bracketed by that record's bracket [0, 0].
    const read = dayRead([shifting as unknown as DaemonEventRecord], [0]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(descriptorReads).toBe(1);
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
  });

  it('ignores a corrupt line on an earlier day (outside the target day bracket) and records normally', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const prevEvents = [1380, 1381, 1382].map((index) => daemonJobEvent(index, PREV_DAY));
    const events = [...prevEvents, ...cleanFixture(DAY).daemonEvents];
    const read = dayRead(events, [1]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S12).toBe('pass');
    expect(guarded.evidence.stored?.days.find((entry) => entry.day === DAY)).toBeDefined();
  });

  it('records normally when the dropped line lies outside the day bracket even on the same file', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const events = cleanFixture(DAY).daemonEvents;
    const read = dayRead(events, [events.length + 5], events.map((_, index) => index));
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S12).toBe('pass');
  });

  it('ignores dropped lines when the day has no in-day parsed records (no bracket)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const prevEvents = [1380, 1381, 1382].map((index) => daemonJobEvent(index, PREV_DAY));
    const read = dayRead(prevEvents, [1]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expectRecorded(result);
    // No in-day events means S12 fails too-few-ticks (recorded), never unknown.
    expect(result.recorded.S12).toBe('fail');
  });

  it('treats a missing droppedLines field as no dropped lines (backwards compatibility)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = { ok: true, events: cleanFixture(DAY).daemonEvents, nextCursor: null };
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S12).toBe('pass');
  });

  it.each([
    ['a non-array droppedLines', 'nope'],
    ['a negative position', [-1]],
    ['a non-integer position', [1.5]],
    ['a wrong primitive (a number where a list is due)', 42],
    ['a non-iterable object where a list is due', {}],
    ['an array-like object where a list is due', { length: 1, 0: 3 }],
    ['a wrong primitive position element', ['x']],
  ])('answers unknown daemon-events-corrupt for %s', async (_title, droppedLines) => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = dayRead(cleanFixture(DAY).daemonEvents, droppedLines as readonly number[]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
  });

  // OD7a3 fix round: a malformed `droppedLines` fails closed BEFORE any
  // bracketing logic, so it stays `unknown` even when the day has no in-day
  // parsed records (no bracket) — in BOTH modes, writing nothing.
  it.each([
    ['a negative position', [-1]],
    ['a non-integer position', [1.5]],
    ['a wrong primitive position element', ['x']],
    ['a non-array droppedLines', 'nope'],
  ])('answers unknown daemon-events-corrupt for %s with no in-day records (manual mode)', async (_title, droppedLines) => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const prevEvents = [1380, 1381, 1382].map((index) => daemonJobEvent(index, PREV_DAY));
    const read = dayRead(prevEvents, droppedLines as readonly number[]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
  });

  it.each([
    ['a negative position', [-1]],
    ['a non-integer position', [1.5]],
  ])('answers unknown daemon-events-corrupt for %s with no in-day records (scheduled mode)', async (_title, droppedLines) => {
    const harness = scheduledHarness(cleanFixture(DAY));
    const prevEvents = [1380, 1381, 1382].map((index) => daemonJobEvent(index, PREV_DAY));
    const read = dayRead(prevEvents, droppedLines as readonly number[]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest({ scheduled: true }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
  });

  it('answers unknown daemon-events-corrupt for a Proxy over a read with a malformed droppedLines and no in-day records', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let getTrapCalls = 0;
    const trapKeys: string[] = [];
    const prevEvents = [1380, 1381, 1382].map((index) => daemonJobEvent(index, PREV_DAY));
    const plain = dayRead(prevEvents, [-1]) as Record<string, unknown>;
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        // Awaiting the port result makes the promise protocol probe `then`
        // on the resolved value; that is not a data read, so it is not
        // counted — every data key must stay trap-free.
        if (key !== 'then') {
          getTrapCalls += 1;
          trapKeys.push(String(key));
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const guarded = harnessWithRead(harness, proxy);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
    expect(getTrapCalls, trapKeys.join()).toBe(0);
  });

  it('answers unknown daemon-events-corrupt for a sparse droppedLines array (an array hole)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const sparse: number[] = [0];
    delete sparse[0];
    const read = dayRead(cleanFixture(DAY).daemonEvents, sparse);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
  });

  it('refuses an enormous sparse droppedLines length before any traversal', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const huge: number[] = [];
    huge.length = 2 ** 32 - 1;
    const read = dayRead(cleanFixture(DAY).daemonEvents, huge);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
  });

  it('answers unknown daemon-events-corrupt for a non-empty droppedLines with a missing eventPositions', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = { ok: true, events: cleanFixture(DAY).daemonEvents, nextCursor: null, droppedLines: [0] };
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
  });

  it('answers unknown daemon-events-corrupt when eventPositions length does not match events.length', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = dayRead(cleanFixture(DAY).daemonEvents, [0], [0]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
  });

  it('never runs a getter on a droppedLines element (own descriptor reads only)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let getterCalls = 0;
    const droppedLines: number[] = [0, 1];
    Object.defineProperty(droppedLines, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 0;
      },
    });
    const read = dayRead(cleanFixture(DAY).daemonEvents, droppedLines);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(getterCalls).toBe(0);
  });

  it('never runs a getter on the read root (own descriptor reads only)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let getterCalls = 0;
    const read: Record<string, unknown> = dayRead(cleanFixture(DAY).daemonEvents, [700]) as Record<string, unknown>;
    Object.defineProperty(read, 'droppedLines', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [700];
      },
    });
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(getterCalls).toBe(0);
  });

  it('answers exactly the plain result over a Proxy read (the inspection never trusts a get trap)', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const plain = dayRead(cleanFixture(DAY).daemonEvents, [700]) as Record<string, unknown>;
    let getTrapCalls = 0;
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        // Awaiting the port result makes the promise protocol probe `then`
        // on the resolved value; that is not a data read, so it is not
        // counted — every data key must stay trap-free.
        if (key !== 'then') {
          getTrapCalls += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const guarded = harnessWithRead(harness, proxy);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    // The Proxy must yield exactly the plain data's verdict, and no `get`
    // trap may run for a data key: the inspection and the `ok` check read
    // only through own data descriptors.
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    const plainResult = await new RecordShadowDayUseCase(harnessWithRead(makeHarness(cleanFixture(DAY), NOW), plain).deps).execute(makeRequest());
    expect(result).toEqual(plainResult);
    expect(getTrapCalls).toBe(0);
  });

  it('is not satisfiable by a constant refusal: a clean read without dropped lines records normally', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = dayRead(cleanFixture(DAY).daemonEvents, [10_000]);
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded.S12).toBe('pass');
  });

  it('is not an identity echo of the input: the answer carries no droppedLines or events field', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const read = dayRead(cleanFixture(DAY).daemonEvents, [700]) as Record<string, unknown>;
    const guarded = harnessWithRead(harness, read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect(result).not.toHaveProperty('events');
    expect(result).not.toHaveProperty('droppedLines');
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
  });

  // OD7a3 fix round: the read result is snapshotted once through its own data
  // descriptors (`snapshotEventsRead`), so a Proxy whose `get` trap lies
  // about `events` while its descriptors describe a valid full-day read must
  // yield exactly the plain read's result — never a shortened list, and
  // never `too-few-ticks`. Tested in scheduled AND manual mode.
  it.each(['scheduled', 'manual'] as const)('a Proxy whose get returns events: [] over a valid full-day read gives the plain read result, never too-few-ticks (%s mode)', async (mode) => {
    const plain = dayRead(cleanFixture(DAY).daemonEvents) as Record<string, unknown>;
    const lying = new Proxy(plain, {
      get(target, key, receiver) {
        // The promise protocol probes `then` on the awaited value; that is
        // not a data read. Every data key goes through this trap, which lies
        // about `events` — the snapshot must never consult it.
        if (key === 'events') {
          return [];
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const proxiedResult =
      mode === 'scheduled'
        ? await new RecordShadowDayUseCase(harnessWithRead(scheduledHarness(cleanFixture(DAY)), lying).deps).execute(
            makeRequest({ scheduled: true }),
          )
        : await new RecordShadowDayUseCase(harnessWithRead(makeHarness(cleanFixture(DAY), NOW), lying).deps).execute(makeRequest());
    const plainResult =
      mode === 'scheduled'
        ? await new RecordShadowDayUseCase(harnessWithRead(scheduledHarness(cleanFixture(DAY)), plain).deps).execute(
            makeRequest({ scheduled: true }),
          )
        : await new RecordShadowDayUseCase(harnessWithRead(makeHarness(cleanFixture(DAY), NOW), plain).deps).execute(makeRequest());
    expect(proxiedResult).toEqual(plainResult);
    expect(proxiedResult).toHaveProperty('recorded');
    expect((proxiedResult as { recorded: Record<string, string> }).recorded.S12).toBe('pass');
  });

  // OD7a3 fix round: a Proxy whose `getOwnPropertyDescriptor` trap throws is
  // caught by `snapshotEventsRead` and fails closed as
  // `unknown/daemon-events-corrupt`, writing nothing, and `execute()`
  // resolves without throwing. Tested in scheduled AND manual mode.
  it.each(['scheduled', 'manual'] as const)('a Proxy with a throwing getOwnPropertyDescriptor trap gives unknown daemon-events-corrupt and writes nothing (%s mode)', async (mode) => {
    const plain = dayRead(cleanFixture(DAY).daemonEvents) as Record<string, unknown>;
    const explosive = new Proxy(plain, {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor trap');
      },
    });
    const harness =
      mode === 'scheduled' ? scheduledHarness(cleanFixture(DAY)) : makeHarness(cleanFixture(DAY), NOW);
    const guarded = harnessWithRead(harness, explosive);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(
      mode === 'scheduled' ? makeRequest({ scheduled: true }) : makeRequest(),
    );
    expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
    expect(guarded.evidence.calls.cas).toBe(0);
    expect(guarded.evidence.stored).toBeNull();
  });

  // OD7a3 fix round 4: only an own DATA property `ok === false` means
  // `{ ok: false }`. A read whose `ok` is an accessor, which lacks `ok`, or
  // whose `ok` is not a boolean is `'malformed'` — `unknown` /
  // `daemon-events-corrupt` with nothing written in both modes — never a
  // silent "no events" answer.
  it.each(['scheduled', 'manual'] as const)(
    'answers unknown daemon-events-corrupt for an accessor ok (%s mode)',
    async (mode) => {
      const events = cleanFixture(DAY).daemonEvents;
      const read: Record<string, unknown> = { ok: true, events, nextCursor: null };
      Object.defineProperty(read, 'ok', {
        enumerable: true,
        get() {
          return true;
        },
      });
      const harness =
        mode === 'scheduled' ? scheduledHarness(cleanFixture(DAY)) : makeHarness(cleanFixture(DAY), NOW);
      const guarded = harnessWithRead(harness, read);
      const result = await new RecordShadowDayUseCase(guarded.deps).execute(
        mode === 'scheduled' ? makeRequest({ scheduled: true }) : makeRequest(),
      );
      expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
      expect(guarded.evidence.calls.cas).toBe(0);
      expect(guarded.evidence.stored).toBeNull();
    },
  );

  it.each(['scheduled', 'manual'] as const)(
    'answers unknown daemon-events-corrupt for a read that lacks ok (%s mode)',
    async (mode) => {
      const read = { events: cleanFixture(DAY).daemonEvents, nextCursor: null };
      const harness =
        mode === 'scheduled' ? scheduledHarness(cleanFixture(DAY)) : makeHarness(cleanFixture(DAY), NOW);
      const guarded = harnessWithRead(harness, read);
      const result = await new RecordShadowDayUseCase(guarded.deps).execute(
        mode === 'scheduled' ? makeRequest({ scheduled: true }) : makeRequest(),
      );
      expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
      expect(guarded.evidence.calls.cas).toBe(0);
      expect(guarded.evidence.stored).toBeNull();
    },
  );

  it.each(['scheduled', 'manual'] as const)(
    "answers unknown daemon-events-corrupt for a read whose ok is 'yes' (%s mode)",
    async (mode) => {
      const read = { ok: 'yes', events: cleanFixture(DAY).daemonEvents, nextCursor: null };
      const harness =
        mode === 'scheduled' ? scheduledHarness(cleanFixture(DAY)) : makeHarness(cleanFixture(DAY), NOW);
      const guarded = harnessWithRead(harness, read);
      const result = await new RecordShadowDayUseCase(guarded.deps).execute(
        mode === 'scheduled' ? makeRequest({ scheduled: true }) : makeRequest(),
      );
      expect(result).toEqual({ outcome: 'unknown', reason: 'daemon-events-corrupt' });
      expect(guarded.evidence.calls.cas).toBe(0);
      expect(guarded.evidence.stored).toBeNull();
    },
  );

  it('still treats an own data ok: false as a failed read (not malformed), leaving S12 unevaluated', async () => {
    const read = { ok: false, events: [], nextCursor: null };
    const guarded = harnessWithRead(makeHarness(cleanFixture(DAY), NOW), read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    expect((result as unknown as { unevaluated: Array<{ criterion: string; reason: string }> }).unevaluated).toContainEqual(
      expect.objectContaining({ criterion: 'S12', reason: 'daemon-events-unavailable' }),
    );
  });

  // OD7a3 fix round 4: each droppedLines/eventPositions element is read
  // exactly ONCE into the snapshot and the COPIED values are what is
  // validated, so a Proxy whose index descriptor changes between reads
  // cannot make the validator see a valid position and the snapshot a
  // different one: the result must reflect a single read — exactly the plain
  // data's result.
  it('answers exactly the plain result for a Proxy whose index descriptor changes between reads (a single read)', async () => {
    const events = cleanFixture(DAY).daemonEvents;
    // A dropped line far OUTSIDE the day bracket: the plain read records
    // normally, so the only way to differ from it is a second read.
    // `droppedLines` itself is the Proxy: each element's
    // `getOwnPropertyDescriptor` trap is honest on its FIRST call and
    // poisoned on every LATER call, so a double read (validate then
    // snapshot) sees two different values while the fixed single-read
    // snapshot sees only the honest one.
    const honest: number[] = [events.length + 5];
    const perKeyReads = new Map<string, number>();
    const shifting = new Proxy(honest, {
      getOwnPropertyDescriptor(target, key) {
        const keyName = String(key);
        const seen = perKeyReads.get(keyName) ?? 0;
        perKeyReads.set(keyName, seen + 1);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        // A `Object.keys` shape check probes each key's descriptor once for
        // enumerability BEFORE any value read. So a single-value-read
        // implementation spends two descriptor calls per element (probe +
        // read), while a double-reading implementation spends three — and
        // the third one is poisoned.
        if (seen < 2 || descriptor === undefined || !/^\d+$/.test(keyName)) {
          return descriptor;
        }
        return { ...descriptor, value: 'poisoned' };
      },
    });
    const plain = dayRead(events, [events.length + 5], events.map((_, index) => index)) as Record<string, unknown>;
    const read = { ...plain, droppedLines: shifting };
    const guarded = harnessWithRead(makeHarness(cleanFixture(DAY), NOW), read);
    const result = await new RecordShadowDayUseCase(guarded.deps).execute(makeRequest());
    const plainResult = await new RecordShadowDayUseCase(harnessWithRead(makeHarness(cleanFixture(DAY), NOW), plain).deps).execute(makeRequest());
    expect(result).toEqual(plainResult);
    expectRecorded(result);
    expect((result as { recorded: Record<string, string> }).recorded.S12).toBe('pass');
  });
});

/**
 * BL01: hostile-input hardening of `RecordShadowDayUseCase.execute` (the
 * request snapshot and its repository), the CAS retry paths, the CAS
 * refusal/throw mappings, and the empty-day / drift asymmetry.
 */
describe('RecordShadowDayUseCase hostile input, CAS retries and empty-day asymmetry (BL01)', () => {
  /** The deps are readonly in the contract; tests swap fakes through this mutable view. */
  type MutableDeps = {
    -readonly [K in keyof RecordShadowDayDependencies]: RecordShadowDayDependencies[K];
  };
  /** The common hostile assertions: refused invalid-request, nothing written, no CAS. */
  function expectRefused(
    harness: Harness,
    result: RecordShadowDayResult,
  ): void {
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.evidence.calls.cas).toBe(0);
    expect(harness.evidence.stored).toBeNull();
  }

  it('refuses a null request as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(null as unknown as RecordShadowDayRequest));
  });

  it('refuses an undefined request as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(undefined as unknown as RecordShadowDayRequest));
  });

  it('refuses a wrong primitive (a number where a record is due) as invalid-request, never echoing it', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const result = await new RecordShadowDayUseCase(harness.deps).execute(7 as unknown as RecordShadowDayRequest);
    // The result is the exact typed refusal — an identity echo of the input
    // (or any shape carrying the raw value) would fail this toEqual.
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(harness.evidence.calls.cas).toBe(0);
  });

  it('refuses an array request as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute([makeRequest()] as unknown as RecordShadowDayRequest));
  });

  it('refuses a non-plain object (a Date) as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(new Date() as unknown as RecordShadowDayRequest));
  });

  it('refuses a prototype-polluting own __proto__ key produced by JSON.parse as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = JSON.parse('{"repository":{"owner":"octo","repo":"train"},"legacyStateDir":"/state/legacy","day":"2026-11-16","__proto__":{"admin":true}}');
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile as RecordShadowDayRequest));
  });

  it('refuses a prototype-polluting own constructor key produced by JSON.parse as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = JSON.parse('{"repository":{"owner":"octo","repo":"train"},"legacyStateDir":"/state/legacy","day":"2026-11-16","constructor":{"prototype":{}}}');
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile as RecordShadowDayRequest));
  });

  it('refuses a prototype-polluting own prototype key produced by JSON.parse as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = JSON.parse('{"repository":{"owner":"octo","repo":"train"},"legacyStateDir":"/state/legacy","day":"2026-11-16","prototype":{}}');
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile as RecordShadowDayRequest));
  });

  it('refuses a symbol own key as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = { ...makeRequest(), [Symbol('hostile')]: 1 } as unknown as RecordShadowDayRequest;
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a request with more than MAX_REQUEST_OWN_KEYS own keys as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = { ...makeRequest(), extra1: 1, extra2: 2, extra3: 3, extra4: 4, extra5: 5 } as unknown as RecordShadowDayRequest;
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('ignores unknown extra own data keys within the cap and records a result deep-equal to the plain-data result', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    // A constant-refusal implementation would fail here: the request carries
    // an unknown extra key and is still recorded.
    const request = { ...makeRequest(), junk: 'ignored' } as unknown as RecordShadowDayRequest;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expectRecorded(result);
    // The ignored extra key must not change the outcome: the recorded result
    // is deep-equal to the result of the same request without the extra key.
    const plainHarness = makeHarness(cleanFixture(DAY), NOW);
    const plain = await new RecordShadowDayUseCase(plainHarness.deps).execute(makeRequest());
    expect(result).toEqual(plain);
  });

  it('refuses a repository with more than MAX_REPOSITORY_OWN_KEYS own keys as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({ repository: { owner: OWNER, repo: REPO, a: 1, b: 2, c: 3 } as unknown as { owner: string; repo: string } });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('ignores unknown extra repository own data keys within the cap and records a result deep-equal to the plain-data result', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const request = makeRequest({ repository: { owner: OWNER, repo: REPO, extra: 'ignored' } as unknown as { owner: string; repo: string } });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expectRecorded(result);
    // The ignored extra repository key must not change the outcome: the
    // recorded result is deep-equal to the result of the same request with a
    // plain { owner, repo } repository.
    const plainHarness = makeHarness(cleanFixture(DAY), NOW);
    const plain = await new RecordShadowDayUseCase(plainHarness.deps).execute(makeRequest());
    expect(result).toEqual(plain);
  });

  it('refuses a repository field that is a getter flipping between two valid refs, running the getter zero times', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let repositoryReads = 0;
    const request = {
      get repository(): { owner: string; repo: string } {
        repositoryReads += 1;
        return repositoryReads === 1 ? { owner: OWNER, repo: REPO } : { owner: 'other', repo: 'repo' };
      },
      legacyStateDir: LEGACY_STATE_DIR,
      day: DAY,
    } as unknown as RecordShadowDayRequest;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    // The getter must never run: own data-property descriptors only.
    expect(repositoryReads).toBe(0);
    expect(harness.evidence.calls.cas).toBe(0);
  });

  it('refuses a nested repository.owner getter, running the getter zero times', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let ownerReads = 0;
    const request = makeRequest({
      repository: {
        get owner(): string {
          ownerReads += 1;
          return OWNER;
        },
        repo: REPO,
      } as unknown as { owner: string; repo: string },
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(ownerReads).toBe(0);
    expect(harness.evidence.calls.cas).toBe(0);
  });

  it('refuses an empty legacyStateDir as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ legacyStateDir: '' })));
  });

  it('refuses a non-string legacyStateDir as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(makeRequest({ legacyStateDir: 42 as unknown as string })));
  });

  it('yields the plain-data result with zero get traps for a transparent Proxy over a valid request, deep-equal to the plain-data result', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    let getTraps = 0;
    const proxied = new Proxy(makeRequest(), {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(proxied);
    expectRecorded(result);
    expect(getTraps).toBe(0);
    // The proxied request must behave exactly like the same plain-data
    // request: its result is deep-equal to the result of a fresh plain run.
    const plainHarness = makeHarness(cleanFixture(DAY), NOW);
    const plain = await new RecordShadowDayUseCase(plainHarness.deps).execute(makeRequest());
    expect(result).toEqual(plain);
  });

  it('refuses a Proxy whose getPrototypeOf trap throws as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const proxied = new Proxy(makeRequest(), {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf');
      },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(proxied as unknown as RecordShadowDayRequest));
  });

  it('refuses a Proxy whose ownKeys trap throws as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const proxied = new Proxy(makeRequest(), {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(proxied as unknown as RecordShadowDayRequest));
  });

  it('refuses a Proxy whose getOwnPropertyDescriptor trap throws as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const proxied = new Proxy(makeRequest(), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile getOwnPropertyDescriptor');
      },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(proxied as unknown as RecordShadowDayRequest));
  });

  it('refuses a repository that is a non-plain object (a class instance with the valid fields as own properties) as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    class HostileRepository {
      owner: string;
      repo: string;
      constructor() {
        this.owner = OWNER;
        this.repo = REPO;
      }
    }
    const hostile = makeRequest({ repository: new HostileRepository() as unknown as { owner: string; repo: string } });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a repository carrying a symbol own key alongside the valid fields as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({
      repository: { owner: OWNER, repo: REPO, [Symbol('hostile')]: 1 } as unknown as { owner: string; repo: string },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a repository carrying a JSON.parse-produced own __proto__ key alongside the valid fields as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({
      repository: JSON.parse('{"owner":"octo","repo":"train","__proto__":{"admin":true}}') as unknown as { owner: string; repo: string },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a repository carrying a JSON.parse-produced own constructor key alongside the valid fields as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({
      repository: JSON.parse('{"owner":"octo","repo":"train","constructor":{"prototype":{}}}') as unknown as { owner: string; repo: string },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a repository carrying a JSON.parse-produced own prototype key alongside the valid fields as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({
      repository: JSON.parse('{"owner":"octo","repo":"train","prototype":{}}') as unknown as { owner: string; repo: string },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a repository that is a Proxy whose ownKeys trap throws as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({
      repository: new Proxy({ owner: OWNER, repo: REPO }, {
        ownKeys() {
          throw new Error('hostile repository ownKeys');
        },
      }) as unknown as { owner: string; repo: string },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('refuses a repository that is a Proxy whose getPrototypeOf trap throws as invalid-request', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const hostile = makeRequest({
      repository: new Proxy({ owner: OWNER, repo: REPO }, {
        getPrototypeOf() {
          throw new Error('hostile repository getPrototypeOf');
        },
      }) as unknown as { owner: string; repo: string },
    });
    expectRefused(harness, await new RecordShadowDayUseCase(harness.deps).execute(hostile));
  });

  it('yields a result deep-equal to the plain-data result for a transparent Proxy over a valid repository', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const plainHarness = makeHarness(cleanFixture(DAY), NOW);
    const plain = await new RecordShadowDayUseCase(plainHarness.deps).execute(makeRequest());
    const request = makeRequest({
      repository: new Proxy({ owner: OWNER, repo: REPO }, {}) as unknown as { owner: string; repo: string },
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expectRecorded(result);
    expect(result).toEqual(plain);
  });

  it('records a request with exactly MAX_REQUEST_OWN_KEYS own keys, deep-equal to the plain-data result', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const plainHarness = makeHarness(cleanFixture(DAY), NOW);
    const plain = await new RecordShadowDayUseCase(plainHarness.deps).execute(makeRequest());
    const request = { ...makeRequest(), extra1: 1, extra2: 2, extra3: 3, extra4: 4 } as unknown as RecordShadowDayRequest;
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expectRecorded(result);
    expect(result).toEqual(plain);
  });

  it('records a repository with exactly MAX_REPOSITORY_OWN_KEYS own keys, deep-equal to the plain-data result', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const plainHarness = makeHarness(cleanFixture(DAY), NOW);
    const plain = await new RecordShadowDayUseCase(plainHarness.deps).execute(makeRequest());
    const request = makeRequest({
      repository: { owner: OWNER, repo: REPO, extra1: 'ignored', extra2: 'ignored' } as unknown as { owner: string; repo: string },
    });
    const result = await new RecordShadowDayUseCase(harness.deps).execute(request);
    expectRecorded(result);
    expect(result).toEqual(plain);
  });

  it('conflict-then-saved: a first compareAndSet conflict is retried once and records', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const useCase = new RecordShadowDayUseCase(harness.deps);
    // Days append in order: the earlier day is recorded first, so the
    // conflict-retried write appends the later day onto a revision-1 ledger.
    const first = await useCase.execute(makeRequest({ day: '2026-11-15' }));
    expectRecorded(first);
    const deps = harness.deps as MutableDeps;
    const realCas = deps.evidence.compareAndSet;
    let casCalls = 0;
    deps.evidence.compareAndSet = async (request) => {
      casCalls += 1;
      if (casCalls === 1) {
        return { outcome: 'conflict', currentRevision: 1 } as const;
      }
      return realCas(request);
    };
    // Reset the fake clock: the first run's S8 sample gap consumed part of
    // the request deadline.
    harness.setNow(NOW);
    const readsBefore = harness.evidence.calls.read;
    const second = await useCase.execute(makeRequest());
    expect(second).toMatchObject({ outcome: 'recorded', day: DAY });
    // One initial read, one re-read after the conflict; two compareAndSet calls.
    expect(harness.evidence.calls.read - readsBefore).toBe(2);
    expect(casCalls).toBe(2);
  });

  it('conflict-then-unchanged: a conflict whose re-read already holds the day answers unchanged without a second compareAndSet', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    const useCase = new RecordShadowDayUseCase(harness.deps);
    // Run 1 records the day EMPTY (every criterion unevaluated), so run 2's
    // first write attempt still changes something and reaches compareAndSet.
    const legacyEvents = deps.legacy.readLegacyTrainEvents;
    const daemonRead = deps.daemonEvents.readAfterCursor;
    const checkState = deps.checkState;
    deps.legacy.readLegacyTrainEvents = undefined;
    deps.daemonEvents.readAfterCursor = async () => ({ ok: false, reason: 'invalid-cursor' } as const);
    deps.checkState = async () => null;
    harness.setImportDryRun(refusedImport());
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded).toEqual({});
    // Restore the readers: run 2 evaluates the criteria and proposes the
    // full verdict set.
    deps.legacy.readLegacyTrainEvents = legacyEvents;
    deps.daemonEvents.readAfterCursor = daemonRead;
    deps.checkState = checkState;
    harness.setImportDryRun(dryRunImport(cleanImportKeys()));
    const realCas = deps.evidence.compareAndSet;
    let casCalls = 0;
    deps.evidence.compareAndSet = async (request) => {
      casCalls += 1;
      if (casCalls === 1) {
        // A concurrent writer lands the IDENTICAL verdict set at revision 2
        // before this run's write lands; the run's own write then reports
        // conflict against revision 2.
        await realCas(request);
        return { outcome: 'conflict', currentRevision: 2 } as const;
      }
      return realCas(request);
    };
    // Reset the fake clock: the first run's S8 sample gap consumed part of
    // the request deadline.
    harness.setNow(NOW);
    const readsBefore = harness.evidence.calls.read;
    const second = await useCase.execute(makeRequest());
    expect(second).toMatchObject({ outcome: 'unchanged', revision: 2 });
    expect(harness.evidence.calls.read - readsBefore).toBe(2);
    // The re-read already held the matching day record: no second CAS.
    expect(casCalls).toBe(1);
  });

  it('maps a compareAndSet refused read-only to unknown ledger-busy and writes nothing', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    let casCalls = 0;
    deps.evidence.compareAndSet = async () => {
      casCalls += 1;
      return { outcome: 'refused', reason: 'read-only' };
    };
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'ledger-busy' });
    expect(casCalls).toBe(1);
    expect(harness.evidence.stored).toBeNull();
  });

  it('maps a thrown compareAndSet to unknown ledger-unreadable and writes nothing', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    let casCalls = 0;
    deps.evidence.compareAndSet = async () => {
      casCalls += 1;
      throw new Error('compareAndSet failed');
    };
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'ledger-unreadable' });
    expect(casCalls).toBe(1);
    expect(harness.evidence.stored).toBeNull();
  });

  it('records an empty day (verdicts {}) when every criterion is unevaluated', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    const legacyEvents = deps.legacy.readLegacyTrainEvents;
    const daemonRead = deps.daemonEvents.readAfterCursor;
    const checkState = deps.checkState;
    // Every criterion unevaluated: no shell events, no daemon events, no
    // state check, a refused import dry-run, and no conducted/chains/
    // premergeCarry/oneTime wiring (the harness never wires those).
    deps.legacy.readLegacyTrainEvents = undefined;
    deps.daemonEvents.readAfterCursor = async () => ({ ok: false, reason: 'invalid-cursor' } as const);
    deps.checkState = async () => null;
    harness.setImportDryRun(refusedImport());
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.recorded).toEqual({});
    const stored = harness.evidence.stored;
    if (stored === null) {
      throw new Error('expected a stored ledger');
    }
    const dayRecord = stored.days.find((entry) => entry.day === DAY);
    if (dayRecord === undefined) {
      throw new Error('expected the day to be appended');
    }
    expect(dayRecord.verdicts).toEqual({});
    expect(dayRecord.mergesCompared).toBeNull();
    // Restore the readers for the drift run below.
    deps.legacy.readLegacyTrainEvents = legacyEvents;
    deps.daemonEvents.readAfterCursor = daemonRead;
    deps.checkState = checkState;
    harness.setImportDryRun(dryRunImport(cleanImportKeys()));
    // Reset the fake clock: the first run's S8 sample gap consumed part of
    // the request deadline.
    harness.setNow(NOW);
    // A later run on the same day whose criteria now evaluate has nothing
    // recorded to conflict with: the new verdicts merge into the empty day
    // (the asymmetry's other arm — only a CHANGED recorded digest conflicts,
    // as the next test pins).
    const second = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(second);
    expect(second.recorded.S1).toBe('pass');
    expect(harness.evidence.stored?.revision).toBe(2);
  });

  it('refuses a re-run whose live state drifted a recorded verdict with verdict-conflict, not unchanged', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.recorded.S9).toBe('pass');
    // Drift: the live state check now reports a bad sample, so S9's verdict
    // and digest change between runs. Reset the fake clock first: the first
    // run's S8 sample gap consumed part of the request deadline.
    harness.setNow(NOW);
    deps.checkState = async () => ({ checked: 5, bad: 1 });
    const second = await useCase.execute(makeRequest());
    expect(second).toEqual({ outcome: 'refused', reason: 'verdict-conflict' });
    expect(harness.evidence.stored?.revision).toBe(1);
  });

  // #6 bullet 4: the S8 settle sleep is deadline-guarded like every other
  // outbound call — a rejection before the deadline is S8 unevaluated with
  // the other criteria still recorded, never a throw out of `execute`.
  it('records S8 unevaluated (intake-sample-interrupted) and keeps the other criteria when deps.sleep rejects before the deadline', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    deps.sleep = async () => {
      throw new Error('sleep failed');
    };
    const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
    expectRecorded(result);
    expect(result.unevaluated).toContainEqual({ criterion: 'S8', reason: 'intake-sample-interrupted' });
    // The other criteria are still recorded, never lost with S8's failure.
    expect(result.recorded.S9).toBe('pass');
    expect(result.recorded.S1).toBe('pass');
    expect(harness.evidence.stored).not.toBeNull();
    expect(harness.evidence.calls.cas).toBe(1);
  });

  // #6 bullet 4: a sleep that settles after the deadline — fulfilled or
  // rejected — aborts through `this.call`'s re-check with `deadline-exceeded`
  // and the ledger untouched.
  it('returns deadline-exceeded with the ledger untouched when deps.sleep settles after the deadline (fulfilled or rejected)', async () => {
    for (const settle of ['fulfilled', 'rejected'] as const) {
      const harness = makeHarness(cleanFixture(DAY), NOW);
      const deps = harness.deps as MutableDeps;
      deps.sleep = async () => {
        // The deadline passes while the sleep is in flight.
        harness.setNow(DEADLINE);
        if (settle === 'rejected') {
          throw new Error('sleep failed');
        }
      };
      const result = await new RecordShadowDayUseCase(harness.deps).execute(makeRequest());
      expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
      expect(harness.evidence.stored).toBeNull();
      expect(harness.evidence.calls.cas).toBe(0);
    }
  });

  // BL08p step 2c: S9 newly unevaluated (invalid-input) records the other
  // criteria with S9 unevaluated, and an identical rerun answers `unchanged`
  // without a second CAS.
  it('records S9 unevaluated (invalid-input) for a malformed journal entry and answers unchanged on an identical rerun without a second CAS', async () => {
    const harness = makeHarness(cleanFixture(DAY), NOW);
    const deps = harness.deps as MutableDeps;
    // S9 refuses as invalid-input: the state check ran (checked: 5, bad: 1)
    // but the journal sample carries a malformed entry the S9 evaluator
    // refuses. The other criteria keep their clean-fixture verdicts.
    deps.checkState = async () => ({ checked: 5, bad: 1 });
    deps.journal.listForKeyPrefix = async () => [
      journalEntry({ kind: 'intent', key: 'lane:k1', recordedAtIso: `${DAY}T09:59:00Z` }),
      // Malformed: no kind, no key, no timestamp — refused as invalid-input.
      {} as unknown as LaneRunJournalEntryRecord,
    ];
    const useCase = new RecordShadowDayUseCase(harness.deps);
    const first = await useCase.execute(makeRequest());
    expectRecorded(first);
    expect(first.unevaluated).toContainEqual({ criterion: 'S9', reason: 'invalid-input' });
    // S12 (daemon tick health, independent of the journal) is still recorded.
    expect(first.recorded.S12).toBe('pass');
    expect(harness.evidence.calls.cas).toBe(1);
    // Identical rerun: the recorded verdicts match, S9 stays unevaluated, and
    // the ledger is not written again.
    harness.setNow(NOW);
    const second = await useCase.execute(makeRequest());
    expectRecorded(second);
    expect(second).toMatchObject({ outcome: 'unchanged' });
    expect(second.unevaluated).toContainEqual({ criterion: 'S9', reason: 'invalid-input' });
    expect(harness.evidence.calls.cas).toBe(1);
  });
});
