// Lane SH7b: the shadow day-writer. For one UTC day it evaluates every
// criterion this chain can currently compute from data that already exists —
// S1 (merge set, SH5a), S4' (gate agreement, SH11 over SH18b's head reader),
// S5' (premerge carry replay, SH19b over SH13a's shell facts and the fleet's
// carry answer), S6' (conducted conformance, SH12a/SH12b over SH18a's runs
// reader and SH13a's shell facts), S7 (chains retired, SH14), S8 (two-sample
// intake, yesterday only, SH5c), S9 (state integrity, yesterday only, SH5b)
// and S12 (daemon tick health, SH5b) — records each definite pass/fail verdict into
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
import {
  evaluateShadowGateAgreement,
  type ShadowGateAgreementEvaluation,
  type ShadowGateHeadFact,
} from '../../domain/shadow-day-gate-agreement.js';
import {
  evaluateShadowConductedConformance,
  type ShadowConformanceEvaluation,
} from '../../domain/shadow-day-conformance.js';
import {
  evaluateShadowPremergeCarry,
  extractShadowShellFacts,
  type ShadowPremergeCarryEvaluation,
  type ShadowShellCarryDecision,
  type ShadowShellFacts,
} from '../../domain/shadow-day-shell-facts.js';
import {
  evaluateShadowChainsRetired,
  SHADOW_CHAINS_POLICY,
  type ShadowChainsRetiredEvaluation,
} from '../../domain/shadow-day-chains-retired.js';
import {
  readShadowConformanceRuns,
  readShadowGateHeads,
  type ShadowConformanceRunsDependencies,
  type ShadowGateHeadsDependencies,
} from './shadow-day/index.js';
import {
  evaluateShadowStateIntegrity,
  evaluateShadowTickHealth,
  type ShadowStateIntegrityEvaluation,
  type ShadowTickHealthEvaluation,
} from '../../domain/shadow-day-health.js';
import {
  recordShadowVerdicts,
  SHADOW_RELEASE_SHA_PATTERN,
  type ShadowCriterionEvaluation,
  type ShadowCriterionVerdict,
  type ShadowLedger,
} from '../../domain/shadow-evidence-ledger.js';
import {
  evaluateShadowOneTimeCriteria,
  SHADOW_ONE_TIME_CRITERIA,
  SHADOW_ONE_TIME_REQUIREMENTS,
} from '../../domain/shadow-attestations.js';
import { isPlainRecordObject } from '../../domain/record-schema-version.js';
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
import type { ChainListResult, ChainRepositoryPort } from '../ports/out/ChainRepositoryPort.out-port.js';
import type { DaemonEventProjectionPort } from '../ports/out/DaemonEventProjectionPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type {
  LegacyTrainChainsRead,
  LegacyTrainFileRead,
  LegacyTrainStateReadPort,
} from '../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ReleaseStorePort } from '../ports/out/ReleaseStorePort.out-port.js';
import type { ShadowAttestationPort } from '../ports/out/ShadowAttestationPort.out-port.js';
import type { ShadowEvidencePort, ShadowLedgerCasResult } from '../ports/out/ShadowEvidencePort.out-port.js';
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
  'S13',
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
  /**
   * The conducted-facts readers (SH18a's runs reader, SH18b's head reader)
   * and the one repository they are conducted for. Optional until SH19c
   * wires them into composition; when absent, S4 and S6 report
   * `not-wired`, and when the request's repository differs, they report
   * `repository-not-conducted`.
   */
  readonly conducted?: {
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly facts: ShadowConformanceRunsDependencies & ShadowGateHeadsDependencies;
  };
  /**
   * The chain-record store S7 lists. Optional until SH19c wires it into
   * composition; when absent, S7 reports `not-wired`.
   */
  readonly chains?: Pick<ChainRepositoryPort, 'listChains'>;
  /**
   * The fleet's answer to one shell premerge-carry decision (S5'). Optional
   * until SH19c wires it into composition; when absent, S5 reports
   * `not-wired`.
   */
  readonly premergeCarry?: (input: {
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly decision: ShadowShellCarryDecision;
    readonly deadlineIso: string;
  }) => Promise<'carry' | 'no-carry' | 'unknown'>;
  /**
   * The one-time shadow criteria's sources (S2, S3, S10, S11): the sticky
   * attestation ledger store and the verified-build file inspector for the
   * one release root the day's pinned sha is verified under. Optional until
   * SH19c wires them into composition; when absent, all four report
   * `not-wired`.
   */
  readonly oneTime?: {
    readonly attestations: Pick<ShadowAttestationPort, 'read'>;
    readonly releaseStore: Pick<ReleaseStorePort, 'inspectReleaseFiles'>;
    readonly releaseRoot: string;
  };
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
      /** Present only for S12: the tick-health evaluation the counts come from. */
      readonly tickHealth?: ShadowTickHealthEvaluation;
      /** Present only for S9: the state-integrity evaluation the counts come from. */
      readonly stateIntegrity?: ShadowStateIntegrityEvaluation;
      /** Present only for S4': the gate-agreement evaluation and every head it was computed over. */
      readonly gateAgreement?: { readonly evaluation: ShadowGateAgreementEvaluation; readonly heads: readonly ShadowGateHeadFact[] };
      /** Present only for S6': the conducted-conformance evaluation. */
      readonly conformance?: ShadowConformanceEvaluation;
      /** Present only for S7: the chains-retired evaluation. */
      readonly chainsRetired?: ShadowChainsRetiredEvaluation;
      /** Present only for S5': the premerge-carry replay evaluation. */
      readonly premergeCarry?: ShadowPremergeCarryEvaluation;
      /** Present only for S2: the one-time criterion evaluation. */
      readonly s2?: ShadowCriterionEvaluation;
      /** Present only for S3: the one-time criterion evaluation. */
      readonly s3?: ShadowCriterionEvaluation;
      /** Present only for S10: the one-time criterion evaluation. */
      readonly s10?: ShadowCriterionEvaluation;
      /** Present only for S11: the one-time criterion evaluation. */
      readonly s11?: ShadowCriterionEvaluation;
    }
  | { readonly criterion: CutoverShadowCriterion; readonly kind: 'unevaluated'; readonly reason: string };

