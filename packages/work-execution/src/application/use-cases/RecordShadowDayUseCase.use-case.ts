// Lane SH7b: the shadow day-writer. For one UTC day it evaluates every
// criterion this chain can currently compute from data that already exists —
// S1 (merge set, SH5a), S8 (two-sample intake, yesterday only, SH5c), S9
// (state integrity, yesterday only, SH5b) and S12 (daemon tick health, SH5b)
// — records each definite pass/fail verdict into
// the SH1/SH2 shadow-evidence ledger by compare-and-set, and reports every
// other criterion as unevaluated: never a pass, never a silent fail. Nothing
// is ever written to the ledger on any refused or unknown outcome. Every
// outbound call is deadline-guarded with the same pattern
// ManageCutoverUseCase uses; no path or raw input value is ever echoed.

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { type DaemonEventRecord } from '../../domain/daemon-events.js';
import { CUTOVER_SHADOW_CRITERIA, type CutoverShadowCriterion } from '../../domain/cutover-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { isMergeQueueEntryLive } from '../../domain/merge-queue-records.js';
import { evaluateShadowMergeSet, type ShadowDayMergeSetEvaluation } from '../../domain/shadow-day-merge-set.js';
import { evaluateShadowStateIntegrity, evaluateShadowTickHealth } from '../../domain/shadow-day-health.js';
import {
  recordShadowVerdicts,
  type ShadowCriterionEvaluation,
  type ShadowCriterionVerdict,
  type ShadowLedger,
} from '../../domain/shadow-evidence-ledger.js';
import { parseLegacyTrainParkedQueue, parseLegacyTrainQueue } from '../../domain/legacy-train-queue.js';
import { evaluateShadowIntake, type ShadowIntakeEvaluation } from '../../domain/shadow-day-intake.js';
import { parseShellTrainEvents, type ShellTrainEvent } from '../../domain/shell-train-events.js';
import type { ImportTrainStatePort } from '../ports/in/ImportTrainStatePort.in-port.js';
import type {
  RecordShadowDayPort,
  RecordShadowDayRequest,
  RecordShadowDayResult,
  RecordShadowDayUnevaluated,
} from '../ports/in/RecordShadowDayPort.in-port.js';
import type { DaemonEventProjectionPort } from '../ports/out/DaemonEventProjectionPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LegacyTrainFileRead, LegacyTrainStateReadPort } from '../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ShadowEvidencePort } from '../ports/out/ShadowEvidencePort.out-port.js';
import { isValidRepositoryRef } from './ImportTrainStateUseCase.use-case.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** D+1 00:15Z: S1's 10-minute boundary grace plus one tick's margin. */
const EARLY_GRACE_MS = 15 * 60 * 1000;
/** A day more than this many calendar days before now's date is too old to record. */
const MAX_DAY_AGE_DAYS = 7;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The default wall-clock gap between S8's two samples: 2.5 minutes,
 * comfortably above SH5c's `SHADOW_INTAKE_MIN_GAP_MS` floor of 2 minutes.
 */
const DEFAULT_SAMPLE_GAP_MS = 150_000;

/** Every criterion no evaluator implements yet; later units add the rest. */
const NOT_IMPLEMENTED_CRITERIA: readonly CutoverShadowCriterion[] = [
  'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S10', 'S11', 'S13',
];

export interface RecordShadowDayDependencies {
  readonly evidence: ShadowEvidencePort;
  readonly legacy: LegacyTrainStateReadPort;
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  /** The import dry-run seat: S8 never applies, it only asks what would import. */
  readonly importDryRun: Pick<ImportTrainStatePort, 'importTrainState'>;
  /** The real wall-clock gap between S8's two samples; faked in tests. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly journal: Pick<LaneRunJournalPort, 'listForKeyPrefix'>;
  readonly daemonEvents: Pick<DaemonEventProjectionPort, 'readAfterCursor'>;
  readonly checkState: () => Promise<{ readonly checked: number; readonly bad: number } | null>;
  readonly computeDigest: (text: string) => string;
  readonly repoDigestOf: (repository: { readonly owner: string; readonly repo: string }) => string;
  readonly releaseSha: () => Promise<string | null>;
  readonly nowIso: () => string;
  /** The owner-accepted OD-1 default (false, fail-closed) is pinned in composition; this use case only receives it. */
  readonly settings: { readonly excludeBatchMerges: boolean; readonly sampleGapMs?: number };
}

