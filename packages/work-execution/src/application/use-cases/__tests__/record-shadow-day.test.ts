// Lane SH7b: RecordShadowDayUseCase exercised directly with fakes for every
// dependency — no CLI, no composition (that is SH8a).
import { describe, expect, it } from 'vitest';

import type { CutoverShadowCriterion } from '../../../domain/cutover-records.js';
import type { DaemonEventRecord } from '../../../domain/daemon-events.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey, buildMergeKey, laneRunPremergeKey } from '../../../domain/lane-run-keys.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { ShadowLedger } from '../../../domain/shadow-evidence-ledger.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import type { ImportTrainStateKey, ImportTrainStateResult } from '../../ports/in/ImportTrainStatePort.in-port.js';
import type { ChainListCommand, ChainRepositoryPort } from '../../ports/out/ChainRepositoryPort.out-port.js';
import type { LegacyTrainEventsRead, LegacyTrainStateRead } from '../../ports/out/LegacyTrainStateReadPort.out-port.js';
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
const NOT_IMPLEMENTED: readonly CutoverShadowCriterion[] = [
  'S2', 'S3', 'S10', 'S11', 'S13',
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
 * The canonical S5' summary digest: the base plus `compared` only — the count
 * of deduped, day-scoped carry decisions the evaluator compared, which is
 * closed-day deterministic (zero on a day with no carry decisions).
 * `laxCarries` and `stricterNoCarries` depend on the resolver's answers
 * between runs and stay on the outcome as non-digested diagnostics.
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
        recordedAtIso: new Date(Date.parse(atIso) + 30_000).toISOString(),
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

/** A resolver that throws on every call: the use case must read that as `unknown`. */
function throwingPremergeCarry(): NonNullable<RecordShadowDayDependencies['premergeCarry']> {
  return async () => {
    throw new Error('resolver failed');
  };
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
        journalKeys: 1,
        duplicateIntents: 0,
        duplicateResults: 0,
        resultsAfterFinal: 0,
        orphanResults: 0,
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
      totalTicks: 800,
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

  it('reports S5 unevaluated (fleet-carry-unknown) when premergeCarry throws or returns unknown', async () => {
    // The resolver throws.
    const throwing = wiredHarness(carryFixture(), {});
    setPremergeCarry(throwing, throwingPremergeCarry());
    const thrownResult = await new RecordShadowDayUseCase(throwing.deps).execute(makeRequest());
    expectRecorded(thrownResult);
    const thrownReasons = new Map(thrownResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(thrownReasons.get('S5')).toBe('fleet-carry-unknown');
    expect(thrownResult.recorded.S5).toBeUndefined();

    // The resolver answers `unknown`.
    const unknown = wiredHarness(carryFixture(), {});
    setPremergeCarry(unknown, constantPremergeCarry('unknown'));
    const unknownResult = await new RecordShadowDayUseCase(unknown.deps).execute(makeRequest());
    expectRecorded(unknownResult);
    const unknownReasons = new Map(unknownResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(unknownReasons.get('S5')).toBe('fleet-carry-unknown');

    // The resolver answers something outside the closed answer set: read as
    // `unknown`, never as a pass or a fail.
    const bogus = wiredHarness(carryFixture(), {});
    setPremergeCarry(bogus, (() => Promise.resolve('bogus' as PremergeCarryAnswer)) as NonNullable<RecordShadowDayDependencies['premergeCarry']>);
    const bogusResult = await new RecordShadowDayUseCase(bogus.deps).execute(makeRequest());
    expectRecorded(bogusResult);
    const bogusReasons = new Map(bogusResult.unevaluated.map((entry) => [entry.criterion, entry.reason]));
    expect(bogusReasons.get('S5')).toBe('fleet-carry-unknown');
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
    // awaited operation REJECTS, otherwise S5 would become unevaluated
    // (`fleet-carry-unknown`) and a rerun could answer `unchanged` instead
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
      expect(withDay?.verdicts[criterion]?.digest).toBe(withoutDay?.verdicts[criterion]?.digest);
    }
  });
});