/**
 * The day-end shell facts shared by S6' and S5': the extractor's output over
 * the events bounded to the recorded day's own end, or the reason they are
 * unavailable. Extracted once per run, so a D+1 event can never alter a
 * closed day's facts and `readLegacyTrainEvents` is never called twice.
 */
type BoundedShellFacts =
  | { readonly ok: false; readonly reason: 'shell-events-unavailable' | 'shell-facts-invalid' }
  | { readonly ok: true; readonly facts: ShadowShellFacts; readonly unknownLines: number };

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

/**
 * One intake key's identity, matching `shadow-day-intake.ts`'s own `keyOf`
 * exactly (`${pullRequest}@${headOid}@${base}`): ids only, never echoed.
 */
function intakeKeyIdentity(key: IntakeKey): string {
  return `${key.pullRequest}@${key.headOid}@${key.base}`;
}

/**
 * `shellLive`'s `queue` and `inprogress` sources can legitimately name the
 * same live PR twice: `cutover.ts`'s own doc comment on the `inprogress`
 * field records the crash-leftover case where a PR has left the queue but
 * not yet merged, while a stale `queue` line for it lingers from an earlier
 * crash. That is one live PR, not two — but it is the ONLY documented,
 * legitimate cross-source overlap, so this collapses exactly that: one
 * `queue`/`inprogress` pair per shared `(pullRequest, headOid, base)`
 * identity (`intakeKeyIdentity`), nothing more.
 *
 * `parked` keys are never touched here: they pass straight into the result
 * exactly as parsed, whether or not their identity also appears in `queue`
 * or `inprogress`, because no doc comment names that combination as a
 * known, legitimate overlap. A key repeated WITHIN one source alone (two
 * `queue` lines naming the same PR, say) is likewise never touched, for the
 * same reason — and that repeat is the genuine anomaly
 * `compareShadowEnqueueSets`'s own duplicate detection (`invalid-item`)
 * exists to catch. Collapsing either of those would silently hide a real
 * divergence and let S8 record a false pass.
 *
 * Implemented as a multiset intersection: each `inprogress` key is dropped
 * only while an as-yet-unmatched `queue` occurrence of the same identity
 * remains, so a key present N times in each source is collapsed by exactly
 * N pairs — never more, and never for an identity `queue` does not also
 * carry.
 */