/** Thrown by `call` when the deadline is already reached; aborts the whole run. */
class DeadlineReachedError extends Error {
  constructor() {
    super('deadline-exceeded');
  }
}

interface DayContext {
  readonly day: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly legacyStateDir: string;
  readonly repoDigest: string;
  readonly deadlineIso: string | undefined;
}

/** One criterion's evaluation, or the reason it is unevaluated. */
type CriterionOutcome =
  | {
      readonly criterion: CutoverShadowCriterion;
      readonly kind: 'evaluated';
      readonly evaluation: ShadowCriterionEvaluation;
      /** Present only for S1: the merge-set evaluation the counts come from. */
      readonly mergeSet?: ShadowDayMergeSetEvaluation;
      /** Present only for S8: the intake evaluation the comparison counts come from. */
      readonly intake?: ShadowIntakeEvaluation;
    }
  | { readonly criterion: CutoverShadowCriterion; readonly kind: 'unevaluated'; readonly reason: string };

/** The ledger read: usable, or a finished refusal/unknown answer. */
type LedgerRead =
  | { readonly kind: 'ok'; readonly ledger: ShadowLedger | null }
  | { readonly kind: 'stop'; readonly result: RecordShadowDayResult };

/** The journal prefix read: entries in append order, or unavailable. */
type JournalRead =
  | { readonly kind: 'ok'; readonly entries: readonly LaneRunJournalEntryRecord[] }
  | { readonly kind: 'unavailable' };

/** One enqueue key as the SH5c intake evaluator consumes it. */
interface IntakeKey {
  readonly pullRequest: number;
  readonly headOid: string;
  readonly base: string;
}

/** One S8 intake sample, shaped exactly for `evaluateShadowIntake`. */
interface IntakeSample {
  readonly takenAtIso: string;
  readonly complete: boolean;
  readonly shellLive: readonly IntakeKey[];
  readonly fleetLive: readonly IntakeKey[];
  readonly importPresent: readonly IntakeKey[] | null;
  readonly importUnknownLines: number;
}

interface BuiltVerdicts {
  readonly verdicts: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>;
  readonly unevaluated: ReadonlyMap<CutoverShadowCriterion, string>;
  readonly mergesCompared: number | null;
}

function unevaluatedOutcome(criterion: CutoverShadowCriterion, reason: string): CriterionOutcome {
  return { criterion, kind: 'unevaluated', reason };
}

function unknownResult(reason: 'ledger-unreadable' | 'ledger-unknown-version' | 'ledger-busy' | 'deadline-exceeded'): RecordShadowDayResult {
  return { outcome: 'unknown', reason };
}

function refusedResult(reason: 'invalid-request' | 'too-early' | 'too-old' | 'day-out-of-order' | 'verdict-conflict' | 'release-conflict' | 'merges-conflict'): RecordShadowDayResult {
  return { outcome: 'refused', reason };
}

/** A real UTC calendar day `YYYY-MM-DD`, or null. */
function isUtcDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

/** The UTC day string of a day serial (days since the epoch). */
function utcDayOfSerial(serial: number): string {
  return new Date(serial * DAY_MS).toISOString().slice(0, 10);
}