function mergeShellLiveSources(
  queueKeys: readonly IntakeKey[],
  parkedKeys: readonly IntakeKey[],
  inprogressKeys: readonly IntakeKey[],
): readonly IntakeKey[] {
  const unmatchedQueueCount = new Map<string, number>();
  for (const key of queueKeys) {
    const identity = intakeKeyIdentity(key);
    unmatchedQueueCount.set(identity, (unmatchedQueueCount.get(identity) ?? 0) + 1);
  }
  const keptInprogress: IntakeKey[] = [];
  for (const key of inprogressKeys) {
    const identity = intakeKeyIdentity(key);
    const remaining = unmatchedQueueCount.get(identity) ?? 0;
    if (remaining > 0) {
      unmatchedQueueCount.set(identity, remaining - 1);
      continue;
    }
    keptInprogress.push(key);
  }
  return [...parkedKeys, ...queueKeys, ...keptInprogress];
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

/** The `CriterionOutcome` sibling field each one-time criterion's evaluation is recorded under. */
const ONE_TIME_OUTCOME_FIELDS: Readonly<
  Record<(typeof SHADOW_ONE_TIME_CRITERIA)[number], 's2' | 's3' | 's10' | 's11'>
> = Object.freeze({ S2: 's2', S3: 's3', S10: 's10', S11: 's11' });

/**
 * One required-test report as `evaluateShadowOneTimeCriteria` consumes it:
 * the positional `files[i]` fact zipped to the request's `paths[i]`.
 */
interface ReleaseTestReport {
  readonly path: string;
  readonly present: boolean;
  readonly quarantined: boolean | null;
}

/**
 * One own data property of an untrusted object: `Object.getOwnPropertyDescriptor`
 * never runs a getter (only `.value` is taken) and, on a plain record, never
 * throws for a missing key. A Proxy stand-in is refused by the caller's
 * `isPlainRecordObject` guard or by the try/catch around the whole read.
 */
function ownDataProperty(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * Read an outer `attestations.read` result as an EXACT plain record:
 * `status: 'missing'` must carry exactly the own data key `status`, and
 * `status: 'ok'` must carry exactly the own data keys `status` and `ledger`.
 * Every key check goes through `Reflect.ownKeys` and
 * `Object.getOwnPropertyDescriptor`, so no accessor ever runs and nothing
 * throws out of `execute`. Any extra key, accessor, wrong type or non-plain
 * object yields the invalid-attestations seed `{}`, which the domain
 * evaluator refuses as `attestations-unreadable` for all four criteria —
 * never a pass, never an absent store.
 */
function readAttestationResult(value: unknown): unknown {
  if (!isPlainRecordObject(value)) {
    return {};
  }
  const names = Reflect.ownKeys(value);
  const status = ownDataProperty(value, 'status');
  if (status === 'missing') {
    if (names.length === 1 && names[0] === 'status') {
      return null;
    }
    return {};
  }
  if (status === 'ok') {
    if (names.length === 2 && names.includes('ledger')) {
      const ledger = ownDataProperty(value, 'ledger');
      return ledger === undefined ? {} : ledger;
    }
    return {};
  }
  return {};
}

/**
 * Zip SH17's positional release-file facts onto the deduplicated required
 * test paths. Every read goes through `Object.getOwnPropertyDescriptor` (the
 * array's own `length` descriptor, so no Proxy `get` trap runs) and a
 * `try/catch`, so a hostile container never throws out of `execute`. Any bad
 * outer result (`null`, primitive, non-plain, getter-bearing), `threw`
 * outcome, non-array `files`, length mismatch, non-plain item, or
 * non-`boolean`/non-`null` flag yields `null` — unevaluated, never an empty
 * list (an empty list would report every required test absent, a fail that
 * an unreadable tree must never produce).
 */
function zipReleaseTests(paths: readonly string[], inspection: unknown): readonly ReleaseTestReport[] | null {
  try {
    if (!isPlainRecordObject(inspection)) {
      return null;
    }
    if (ownDataProperty(inspection, 'outcome') !== 'read') {
      return null;
    }
    const files = ownDataProperty(inspection, 'files');
    if (!Array.isArray(files)) {
      return null;
    }
    const length = Object.getOwnPropertyDescriptor(files, 'length')?.value;
    if (typeof length !== 'number' || length !== paths.length) {
      return null;
    }
    const reports: ReleaseTestReport[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(files, String(index))?.value;
      if (!isPlainRecordObject(item)) {
        return null;
      }
      const present = ownDataProperty(item, 'present');
      const quarantined = ownDataProperty(item, 'quarantined');
      if (typeof present !== 'boolean' || !(quarantined === null || typeof quarantined === 'boolean')) {
        return null;
      }
      reports.push({ path: paths[index] ?? '', present, quarantined });
    }
    return reports;
  } catch {
    return null;
  }
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
    // The shell events are read once and shared by S1, S6' and S5', so
    // `readLegacyTrainEvents` is never called twice in one run.
    const shell = await this.readShellEvents(context);
    // The day-end facts are extracted once and shared by S6' and S5', so a
    // D+1 event can never alter a closed day's carry decisions, incomplete
    // head moves or anomalies.
    const shellFacts = this.extractBoundedShellFacts(context, shell);
    // S1's live reads follow the journal and shell reads directly, so intake's
    // 150 s settle sleep cannot push them minutes past the evidence they
    // reconcile against.
    const mergeSet = await this.evaluateMergeSetCriterion(context, journal, shell);
    const intake = await this.evaluateIntakeCriterion(context);
    const outcomes = [
      mergeSet,
      intake.outcome,
      await this.evaluateStateIntegrityCriterion(context, journal),
      await this.evaluateTickHealthCriterion(context),
      await this.evaluateGateAgreementCriterion(context),
      await this.evaluateConformanceCriterion(context, shellFacts),
      await this.evaluateChainsRetiredCriterion(context, intake.chains),
      await this.evaluatePremergeCarryCriterion(context, shellFacts),
      ...(await this.evaluateOneTimeCriteria(context, releaseSha)),
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
   * The deadline is re-checked once the awaited outcome lands — fulfilled or
   * rejected — before anything is derived from it: the port may have run past
   * the deadline while awaited, and that expiry must abort the run the same
   * way a pre-call expiry does, even when the operation itself threw.
   */
  private async call<T>(deadlineIso: string | undefined, make: () => Promise<T>): Promise<{ readonly kind: 'value'; readonly value: T } | { readonly kind: 'threw' }> {
    if (this.deadlineReached(deadlineIso)) {
      throw new DeadlineReachedError();
    }
    let value: T;
    try {
      value = await make();
    } catch {
      if (this.deadlineReached(deadlineIso)) {
        throw new DeadlineReachedError();
      }
      return { kind: 'threw' };
    }
    if (this.deadlineReached(deadlineIso)) {
      throw new DeadlineReachedError();
    }
    return { kind: 'value', value };
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

  /** The parsed shell train events, or the reason S1/S6' is unevaluated. */
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
  private async evaluateMergeSetCriterion(
    context: DayContext,
    journal: JournalRead,
    shell: { readonly events: readonly ShellTrainEvent[]; readonly unknownLines: number } | string,
  ): Promise<CriterionOutcome> {
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
   * intake keys it contributes plus whether it was incomplete. A missing
   * field (`undefined`) or an `'unreadable'` read is genuinely unknown
   * evidence and counts as incomplete; an `'absent'` read is a confident,
   * known-empty source (no entries) exactly as `cutover.ts`'s own handling
   * of these same fields treats it (`status === 'absent' ? 0 : ...`), so it
   * contributes zero keys and does NOT mark the sample incomplete. An
   * unparseable line still counts as incomplete, so the sample's `complete`
   * flag fails closed on real unknowns without fabricating one for the
   * ordinary "file doesn't exist" case (an idle shell train has no
   * `inprogress` file; a shell with no batching configured has no
   * `batches/enabled` file). Parked lines are the shell's 6-field record,
   * parsed with the parked parser, as the shadow report does; queue and
   * inprogress lines parse with the queue parser.
   */
  private parsedShellSource(
    read: LegacyTrainFileRead | undefined,
    parked: boolean,
  ): { readonly keys: readonly IntakeKey[]; readonly incomplete: boolean } {
    if (read === undefined || read.status === 'unreadable') {
      return { keys: [], incomplete: true };
    }
    if (read.status === 'absent') {
      return { keys: [], incomplete: false };
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
   * parsed separately, then combined into `shellLive` by
   * `mergeShellLiveSources`, which collapses ONLY the one documented
   * cross-source overlap (`cutover.ts`'s own doc comment on the
   * `inprogress` field: the same PR/head can legitimately appear in both
   * `queue` and `inprogress` after a crash — one live PR, not two) and
   * leaves every other repeat untouched, including a key repeated within a
   * single source alone and any repeat involving `parked` — those are the
   * genuine anomalies `compareShadowEnqueueSets`'s own `invalid-item`
   * detection exists to catch, and collapsing them here would silently hide
   * that anomaly and let S8 record a false pass. The fleet queue's live
   * entries for this repository go into `fleetLive` (each under its own
   * recorded base, `main` when it has none); the import dry-run's
   * would-import/already-queued keys go into `importPresent`, null when the
   * dry-run is refused or unavailable. The `complete` flag is false when any
   * shell source has an unknown line or is genuinely unknown (unreadable, or
   * the field itself missing), or `batchesEnabled` is unreadable or missing
   * — never a guessed pass, but also never a false incomplete for the
   * ordinary case where a source file legitimately does not exist
   * (`'absent'`): that is a confident, known-empty read, exactly as
   * `cutover.ts`'s own handling of `shellState.batch.status`/
   * `batchesEnabled.status` treats it (`status === 'absent' ? 0 : ...`).
   *
   * The shell state's `chains` read is returned beside the sample (not added
   * to it, because `evaluateShadowIntake` reads samples with
   * `readExactPlainRecord`'s exact-key rule): S7 consumes it as the shell
   * side's chain names, taken from the second sample — the read closest to
   * recording.
   */
  private async intakeSample(
    context: DayContext,
  ): Promise<{ readonly sample: IntakeSample; readonly chains: LegacyTrainChainsRead | undefined }> {
    const takenAtIso = this.deps.nowIso();
    let chains: LegacyTrainChainsRead | undefined;
    let queueKeys: readonly IntakeKey[] = [];
    let parkedKeys: readonly IntakeKey[] = [];
    let inprogressKeys: readonly IntakeKey[] = [];
    let complete = true;
    const stateRead = await this.call(
      context.deadlineIso,
      () => this.deps.legacy.readLegacyTrainState({ stateDir: context.legacyStateDir }),
    );
    if (stateRead.kind === 'value') {
      chains = stateRead.value.chains;
      const queueParsed = this.parsedShellSource(stateRead.value.queue, false);
      const parkedParsed = this.parsedShellSource(stateRead.value.parked, true);
      const inprogressParsed = this.parsedShellSource(stateRead.value.inprogress, false);
      complete = complete && !queueParsed.incomplete && !parkedParsed.incomplete && !inprogressParsed.incomplete;
      queueKeys = queueParsed.keys;
      parkedKeys = parkedParsed.keys;
      inprogressKeys = inprogressParsed.keys;
      const batchesEnabled = stateRead.value.batchesEnabled;
      // A deny-list of the one genuinely-unknown status ('unreadable'), not
      // an allow-list of 'read' alone: 'absent' is a confident known-empty
      // read for this field too (the field itself still being present, per
      // its own doc comment, is checked separately by `!== undefined`),
      // matching `cutover.ts`'s own treatment of this exact field
      // (`batchesEnabled.status === 'absent' ? 0 : ...`).
      complete = complete && batchesEnabled !== undefined && batchesEnabled.status !== 'unreadable';
    } else {
      complete = false;
    }
    const shellLive = mergeShellLiveSources(queueKeys, parkedKeys, inprogressKeys);
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
    return { sample: { takenAtIso, complete, shellLive, fleetLive, importPresent, importUnknownLines }, chains };
  }

  /**
   * S8: the two-sample intake check, sampled only while the day is still
   * yesterday. The second sample's shell `chains` read rides along for S7,
   * so S7 never needs a third `readLegacyTrainState` call; it is `undefined`
   * when S8 short-circuits (then S7 short-circuits on its own day check
   * too) or when the sample's state read failed.
   */
  private async evaluateIntakeCriterion(
    context: DayContext,
  ): Promise<{ readonly outcome: CriterionOutcome; readonly chains: LegacyTrainChainsRead | undefined }> {
    const nowSerial = Math.floor(Date.parse(this.deps.nowIso()) / DAY_MS);
    if (context.day !== utcDayOfSerial(nowSerial - 1)) {
      return { outcome: unevaluatedOutcome('S8', 'snapshot-only-for-yesterday'), chains: undefined };
    }
    const first = await this.intakeSample(context);
    // A real wall-clock gap, matching SH5c's persistence intent: two
    // independently-moving systems sampled seconds apart can manufacture a
    // divergence that resolves itself immediately after.
    await this.deps.sleep(this.deps.settings.sampleGapMs ?? DEFAULT_SAMPLE_GAP_MS);
    const second = await this.intakeSample(context);
    const evaluation = evaluateShadowIntake({ samples: [first.sample, second.sample] });
    return {
      outcome: { criterion: 'S8', kind: 'evaluated', evaluation, intake: evaluation },
      chains: second.chains,
    };
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
      day: context.day,
      stateCheck,
      journal: journal.entries.map((entry) => this.sampledEntry(entry)),
      sampledAtIso: this.deps.nowIso(),
    });
    return { criterion: 'S9', kind: 'evaluated', evaluation, stateIntegrity: evaluation };
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
    const evaluation = evaluateShadowTickHealth({ day: context.day, events });
    return { criterion: 'S12', kind: 'evaluated', evaluation, tickHealth: evaluation };
  }

  /** The request's repository is exactly the repository the conducted facts were read for. */
  private repositoryIsConducted(context: DayContext): boolean {
    const conducted = this.deps.conducted;
    return (
      conducted !== undefined &&
      conducted.repository.owner === context.repository.owner &&
      conducted.repository.repo === context.repository.repo
    );
  }

  /**
   * S4': conductor gate verdicts against the CI `gate` context over the
   * trailing three UTC days, through SH18b's head reader and SH11's
   * evaluator. An unsettled head (any CI state but success/failure) blocks
   * the day regardless of the evaluation's status: a `fail` recorded with
   * pending heads is not closed-day stable — `too-few-agreeing-heads` can
   * flip to pass and a `gate-false-pass` would carry a different
   * `headsDigest`, each a permanent day-wide `verdict-conflict`.
   */
  private async evaluateGateAgreementCriterion(context: DayContext): Promise<CriterionOutcome> {
    const conducted = this.deps.conducted;
    if (conducted === undefined) {
      return unevaluatedOutcome('S4', 'not-wired');
    }
    if (!this.repositoryIsConducted(context)) {
      return unevaluatedOutcome('S4', 'repository-not-conducted');
    }
    const read = await this.call(context.deadlineIso, () =>
      readShadowGateHeads(conducted.facts, {
        day: context.day,
        repository: context.repository,
        deadlineIso: this.queryDeadline(context),
      }),
    );
    // Defensive: the real reader never rejects (it turns every internal
    // failure into a typed `unknown` result); this guards future changes.
    if (read.kind === 'threw') {
      return unevaluatedOutcome('S4', 'gate-heads-read-failed');
    }
    if (read.value.status === 'unknown') {
      return unevaluatedOutcome('S4', read.value.reason);
    }
    const evaluation = evaluateShadowGateAgreement({ day: context.day, heads: read.value.heads });
    if (evaluation.unsettled > 0) {
      return unevaluatedOutcome('S4', 'gate-heads-unsettled');
    }
    if (evaluation.status === 'unknown') {
      return unevaluatedOutcome('S4', evaluation.reason);
    }
    return {
      criterion: 'S4',
      kind: 'evaluated',
      evaluation,
      gateAgreement: { evaluation, heads: read.value.heads },
    };
  }

  /**
   * S6': conducted-run conformance over the day's shell merges, through
   * SH13a's shell-facts extractor and SH18a's runs reader. The shell facts
   * were extracted once in `run()` from the events bounded to the recorded
   * day's own end, so a later event on D+1 can never alter
   * `headMovesIncompleteFor` or the extracted facts of a closed day. The
   * window `[D-2 00:00Z, D+1 00:00Z)` bounds both the `unresolved-merge`
   * anomaly check and the merged pull requests passed to the reader.
   */
  private async evaluateConformanceCriterion(
    context: DayContext,
    shellFacts: BoundedShellFacts,
  ): Promise<CriterionOutcome> {
    const conducted = this.deps.conducted;
    if (conducted === undefined) {
      return unevaluatedOutcome('S6', 'not-wired');
    }
    if (!this.repositoryIsConducted(context)) {
      return unevaluatedOutcome('S6', 'repository-not-conducted');
    }
    if (!shellFacts.ok) {
      return unevaluatedOutcome('S6', shellFacts.reason);
    }
    const facts = shellFacts.facts;
    const daySerial = serialOfUtcDay(context.day);
    const windowEndMs = (daySerial + 1) * DAY_MS;
    const windowStartMs = (daySerial - 2) * DAY_MS;
    const inWindow = (atIso: string): boolean => {
      const instant = Date.parse(atIso);
      return instant >= windowStartMs && instant < windowEndMs;
    };
    if (facts.anomalies.some((anomaly) => anomaly.code === 'unresolved-merge' && inWindow(anomaly.atIso))) {
      return unevaluatedOutcome('S6', 'shell-merges-incomplete');
    }
    const mergedPullRequests = [...new Set(facts.merges.filter((merge) => inWindow(merge.atIso)).map((merge) => merge.pullRequest))];
    const read = await this.call(context.deadlineIso, () =>
      readShadowConformanceRuns(conducted.facts, { mergedPullRequests, deadlineIso: this.queryDeadline(context) }),
    );
    // Defensive: the real reader never rejects (it turns every internal
    // failure into a typed `unknown` result); this guards future changes.
    if (read.kind === 'threw') {
      return unevaluatedOutcome('S6', 'conformance-runs-read-failed');
    }
    if (read.value.status === 'unknown') {
      return unevaluatedOutcome('S6', read.value.reason);
    }
    const evaluation = evaluateShadowConductedConformance({
      day: context.day,
      runs: read.value.runs,
      merges: facts.merges,
      headMoves: facts.headMoves,
      headMovesIncompleteFor: facts.headMovesIncompleteFor,
    });
    return { criterion: 'S6', kind: 'evaluated', evaluation, conformance: evaluation };
  }

  /**
   * The day-end shell facts, extracted once per run and shared by S6' and
   * S5'. The shell events are filtered to the recorded day's own end, so a
   * later event on D+1 can never alter a closed day's `carryDecisions`,
   * `headMovesIncompleteFor` or `anomalies`. An unavailable shell read, a
   * shell record with unknown lines, an unparseable event instant or an
   * extractor refusal all leave the facts unavailable with the reason S6'
   * and S5' report unchanged from their pre-hoist behavior.
   */
  private extractBoundedShellFacts(
    context: DayContext,
    shell: { readonly events: readonly ShellTrainEvent[]; readonly unknownLines: number } | string,
  ): BoundedShellFacts {
    if (typeof shell === 'string' || shell.unknownLines > 0) {
      return { ok: false, reason: 'shell-events-unavailable' };
    }
    const windowEndMs = (serialOfUtcDay(context.day) + 1) * DAY_MS;
    const boundedEvents: ShellTrainEvent[] = [];
    for (const event of shell.events) {
      const atMs = Date.parse(event.atIso);
      // Defensive: `parseShellTrainEvents` only emits valid `atIso`; this
      // guards future changes to that parser rather than silently dropping
      // an unparseable instant from a closed day's evidence.
      if (Number.isNaN(atMs)) {
        return { ok: false, reason: 'shell-facts-invalid' };
      }
      if (atMs < windowEndMs) {
        boundedEvents.push(event);
      }
    }
    const extracted = extractShadowShellFacts(boundedEvents);
    // Defensive: unreachable on `parseShellTrainEvents`'s own output (each
    // event is already in shape); this guards future parser changes rather
    // than passing an empty fact set as real evidence.
    if (!extracted.ok) {
      return { ok: false, reason: 'shell-facts-invalid' };
    }
    return { ok: true, facts: extracted.facts, unknownLines: shell.unknownLines };
  }

  /**
   * S5' (OD-3b): the shell train's premerge carry decisions replayed through
   * the fleet's answer, via SH13a's shell facts (already extracted in
   * `run()` from the events bounded to the day's own end) and the optional
   * `premergeCarry` resolver. Only the day's own decisions are resolved: a
   * decision the resolver throws on, or answers with anything but
   * `carry`/`no-carry`, counts as `unknown`, which the evaluator refuses
   * with `fleet-carry-unknown` rather than guessing. The decisions and
   * anomalies handed to the evaluator are fresh plain objects built from the
   * extracted facts, never caller-supplied structures.
   */
  private async evaluatePremergeCarryCriterion(
    context: DayContext,
    shellFacts: BoundedShellFacts,
  ): Promise<CriterionOutcome> {
    const premergeCarry = this.deps.premergeCarry;
    if (premergeCarry === undefined) {
      return unevaluatedOutcome('S5', 'not-wired');
    }
    if (!shellFacts.ok) {
      return unevaluatedOutcome('S5', shellFacts.reason);
    }
    const dayStartMs = serialOfUtcDay(context.day) * DAY_MS;
    const dayEndMs = dayStartMs + DAY_MS;
    const decisions: { readonly pullRequest: number; readonly oldHeadOid: string; readonly newHeadOid: string; readonly atIso: string; readonly shellCarry: 'carried' | 'not-carried'; readonly fleetCarry: 'carry' | 'no-carry' | 'unknown' }[] = [];
    for (const decision of shellFacts.facts.carryDecisions) {
      const atMs = Date.parse(decision.atIso);
      if (Number.isNaN(atMs) || atMs < dayStartMs || atMs >= dayEndMs) {
        continue;
      }
      const answered = await this.call(context.deadlineIso, () =>
        premergeCarry({ repository: context.repository, decision, deadlineIso: this.queryDeadline(context) }),
      );
      const fleetCarry = answered.kind === 'threw' || (answered.value !== 'carry' && answered.value !== 'no-carry')
        ? 'unknown'
        : answered.value;
      decisions.push({
        pullRequest: decision.pullRequest,
        oldHeadOid: decision.oldHeadOid,
        newHeadOid: decision.newHeadOid,
        atIso: decision.atIso,
        shellCarry: decision.shellCarry,
        fleetCarry,
      });
    }
    const anomalies = shellFacts.facts.anomalies.map((anomaly) => ({ atIso: anomaly.atIso, code: anomaly.code }));
    const evaluation = evaluateShadowPremergeCarry({
      day: context.day,
      unknownLines: shellFacts.unknownLines,
      decisions,
      anomalies,
    });
    if (evaluation.status === 'unknown') {
      return unevaluatedOutcome('S5', evaluation.reason);
    }
    return { criterion: 'S5', kind: 'evaluated', evaluation, premergeCarry: evaluation };
  }

  /**
   * S7: chains are not kept (OD-5), checked against the fleet's chain-record
   * states and the shell train's chain names. Both sides are live counts
   * (like S8), so this is evaluated only while the day is still yesterday,
   * using the chains read S8's second intake sample already carried — never
   * a third `readLegacyTrainState` call. A side that could not be read is
   * `null`, never `[]`: `evaluateShadowChainsRetired` reports
   * `chain-state-unreadable` for it and the day stays unevaluated.
   */
  private async evaluateChainsRetiredCriterion(
    context: DayContext,
    shellChains: LegacyTrainChainsRead | undefined,
  ): Promise<CriterionOutcome> {
    const nowSerial = Math.floor(Date.parse(this.deps.nowIso()) / DAY_MS);
    if (context.day !== utcDayOfSerial(nowSerial - 1)) {
      return unevaluatedOutcome('S7', 'snapshot-only-for-yesterday');
    }
    const chains = this.deps.chains;
    if (chains === undefined) {
      return unevaluatedOutcome('S7', 'not-wired');
    }
    const list: { readonly kind: 'value'; readonly value: ChainListResult } | { readonly kind: 'threw' } = await this.call(
      context.deadlineIso,
      () => chains.listChains({ repository: context.repository, deadlineIso: this.queryDeadline(context) }),
    );
    const fleetChainStates =
      list.kind === 'value' && list.value.status === 'ok' ? list.value.records.map((record) => record.state) : null;
    const shellChainNames =
      shellChains === undefined || shellChains.status === 'unreadable'
        ? null
        : shellChains.status === 'absent'
          ? []
          : shellChains.chains.map((chain) => chain.name);
    const evaluation = evaluateShadowChainsRetired({
      policy: SHADOW_CHAINS_POLICY,
      fleetChainStates,
      shellChainNames,
    });
    if (evaluation.status === 'unknown') {
      return unevaluatedOutcome('S7', evaluation.reason);
    }
    return { criterion: 'S7', kind: 'evaluated', evaluation, chainsRetired: evaluation };
  }

  /**
   * S2, S3, S10 and S11: the one-time criteria, judged from the sticky
   * attestation ledger plus the day's pinned release tree. Re-evaluated and
   * recorded on EVERY day with no "already passed" shortcut, because
   * `readCutoverShadowEvidence` requires all thirteen criteria to pass on
   * each of the three consecutive days. The ledger read and the release
   * inspection both go through `call`, so a reached deadline — before or
   * after the awaited value — aborts the whole run.
   *
   * The outer port results are untrusted: a bad outer `attestations.read`
   * result (`null`, primitive, non-plain, getter-bearing) becomes a
   * non-null invalid value so the evaluator answers `attestations-unreadable`
   * for all four (never a pass), and a bad outer `inspectReleaseFiles`
   * result makes `releaseTests = null` (`release-tree-unreadable`, never an
   * empty list). `inspectReleaseFiles` is skipped — never trusted — when
   * the sha is absent or malformed, the release root is empty, or the
   * optional method is absent.
   */
  private async evaluateOneTimeCriteria(context: DayContext, releaseSha: string | null): Promise<readonly CriterionOutcome[]> {
    const oneTime = this.deps.oneTime;
    if (oneTime === undefined) {
      return SHADOW_ONE_TIME_CRITERIA.map((criterion) => unevaluatedOutcome(criterion, 'not-wired'));
    }

    const read = await this.call(context.deadlineIso, () =>
      oneTime.attestations.read({ deadlineIso: context.deadlineIso }),
    );
    let attestationsInput: unknown = {};
    if (read.kind === 'value') {
      try {
        attestationsInput = readAttestationResult(read.value);
      } catch {
        attestationsInput = {};
      }
    }

    // The deduplicated union of every criterion's required test paths, in
    // the criteria's own fixed order; SH17's `files` are positional, so
    // `files[i]` answers `requiredTestPaths[i]`.
    const requiredTestPaths = [
      ...new Set(SHADOW_ONE_TIME_CRITERIA.flatMap((criterion) => [...SHADOW_ONE_TIME_REQUIREMENTS[criterion].tests])),
    ];
    let releaseTests: readonly ReleaseTestReport[] | null = null;
    const inspectReleaseFiles = oneTime.releaseStore.inspectReleaseFiles;
    if (
      releaseSha !== null &&
      SHADOW_RELEASE_SHA_PATTERN.test(releaseSha) &&
      oneTime.releaseRoot.trim() !== '' &&
      inspectReleaseFiles !== undefined
    ) {
      const inspection = await this.call(context.deadlineIso, () =>
        inspectReleaseFiles({ root: oneTime.releaseRoot, sha: releaseSha, paths: requiredTestPaths }),
      );
      releaseTests = inspection.kind === 'value' ? zipReleaseTests(requiredTestPaths, inspection.value) : null;
    }

    const evaluations = evaluateShadowOneTimeCriteria({
      day: context.day,
      releaseSha,
      attestations: attestationsInput,
      releaseTests,
    });
    return SHADOW_ONE_TIME_CRITERIA.map((criterion): CriterionOutcome => {
      const evaluation = evaluations[criterion];
      if (evaluation.status === 'unknown') {
        return unevaluatedOutcome(criterion, evaluation.reason);
      }
      const field = ONE_TIME_OUTCOME_FIELDS[criterion];
      return { criterion, kind: 'evaluated', evaluation, [field]: evaluation } as CriterionOutcome;
    });
  }

  /**
   * The canonical summary one verdict's digest is computed over: keys in the
   * fixed order `criterion`, `day`, `status`, `reason`, then the evaluator's
   * own numeric counts — for S1 also `excludeBatchMerges`, after the counts.
   * S8 is the exception: its eight counts are live samples with no per-item
   * timestamp, so they are excluded and S8's digest hashes only
   * `{ criterion, day, status, reason }`.
   *
   * `mergeSet` (S1 only), `intake` (S8 only), `tickHealth` (S12 only),
   * `stateIntegrity` (S9 only), `gateAgreement` (S4' only), `conformance`
   * (S6' only), `chainsRetired` (S7 only), `premergeCarry` (S5' only) and
   * the four one-time fields `s2`/`s3`/`s10`/`s11` (S2/S3/S10/S11 only)
   * are mutually exclusive, so at
   * most one count field is ever set on any outcome. Each is set by exactly
   * one criterion builder (`evaluateMergeSetCriterion`,
   * `evaluateIntakeCriterion`, `evaluateTickHealthCriterion`,
   * `evaluateStateIntegrityCriterion`, `evaluateGateAgreementCriterion`,
   * `evaluateConformanceCriterion`, `evaluateChainsRetiredCriterion`,
   * `evaluatePremergeCarryCriterion` and `evaluateOneTimeCriteria`
   * respectively) and never more than one on the same outcome, so checking
   * them in this order can never silently shadow another: an outcome with a
   * later field set always has the earlier fields `undefined`, by
   * construction, not by this ordering.
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
    /**
     * All eight S8 counts are live queue/shell/import snapshots with no
     * per-item timestamp (only `takenAtIso`), not data scoped to UTC day
     * `D`, so any queue movement between two `record-day` runs for the same
     * closed day would change the digest while verdict and reason stay
     * equal. They are therefore excluded from S8's digest, which hashes
     * only `{ criterion, day, status, reason }`; `outcome.intake` stays on
     * the outcome as a non-digested diagnostic. This changes the S8 digest
     * format (allowed because no live shadow day has been recorded yet;
     * live recording starts only after the digest format is final).
     */
    if (outcome.intake !== undefined) {
      return JSON.stringify(base);
    }
    if (outcome.tickHealth !== undefined) {
      return JSON.stringify({
        ...base,
        totalTicks: outcome.tickHealth.totalTicks,
        budgetOverruns: outcome.tickHealth.budgetOverruns,
        starvedJobs: outcome.tickHealth.starvedJobs,
      });
    }
    /**
     * S9's digest carries only the five day-scoped, closed-day-deterministic
     * counts: `journalKeys`, `duplicateIntents`, `duplicateResults`,
     * `resultsAfterFinal` and `orphanResults`. The evaluator scopes those to
     * the recorded UTC day `D` over the `Date.parse` interval `[D, D+1)`, so
     * journal activity after `D` no longer changes them between two
     * `record-day` runs for the same closed day. Excluded from the digest and
     * kept on `outcome.stateIntegrity` as non-digested diagnostics:
     * `stateChecked` and `stateBad` (live `checkState()` samples) and
     * `unreconciledIntents` (a live `sampledAtIso` grace-window sample) — any
     * of them can change between two runs while verdict and reason stay equal.
     * `status` and `reason` stay live in `base`, so a pass/fail flip through
     * `stateBad` or `unreconciled-intent` remains a deliberate
     * `verdict-conflict`. This changes the S9 digest format (allowed because
     * no live shadow day has been recorded yet; live recording starts only
     * after the digest format is final).
     */
    if (outcome.stateIntegrity !== undefined) {
      return JSON.stringify({
        ...base,
        journalKeys: outcome.stateIntegrity.journalKeys,
        duplicateIntents: outcome.stateIntegrity.duplicateIntents,
        duplicateResults: outcome.stateIntegrity.duplicateResults,
        resultsAfterFinal: outcome.stateIntegrity.resultsAfterFinal,
        orphanResults: outcome.stateIntegrity.orphanResults,
      });
    }
    /**
     * S4' carries its four day-scoped counts (`compared`, `agreeing`,
     * `falsePasses`, `stricterFails`) plus `headsDigest`, a digest over
     * every head's four identifying fields (`headOid`, `conductorVerdict`,
     * `pushedAtIso`, `ciGate`). `unsettled` is dropped: an `unsettled > 0`
     * day is always unevaluated (`gate-heads-unsettled`), so every head on
     * an evaluated day is settled, and a later CI change on any head is a
     * deliberate `verdict-conflict` rather than a silent overwrite. This is
     * a new digest format (allowed because no live shadow day has been
     * recorded yet; live recording starts only after the digest format is
     * final).
     */
    if (outcome.gateAgreement !== undefined) {
      const headsDigest = this.deps.computeDigest(
        JSON.stringify(
          outcome.gateAgreement.heads.map((head) => ({
            headOid: head.headOid,
            conductorVerdict: head.conductorVerdict,
            pushedAtIso: head.pushedAtIso,
            ciGate: head.ciGate,
          })),
        ),
      );
      return JSON.stringify({
        ...base,
        compared: outcome.gateAgreement.evaluation.compared,
        agreeing: outcome.gateAgreement.evaluation.agreeing,
        falsePasses: outcome.gateAgreement.evaluation.falsePasses,
        stricterFails: outcome.gateAgreement.evaluation.stricterFails,
        headsDigest,
      });
    }
    /**
     * S6' hashes only `{ criterion, day, status, reason }` (like S8): every
     * S6' count (`mergedRuns`, `conforming`, `conformingTier1`,
     * `conformingTier2`, `nonconformingOnDay` and all six `byCode` counts)
     * depends on `readShadowConformanceRuns`, which reads live stores not
     * time-bounded to day `D` — runs list, latest collected attempt heads
     * and review receipts — so any of them can change between two
     * `record-day` runs for the same closed day while the verdict stays
     * equal. `outcome.conformance` stays on the outcome as a non-digested
     * diagnostic. This is a new digest format (allowed because no live
     * shadow day has been recorded yet).
     */
    if (outcome.conformance !== undefined) {
      return JSON.stringify(base);
    }
    /**
     * S7 hashes only `{ criterion, day, status, reason }` (like S8):
     * `fleetActive` and `shellActive` are live counts of active chain
     * records and shell chain files, both changeable between two runs for
     * the same closed day while the verdict stays equal.
     * `outcome.chainsRetired` stays on the outcome as a non-digested
     * diagnostic. This is a new digest format (allowed because no live
     * shadow day has been recorded yet).
     */
    if (outcome.chainsRetired !== undefined) {
      return JSON.stringify(base);
    }
    /**
     * S5' hashes `compared` with the base: it is the count of deduped,
     * day-scoped carry decisions the evaluator compared, so it is closed-day
     * deterministic — a day with zero carry decisions records `pass`
     * (`carry-decisions-equal`) with `compared: 0` and counts toward the
     * evidence window. `laxCarries` and `stricterNoCarries` depend on the
     * (possibly absent) `premergeCarry` resolver's answers between two runs
     * and stay on `outcome.premergeCarry` as non-digested diagnostics, so a
     * resolver-less rerun of an evaluated day cannot silently become a
     * verdict conflict. This is a new digest format (allowed because no live
     * shadow day has been recorded yet).
     */
    if (outcome.premergeCarry !== undefined) {
      return JSON.stringify({ ...base, compared: outcome.premergeCarry.compared });
    }
    /**
     * S2, S3, S10 and S11 hash only `{ criterion, day, status, reason }`
     * (like S8): their evaluation is closed-day deterministic — the sticky
     * ledger's facts are compared against the recorded day itself and the
     * test facts belong to the day's own pinned release — but the digests
     * stay base-only so a re-recording of an attestation or a release
     * inspection between two runs never changes a recorded day's digest.
     * The sibling fields stay on the outcome as non-digested diagnostics.
     * This is a new digest format (allowed because no live shadow day has
     * been recorded yet).
     */
    if (outcome.s2 !== undefined) {
      return JSON.stringify(base);
    }
    if (outcome.s3 !== undefined) {
      return JSON.stringify(base);
    }
    if (outcome.s10 !== undefined) {
      return JSON.stringify(base);
    }
    if (outcome.s11 !== undefined) {
      return JSON.stringify(base);
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
   * any refusal or unknown outcome. The `compareAndSet` itself is the one
   * call exempt from `call`'s post-await deadline re-check: a write that
   * LANDED past the deadline is already durable, so its actual result
   * (saved, conflict, refusal) is reported as-is — a post-deadline
   * `deadline-exceeded` here would claim nothing was written. The deadline
   * is still checked before the write is sent.
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
      // The pre-write deadline check stands: past the deadline, nothing is
      // sent. But the write itself is exempt from `call`'s post-await
      // re-check — once `compareAndSet` returns, the write has LANDED (or
      // been refused) durably, and reporting its actual result is the only
      // answer consistent with the header's no-write-on-unknown guarantee.
      if (this.deadlineReached(context.deadlineIso)) {
        throw new DeadlineReachedError();
      }
      let saved: { readonly kind: 'value'; readonly value: ShadowLedgerCasResult } | { readonly kind: 'threw' };
      try {
        saved = {
          kind: 'value',
          value: await this.deps.evidence.compareAndSet({
            expectedRevision: current === null ? 0 : current.revision,
            next: written.ledger,
            deadlineIso: context.deadlineIso,
          }),
        };
      } catch {
        saved = { kind: 'threw' };
      }
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