/** The day serial of a validated UTC day string. */
function serialOfUtcDay(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

export class RecordShadowDayUseCase implements RecordShadowDayPort {
  constructor(private readonly deps: RecordShadowDayDependencies) {}

  async execute(request: RecordShadowDayRequest): Promise<RecordShadowDayResult> {
    try {
      return await this.run(request);
    } catch (error) {
      if (error instanceof DeadlineReachedError) {
        return unknownResult('deadline-exceeded');
      }
      throw error;
    }
  }

  private async run(request: RecordShadowDayRequest): Promise<RecordShadowDayResult> {
    const resolved = this.resolveDay(request);
    if (!resolved.ok) {
      return refusedResult(resolved.reason);
    }
    const context: DayContext = {
      day: resolved.day,
      repository: request.repository,
      legacyStateDir: request.legacyStateDir,
      repoDigest: this.deps.repoDigestOf(request.repository),
      deadlineIso: request.deadlineIso,
    };
    const ledger = await this.readLedger(context.deadlineIso);
    if (ledger.kind === 'stop') {
      return ledger.result;
    }
    const releaseSha = await this.readRelease(context.deadlineIso);
    const journal = await this.readJournal(context);
    const outcomes = [
      await this.evaluateMergeSetCriterion(context, journal),
      await this.evaluateIntakeCriterion(context),
      await this.evaluateStateIntegrityCriterion(context, journal),
      await this.evaluateTickHealthCriterion(context),
    ];
    const built = this.buildVerdicts(context, outcomes);
    return this.writeDay(context, ledger.ledger, releaseSha, built);
  }

  /** True once `deadlineIso` is reached; an unusable clock counts as reached (fail closed). */
  private deadlineReached(deadlineIso: string | undefined): boolean {
    if (deadlineIso === undefined) {
      return false;
    }
    try {
      return !(Date.parse(this.deps.nowIso()) < Date.parse(deadlineIso));
    } catch {
      return true;
    }
  }

  /**
   * Every outbound call goes through here: the deadline is checked first and
   * a reached deadline aborts the whole run (`DeadlineReachedError`), while a
   * dependency throw is reported to the caller as `threw` — never propagated.
   */
  private async call<T>(deadlineIso: string | undefined, make: () => Promise<T>): Promise<{ readonly kind: 'value'; readonly value: T } | { readonly kind: 'threw' }> {
    if (this.deadlineReached(deadlineIso)) {
      throw new DeadlineReachedError();
    }
    try {
      return { kind: 'value', value: await make() };
    } catch {
      return { kind: 'threw' };
    }
  }

  /** The day resolution: the day to record, or the refusal reason. */
  private resolveDay(request: RecordShadowDayRequest): { readonly ok: true; readonly day: string } | { readonly ok: false; readonly reason: 'invalid-request' | 'too-early' | 'too-old' } {
    if (!isValidRepositoryRef(request.repository)) {
      return { ok: false, reason: 'invalid-request' };
    }
    if (typeof request.legacyStateDir !== 'string' || request.legacyStateDir.trim() === '') {
      return { ok: false, reason: 'invalid-request' };
    }
    if (request.deadlineIso !== undefined && !isZonedIsoDateTime(request.deadlineIso)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const nowMs = Date.parse(this.deps.nowIso());
    if (Number.isNaN(nowMs)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const nowSerial = Math.floor(nowMs / DAY_MS);
    const day = request.day === undefined ? utcDayOfSerial(nowSerial - 1) : request.day;
    if (!isUtcDay(day)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const daySerial = serialOfUtcDay(day);
    if (nowMs < (daySerial + 1) * DAY_MS + EARLY_GRACE_MS) {
      return { ok: false, reason: 'too-early' };
    }
    if (nowSerial - daySerial > MAX_DAY_AGE_DAYS) {
      return { ok: false, reason: 'too-old' };
    }
    return { ok: true, day };
  }

  /** The stored ledger, or the stop result its unreadable/unknown-version state demands. */
  private async readLedger(deadlineIso: string | undefined): Promise<LedgerRead> {
    const read = await this.call(deadlineIso, () => this.deps.evidence.read({ deadlineIso }));
    if (read.kind === 'threw') {
      return { kind: 'stop', result: unknownResult('ledger-unreadable') };
    }
    if (read.value.status === 'ok') {
      return { kind: 'ok', ledger: read.value.ledger };
    }
    if (read.value.status === 'missing') {
      return { kind: 'ok', ledger: null };
    }
    if (read.value.status === 'unknown-version') {
      return { kind: 'stop', result: unknownResult('ledger-unknown-version') };
    }
    return { kind: 'stop', result: unknownResult('ledger-unreadable') };
  }

  /** The day's release sha, or null when none is known or the reader failed. */
  private async readRelease(deadlineIso: string | undefined): Promise<string | null> {
    const read = await this.call(deadlineIso, () => this.deps.releaseSha());
    return read.kind === 'value' ? read.value : null;
  }

  /** The journal entries under this repo's `merge/` prefix, in append order, or unavailable. */
  private async readJournal(context: DayContext): Promise<JournalRead> {
    const listForPrefix = this.deps.journal.listForKeyPrefix?.bind(this.deps.journal);
    if (listForPrefix === undefined) {
      return { kind: 'unavailable' };
    }
    const read = await this.call(context.deadlineIso, () => listForPrefix(`merge/${context.repoDigest}/`));
    return read.kind === 'value' ? { kind: 'ok', entries: read.value } : { kind: 'unavailable' };
  }

  /** A deadline for a port whose query requires one, when the request named none. */
  private queryDeadline(context: DayContext): string {
    if (context.deadlineIso !== undefined) {
      return context.deadlineIso;
    }
    return new Date(Date.parse(this.deps.nowIso()) + 60_000).toISOString();
  }

  /** The parsed shell train events, or the reason S1 is unevaluated. */
  private async readShellEvents(
    context: DayContext,
  ): Promise<{ readonly events: readonly ShellTrainEvent[]; readonly unknownLines: number } | string> {
    const readEvents = this.deps.legacy.readLegacyTrainEvents?.bind(this.deps.legacy);
    if (readEvents === undefined) {
      return 'shell-events-unavailable';
    }
    const read = await this.call(context.deadlineIso, () => readEvents({ stateDir: context.legacyStateDir }));
    if (read.kind === 'threw' || read.value.status !== 'read') {
      return 'shell-events-unavailable';
    }
    const parsed = parseShellTrainEvents(read.value.lines);
    if (!parsed.ok) {
      return parsed.reason;
    }
    return { events: parsed.events, unknownLines: parsed.unknownLines.length };
  }

  /** Every live merge-queue entry for this repository, or the reason S1 is unevaluated. */
  private async readLiveEntries(
    context: DayContext,
  ): Promise<readonly { readonly pullRequest: number; readonly headOid: string }[] | string> {
    const read = await this.call(context.deadlineIso, () =>
      this.deps.queue.listMergeEntries({ repository: context.repository, deadlineIso: this.queryDeadline(context) }),
    );
    if (read.kind === 'threw') {
      return 'merge-entries-unavailable';
    }
    // Defensive: MergeQueueRepositoryAdapter#listMergeEntries does not
    // itself filter by the query's `repository` (infrastructure/adapters,
    // outside this unit's scope) — it returns every stored entry regardless
    // of the query. Filter here by `repoDigest` so a call scoped to this
    // repository is never contaminated by another repository's live
    // entries in S1's merge-set comparison.
    return read.value
      .filter((entry) => entry.repoDigest === context.repoDigest)
      .filter(isMergeQueueEntryLive)
      .map((entry) => ({
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
      }));
  }

  /** S1: the day's merge set, shell events against the fleet's journaled would-merges. */
  private async evaluateMergeSetCriterion(context: DayContext, journal: JournalRead): Promise<CriterionOutcome> {
    const shell = await this.readShellEvents(context);
    if (typeof shell === 'string') {
      return unevaluatedOutcome('S1', shell);
    }
    if (journal.kind === 'unavailable') {
      return unevaluatedOutcome('S1', 'fleet-journal-unavailable');
    }
    const liveEntries = await this.readLiveEntries(context);
    if (typeof liveEntries === 'string') {
      return unevaluatedOutcome('S1', liveEntries);
    }
    const evaluation = evaluateShadowMergeSet({
      day: context.day,
      repoDigest: context.repoDigest,
      excludeBatchMerges: this.deps.settings.excludeBatchMerges,
      shell: { events: shell.events, unknownLines: shell.unknownLines },
      fleet: {
        results: journal.entries
          .filter((entry) => entry.kind === 'result')
          .map((entry) => ({
            key: entry.key ?? '',
            outcome: entry.outcome ?? '',
            reasonCode: entry.reasonCode ?? '',
            recordedAtIso: entry.recordedAtIso,
          })),
        entries: liveEntries,
      },
    });
    return { criterion: 'S1', kind: 'evaluated', evaluation, mergeSet: evaluation };
  }

  /**
   * One shell train source (queue, parked or inprogress) reduced to the
   * intake keys it contributes plus whether it was incomplete: missing,
   * unreadable or holding an unparseable line all count as incomplete, so
   * the sample's `complete` flag fails closed exactly the way the shadow
   * report's assembly does. Parked lines are the shell's 6-field record,
   * parsed with the parked parser, as the shadow report does; queue and
   * inprogress lines parse with the queue parser.
   */
  private parsedShellSource(
    read: LegacyTrainFileRead | undefined,
    parked: boolean,
  ): { readonly keys: readonly IntakeKey[]; readonly incomplete: boolean } {
    if (read === undefined || read.status !== 'read') {
      return { keys: [], incomplete: true };
    }
    const parsed = parked
      ? parseLegacyTrainParkedQueue(read.lines.join('\n'))
      : parseLegacyTrainQueue(read.lines.join('\n'));
    if (!parsed.ok) {
      return { keys: [], incomplete: true };
    }
    const keys: IntakeKey[] = [];
    let unknownLines = 0;
    for (const line of parsed.lines) {
      if (!line.ok) {
        unknownLines += 1;
        continue;
      }
      keys.push({ pullRequest: line.entry.pullRequest, headOid: line.entry.headOid, base: line.entry.base });
    }
    return { keys, incomplete: unknownLines > 0 };
  }

  /**
   * One S8 sample, assembled the same way the shadow-report command
   * assembles its shell live set: queue, parked and in-progress lines
   * combined into `shellLive`; the fleet queue's live entries for this
   * repository into `fleetLive` (each under its own recorded base, `main`
   * when it has none); the import dry-run's would-import/already-queued
   * keys into `importPresent`, null when the dry-run is refused or
   * unavailable. The `complete` flag is false when any shell source has an
   * unknown line, is unreadable or is missing, or `batchesEnabled` is
   * unreadable or missing — never a guessed pass.
   */
  private async intakeSample(context: DayContext): Promise<IntakeSample> {
    const takenAtIso = this.deps.nowIso();
    const shellLive: IntakeKey[] = [];
    let complete = true;
    const stateRead = await this.call(
      context.deadlineIso,
      () => this.deps.legacy.readLegacyTrainState({ stateDir: context.legacyStateDir }),
    );
    if (stateRead.kind === 'value') {
      const sources: readonly (readonly [LegacyTrainFileRead | undefined, boolean])[] = [
        [stateRead.value.queue, false],
        [stateRead.value.parked, true],
        [stateRead.value.inprogress, false],
      ];
      for (const [read, parked] of sources) {
        const parsed = this.parsedShellSource(read, parked);
        complete = complete && !parsed.incomplete;
        shellLive.push(...parsed.keys);
      }
      const batchesEnabled = stateRead.value.batchesEnabled;
      // An allow-list of the one genuinely-confident status ('read'), not a
      // deny-list of the bad ones: 'absent' is just as unconfident as
      // 'unreadable' (both mean the doc comment's "unreadable or missing"),
      // and this form is immune to a future fourth status appearing here
      // with no matching exclusion.
      complete = complete && batchesEnabled !== undefined && batchesEnabled.status === 'read';
    } else {
      complete = false;
    }
    const fleetRead = await this.call(context.deadlineIso, () =>
      this.deps.queue.listMergeEntries({ repository: context.repository, deadlineIso: this.queryDeadline(context) }),
    );
    if (fleetRead.kind === 'threw') {
      // A failed fleet-queue read is missing evidence, not a confident
      // "zero live entries": leaving `complete` true here would let a
      // divergence against the shell/import sides record a false S8
      // failure instead of surfacing that the fleet side was unavailable.
      complete = false;
    }
    const fleetLive =
      fleetRead.kind === 'threw'
        ? []
        : fleetRead.value
            .filter((entry) => entry.repoDigest === context.repoDigest)
            .filter(isMergeQueueEntryLive)
            .map((entry) => ({
              pullRequest: entry.pullRequest,
              headOid: entry.headOid,
              base: entry.baseBranch ?? 'main',
            }));
    // Dry-run only, never apply; no authority is exercised for a dry run.
    const importRead = await this.call(context.deadlineIso, () =>
      this.deps.importDryRun.importTrainState({
        repository: context.repository,
        stateDir: context.legacyStateDir,
        apply: false,
        authority: null,
      }),
    );
    let importPresent: readonly IntakeKey[] | null = null;
    let importUnknownLines = 0;
    if (importRead.kind === 'value' && importRead.value.outcome === 'dry-run') {
      importPresent = importRead.value.keys
        .filter((key) => key.disposition === 'would-import' || key.disposition === 'already-queued')
        .map((key) => ({ pullRequest: key.pullRequest, headOid: key.headOid, base: key.base }));
      const unknown = importRead.value.unknownBySource;
      importUnknownLines = unknown.queue.length + unknown.parked.length + unknown.inprogress.length;
      // A truncated dry-run report's listed keys are not the full live set:
      // this sample's import evidence cannot be trusted as complete, so it
      // must not be allowed to manufacture a persistent, false divergence.
      complete = complete && !importRead.value.keysTruncated;
    }
    return { takenAtIso, complete, shellLive, fleetLive, importPresent, importUnknownLines };
  }

  /** S8: the two-sample intake check, sampled only while the day is still yesterday. */
  private async evaluateIntakeCriterion(context: DayContext): Promise<CriterionOutcome> {
    const nowSerial = Math.floor(Date.parse(this.deps.nowIso()) / DAY_MS);
    if (context.day !== utcDayOfSerial(nowSerial - 1)) {
      return unevaluatedOutcome('S8', 'snapshot-only-for-yesterday');
    }
    const first = await this.intakeSample(context);
    // A real wall-clock gap, matching SH5c's persistence intent: two
    // independently-moving systems sampled seconds apart can manufacture a
    // divergence that resolves itself immediately after.
    await this.deps.sleep(this.deps.settings.sampleGapMs ?? DEFAULT_SAMPLE_GAP_MS);
    const second = await this.intakeSample(context);
    const evaluation = evaluateShadowIntake({ samples: [first, second] });
    return { criterion: 'S8', kind: 'evaluated', evaluation, intake: evaluation };
  }

  /** The state-check sample, or null when unavailable. */
  private async readStateCheck(deadlineIso: string | undefined): Promise<{ readonly checked: number; readonly bad: number } | null> {
    const read = await this.call(deadlineIso, () => this.deps.checkState());
    return read.kind === 'value' ? read.value : null;
  }

  /** One journal entry reduced to the four fields the S9 evaluator samples. */
  private sampledEntry(entry: LaneRunJournalEntryRecord): {
    readonly key: string | null;
    readonly kind: 'intent' | 'result' | 'conduct';
    readonly outcome: string | null;
    readonly recordedAtIso: string;
  } {
    return { key: entry.key, kind: entry.kind, outcome: entry.outcome, recordedAtIso: entry.recordedAtIso };
  }

  /** S9: conductor state integrity, sampled only while the day is still yesterday. */
  private async evaluateStateIntegrityCriterion(context: DayContext, journal: JournalRead): Promise<CriterionOutcome> {
    const nowSerial = Math.floor(Date.parse(this.deps.nowIso()) / DAY_MS);
    if (context.day !== utcDayOfSerial(nowSerial - 1)) {
      return unevaluatedOutcome('S9', 'snapshot-only-for-yesterday');
    }
    if (journal.kind === 'unavailable') {
      return unevaluatedOutcome('S9', 'fleet-journal-unavailable');
    }
    const stateCheck = await this.readStateCheck(context.deadlineIso);
    const evaluation = evaluateShadowStateIntegrity({
      stateCheck,
      journal: journal.entries.map((entry) => this.sampledEntry(entry)),
      sampledAtIso: this.deps.nowIso(),
    });
    return { criterion: 'S9', kind: 'evaluated', evaluation };
  }

  /** Whether the instant `iso` names falls in the S12 window `[D-1 23:00Z, D+1 00:00Z)`. */
  private inTickWindow(iso: string, day: string): boolean {
    const daySerial = serialOfUtcDay(day);
    const instant = Date.parse(iso);
    return instant >= daySerial * DAY_MS - HOUR_MS && instant < (daySerial + 1) * DAY_MS;
  }

  /** S12: daemon tick health over the whole day's window of projected events. */
  private async evaluateTickHealthCriterion(context: DayContext): Promise<CriterionOutcome> {
    const read = await this.call(context.deadlineIso, () => this.deps.daemonEvents.readAfterCursor(null));
    if (read.kind === 'threw' || !read.value.ok) {
      return unevaluatedOutcome('S12', 'daemon-events-unavailable');
    }
    const events = read.value.events.filter((event: DaemonEventRecord) => this.inTickWindow(event.recordedAtIso, context.day));
    return { criterion: 'S12', kind: 'evaluated', evaluation: evaluateShadowTickHealth({ day: context.day, events }) };
  }

  /**
   * The canonical summary one verdict's digest is computed over: keys in the
   * fixed order `criterion`, `day`, `status`, `reason`, then the evaluator's
   * own numeric counts — for S1 also `excludeBatchMerges`, after the counts.
   *
   * `mergeSet` (S1 only) and `intake` (S8 only) are each set by exactly one
   * criterion builder (`evaluateMergeSetCriterion`, `evaluateIntakeCriterion`
   * respectively) and never both on the same outcome, so checking `mergeSet`
   * first can never silently shadow a real `intake` value: an outcome with
   * `intake` set always has `mergeSet === undefined`, by construction, not
   * by this ordering.
   */
  private canonicalSummary(context: DayContext, outcome: Extract<CriterionOutcome, { kind: 'evaluated' }>): string {
    const base = {
      criterion: outcome.criterion,
      day: context.day,
      status: outcome.evaluation.status,
      reason: outcome.evaluation.reason,
    };
    if (outcome.mergeSet !== undefined) {
      return JSON.stringify({
        ...base,
        mergesCompared: outcome.mergeSet.mergesCompared,
        excludedBatchMerges: outcome.mergeSet.excludedBatchMerges,
        compared: outcome.mergeSet.compared,
        divergences: outcome.mergeSet.divergences,
        excludeBatchMerges: this.deps.settings.excludeBatchMerges,
      });
    }
    if (outcome.intake !== undefined) {
      return JSON.stringify({
        ...base,
        aFleetCount: outcome.intake.aFleetCount,
        aShellCount: outcome.intake.aShellCount,
        aCompared: outcome.intake.aCompared,
        aDivergences: outcome.intake.aDivergences,
        bFleetCount: outcome.intake.bFleetCount,
        bShellCount: outcome.intake.bShellCount,
        bCompared: outcome.intake.bCompared,
        bDivergences: outcome.intake.bDivergences,
      });
    }
    return JSON.stringify(base);
  }

  /** The definite verdicts, the unevaluated reasons and S1's merge count. */
  private buildVerdicts(context: DayContext, outcomes: readonly CriterionOutcome[]): BuiltVerdicts {
    const verdicts: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = {};
    const unevaluated = new Map<CutoverShadowCriterion, string>();
    let mergesCompared: number | null = null;
    const recordedAtIso = this.deps.nowIso();
    for (const outcome of outcomes) {
      if (outcome.kind === 'unevaluated') {
        unevaluated.set(outcome.criterion, outcome.reason);
        continue;
      }
      if (outcome.evaluation.status === 'unknown') {
        unevaluated.set(outcome.criterion, outcome.evaluation.reason);
        continue;
      }
      verdicts[outcome.criterion] = {
        verdict: outcome.evaluation.status,
        reason: outcome.evaluation.reason,
        digest: this.deps.computeDigest(this.canonicalSummary(context, outcome)),
        recordedAtIso,
      };
      if (outcome.mergeSet !== undefined) {
        mergesCompared = outcome.mergeSet.mergesCompared;
      }
    }
    for (const criterion of NOT_IMPLEMENTED_CRITERIA) {
      unevaluated.set(criterion, 'not-implemented');
    }
    return { verdicts, unevaluated, mergesCompared };
  }

  /** The use-case answer for a `recordShadowVerdicts` refusal code. */
  private recordRefusal(reason: 'invalid-ledger' | 'invalid-input' | 'day-out-of-order' | 'verdict-conflict' | 'release-conflict' | 'merges-conflict'): RecordShadowDayResult {
    if (reason === 'invalid-ledger') {
      return unknownResult('ledger-unreadable');
    }
    if (reason === 'invalid-input') {
      return refusedResult('invalid-request');
    }
    return refusedResult(reason);
  }

  /** The use-case answer for a compare-and-set refusal code. */
  private casRefusal(reason: 'invalid-request' | 'invalid-ledger' | 'unknown-version' | 'unreadable' | 'read-only' | 'deadline-exceeded'): RecordShadowDayResult {
    if (reason === 'deadline-exceeded') {
      return unknownResult('deadline-exceeded');
    }
    if (reason === 'unknown-version') {
      return unknownResult('ledger-unknown-version');
    }
    if (reason === 'unreadable' || reason === 'invalid-ledger') {
      return unknownResult('ledger-unreadable');
    }
    if (reason === 'invalid-request') {
      return refusedResult('invalid-request');
    }
    return unknownResult('ledger-busy');
  }

  /** The recorded/unchanged answer over the freshly saved ledger. */
  private finalResult(
    context: DayContext,
    ledger: ShadowLedger,
    changed: boolean,
    built: BuiltVerdicts,
  ): RecordShadowDayResult {
    const recorded: Partial<Record<CutoverShadowCriterion, 'pass' | 'fail'>> = {};
    for (const [criterion, verdict] of Object.entries(built.verdicts)) {
      recorded[criterion as CutoverShadowCriterion] = verdict.verdict;
    }
    const unevaluated: RecordShadowDayUnevaluated[] = [];
    for (const criterion of CUTOVER_SHADOW_CRITERIA) {
      if (recorded[criterion] !== undefined) {
        continue;
      }
      unevaluated.push({ criterion, reason: built.unevaluated.get(criterion) ?? 'not-implemented' });
    }
    return {
      outcome: changed ? 'recorded' : 'unchanged',
      day: context.day,
      revision: ledger.revision,
      recorded,
      unevaluated,
    };
  }

  /**
   * Record the day's verdicts and save the ledger by compare-and-set. On a
   * revision conflict the ledger is re-read once and the record step retried
   * exactly once; a second conflict is `ledger-busy`. Nothing is written on
   * any refusal or unknown outcome.
   */
  private async writeDay(
    context: DayContext,
    ledger: ShadowLedger | null,
    releaseSha: string | null,
    built: BuiltVerdicts,
  ): Promise<RecordShadowDayResult> {
    const input = {
      day: context.day,
      releaseSha,
      ...(built.mergesCompared === null ? {} : { mergesCompared: built.mergesCompared }),
      verdicts: built.verdicts,
    };
    let current = ledger;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) {
        const reread = await this.readLedger(context.deadlineIso);
        if (reread.kind === 'stop') {
          return reread.result;
        }
        current = reread.ledger;
      }
      const written = recordShadowVerdicts(current, input);
      if (!written.ok) {
        return this.recordRefusal(written.reason);
      }
      if (!written.changed) {
        // Idempotent re-run: `written.ledger.revision` is the same revision
        // already stored, so calling `compareAndSet` here would send
        // `next.revision === expectedRevision` — a malformed request per
        // ShadowEvidencePort.compareAndSet's contract (`next.revision` must
        // be `expectedRevision + 1`), which the real adapter correctly
        // refuses as `invalid-request`. Report `unchanged` over the
        // ledger's own, unchanged revision without calling compareAndSet.
        return this.finalResult(context, written.ledger, false, built);
      }
      const saved = await this.call(context.deadlineIso, () =>
        this.deps.evidence.compareAndSet({
          expectedRevision: current === null ? 0 : current.revision,
          next: written.ledger,
          deadlineIso: context.deadlineIso,
        }),
      );
      if (saved.kind === 'threw') {
        return unknownResult('ledger-unreadable');
      }
      if (saved.value.outcome === 'saved') {
        return this.finalResult(context, saved.value.ledger, true, built);
      }
      if (saved.value.outcome === 'refused') {
        return this.casRefusal(saved.value.reason);
      }
      if (attempt === 2) {
        return unknownResult('ledger-busy');
      }
    }
    return unknownResult('ledger-busy');
  }
}
