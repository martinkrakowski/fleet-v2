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
// ManageCutoverUseCase uses; no path or raw input value is ever echoed. The
// one deliberate exception is S5''s bounded `unresolvedIds` (PR ids with
// 12-hex head prefixes, capped by `SHADOW_CARRY_MAX_UNRESOLVED_IDS`, sorted):
// per the 2026-11-18 owner decision the ids of the carry decisions the
// resolver left `unknown` are echoed on `RecordShadowDayResult` as
// non-digested diagnostics so the CLI output shows what S5' could not
// compare.

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { type DaemonEventRecord } from '../../domain/daemon-events.js';
import { CUTOVER_SHADOW_CRITERIA, type CutoverShadowCriterion } from '../../domain/cutover-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { isMergeQueueEntryLive, type MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { head12Of, parseLaneRunKey } from '../../domain/lane-run-keys.js';
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
  SHADOW_MAX_HEALTH_ITEMS,
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

/**
 * OD7a2: the scheduled-mode first-tick grace. In scheduled mode the day's
 * earliest in-day `job` event must fall at or before `00:15:00.000Z` —
 * the `fleet-v2-daemon.timer` fires every minute from `00:00Z`, so a day
 * whose first `job` tick lands later than this was not ticked for the whole
 * day (an arming day, or a day the daemon was down for its start).
 */
export const SHADOW_FIRST_TICK_GRACE_MS = 900_000;

/**
 * OD7a2: cap on the own keys read from one grant-coverage record or its
 * nested `shadowImportGrant` object; the pure evaluator's cost is O(1),
 * bounded by this and `SHADOW_GRANT_MAX_STRING_LENGTH`.
 */
export const SHADOW_GRANT_MAX_RECORD_KEYS = 24;
/** OD7a2: cap on one grant-coverage string's length before parsing. */
export const SHADOW_GRANT_MAX_STRING_LENGTH = 256;

/** The own keys a grant-coverage record never carries (prototype pollution). */
const SHADOW_GRANT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** The typed verdict of the pure grant-coverage evaluation (OD7a2). */
export type ShadowGrantCoverageEvaluation =
  | { readonly outcome: 'covered' }
  | { readonly outcome: 'not-covering'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string };

/**
 * OD7a2, pure: whether one stored `merge:import-shadow` grant covered the
 * whole UTC day `[dayStartIso, dayEndIso)`. Hostile-input-safe by contract:
 * `record` is read through own data-property descriptors only — a getter or
 * a Proxy `get` trap never runs — and `null`, primitives, arrays, sparse
 * arrays, array-likes and prototype-polluting own keys are refused as
 * `unavailable`. Cost: O(1), bounded by `SHADOW_GRANT_MAX_RECORD_KEYS` own
 * keys per object and `SHADOW_GRANT_MAX_STRING_LENGTH` code units per string,
 * each read once; never throws and never echoes an input value (`reason` is
 * always a named code).
 *
 * The coverage rules (fail closed):
 * - Approval: `state === 'approved'` with a non-null `decisionRevision` and a
 *   parseable `updatedAtIso` at or before `dayStartIso`. `updatedAtIso` is the
 *   strongest approval-time evidence on `main` and is stamped at or after the
 *   true approval, so an approval recorded after `00:00Z` cannot prove the
 *   grant covered the day's start. Any other state — `cancelled`, `declined`,
 *   `expired`, `pending` — proves nothing and is `not-covering`.
 * - Expiry: the nested `shadowImportGrant.expiresAtIso` must parse and be
 *   strictly after `dayEndIso`.
 * Every missing or unparseable input is `unavailable`, never a pass.
 */
export function evaluateShadowGrantCoverage(
  record: unknown,
  dayStartIso: string,
  dayEndIso: string,
): ShadowGrantCoverageEvaluation {
  try {
    return judgeShadowGrantCoverage(record, dayStartIso, dayEndIso);
  } catch {
    // A revoked Proxy can make even descriptor reads throw; the never-throws
    // contract turns that into a typed refusal.
    return { outcome: 'unavailable', reason: 'invalid-input' };
  }
}

function judgeShadowGrantCoverage(
  record: unknown,
  dayStartIso: string,
  dayEndIso: string,
): ShadowGrantCoverageEvaluation {
  const dayStartMs = parseBoundedIsoMs(dayStartIso);
  const dayEndMs = parseBoundedIsoMs(dayEndIso);
  if (dayStartMs === null || dayEndMs === null) {
    return { outcome: 'unavailable', reason: 'invalid-day-window' };
  }
  const snapshot = readPlainDataSnapshot(record);
  if (snapshot === null) {
    return { outcome: 'unavailable', reason: 'invalid-record' };
  }
  const state = readBoundedDataString(snapshot['state']);
  if (state === null) {
    return { outcome: 'unavailable', reason: 'invalid-state' };
  }
  if (state !== 'approved') {
    // Any non-approved state (including `cancelled` — a revocation overwrites
    // `updatedAtIso`, so it can never prove coverage) fails closed.
    return { outcome: 'not-covering', reason: 'grant-not-approved' };
  }
  const decisionRevision = snapshot['decisionRevision'];
  if (decisionRevision === null) {
    return { outcome: 'not-covering', reason: 'decision-revision-missing' };
  }
  if (readBoundedDataString(decisionRevision) === null) {
    return { outcome: 'unavailable', reason: 'invalid-decision-revision' };
  }
  const updatedAtMs = parseBoundedIsoMs(readBoundedDataString(snapshot['updatedAtIso']));
  if (updatedAtMs === null) {
    return { outcome: 'unavailable', reason: 'updated-at-unparseable' };
  }
  if (updatedAtMs > dayStartMs) {
    return { outcome: 'not-covering', reason: 'approved-after-day-start' };
  }
  const grant = readPlainDataSnapshot(snapshot['shadowImportGrant']);
  if (grant === null) {
    return { outcome: 'unavailable', reason: 'shadow-grant-missing' };
  }
  const expiresAtMs = parseBoundedIsoMs(readBoundedDataString(grant['expiresAtIso']));
  if (expiresAtMs === null) {
    return { outcome: 'unavailable', reason: 'expires-at-unparseable' };
  }
  if (expiresAtMs <= dayEndMs) {
    return { outcome: 'not-covering', reason: 'expires-at-or-before-day-end' };
  }
  return { outcome: 'covered' };
}

/**
 * A plain-data snapshot of `input`: null, primitives, functions, arrays and
 * objects with more than `SHADOW_GRANT_MAX_RECORD_KEYS` own keys are refused,
 * prototype-polluting own keys are refused, and every own property is read
 * through its descriptor (accessors are refused, so no getter and no Proxy
 * `get` trap ever runs). The snapshot is a null-prototype record of the
 * descriptor values.
 */
function readPlainDataSnapshot(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  // OD7a2 fix round: only PLAIN objects are accepted — the prototype must be
  // `Object.prototype` or `null`. Any other prototype (a crafted
  // `Object.create(proto)` carrying valid own fields, a class instance) is
  // refused as `unavailable` with a named reason by the caller.
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  // Enumerating every own key before the cap below is the documented JS
  // residual #4v; the refusal happens before any value is read.
  // OD7a2 fix round: `Reflect.ownKeys` (not `Object.keys`) so that
  // non-enumerable own keys and symbol keys are also seen — a
  // non-enumerable `constructor` or `__proto__` must be refused, and any
  // own key outside the allowed set (non-string, symbol, or one of
  // `SHADOW_GRANT_PROTOTYPE_KEYS`) is refused outright.
  const names = Reflect.ownKeys(input);
  if (names.length > SHADOW_GRANT_MAX_RECORD_KEYS) {
    return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    if (typeof name !== 'string') {
      return null;
    }
    if (SHADOW_GRANT_PROTOTYPE_KEYS.has(name)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    snapshot[name] = descriptor.value;
  }
  return snapshot;
}

/** A bounded plain string value, or null (wrong type or overlong). */
function readBoundedDataString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > SHADOW_GRANT_MAX_STRING_LENGTH) {
    return null;
  }
  return value;
}

/** A bounded string parsed as an ISO instant, or null. */
function parseBoundedIsoMs(value: unknown): number | null {
  const text = readBoundedDataString(value);
  if (text === null) {
    return null;
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** A skipped result: a scheduled-mode guard held, nothing was written. */
function skippedResult(
  reason:
    | 'partial-day'
    | 'too-few-ticks'
    | 'grant-unavailable'
    | 'grant-not-covering-day'
    | 'late-last-tick'
    | 'coverage-gap',
): RecordShadowDayResult {
  return { outcome: 'skipped', reason };
}

/**
 * SH24b: the `would-*` actions whose journaled `dry-run` result — with
 * `reasonCode` equal to the action itself — makes the keyed queue entry stop
 * being shadow-effectively live for S1/S8. Under `policy.shadow === true`
 * (Owner Decision A+, 2026-11-18) these are the only shadow mutations: a
 * journaled `would-drop`, `would-supersede` or `would-already-merged` means
 * the entry left the shadow-effective live set even though it stays
 * unmutated in `merge-queue.json`. `would-park` is deliberately absent (an
 * ordinary park stays live, exactly as on main), and a `dry-run` result with
 * `reasonCode: 'shadow-intent-closed'` on one of these keys is a closed
 * interrupted intent, never an executed one, so it never excludes.
 */
const SHADOW_TERMINAL_WOULD_ACTIONS: readonly string[] = ['would-drop', 'would-supersede', 'would-already-merged'];

/**
 * SH24b: a `would-merge`/`would-supersede` result's `linkedId` — the full
 * lowercase 40-hex head oid a superseded entry's unpersisted in-memory
 * successor resolves against.
 */
const LINKED_HEAD_OID_PATTERN = /^[0-9a-f]{40}$/;

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
  /**
   * OD7a2: the standing `merge:import-shadow` grant's day-coverage reader,
   * used only in scheduled mode (`--scheduled`). It resolves the grant named
   * by the installation's `daemon.shadow.grantId` through the existing
   * authorization path, fetches the stored request record and evaluates it
   * with the pure `evaluateShadowGrantCoverage`. Optional until composition
   * wires it; in scheduled mode an absent reader is `grant-unavailable`
   * (fail closed), never a pass.
   */
  readonly shadowGrantCoverage?: (input: {
    readonly day: string;
    readonly repository: { readonly owner: string; readonly repo: string };
  }) => Promise<
    | { readonly outcome: 'covered' }
    | { readonly outcome: 'not-covering'; readonly reason?: string }
    | { readonly outcome: 'unavailable'; readonly reason?: string }
  >;
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

/**
 * SH24b: shadow-effective liveness of one merge-queue entry against the
 * day's journal prefix read. An entry is shadow-effectively live iff
 * `isMergeQueueEntryLive` holds AND `journalEntries` has no `result`
 * (`outcome: 'dry-run'`) on the entry's own
 * `merge/<repoDigest>/<pr>/<head12>/<action>` key for a shadow-terminal
 * action (`would-drop`, `would-supersede`, `would-already-merged`) whose
 * `reasonCode === action`. A `dry-run` result with
 * `reasonCode: 'shadow-intent-closed'` on such a key never excludes (the
 * interrupted intent was closed, not executed), and ordinary parked entries
 * stay live.
 *
 * The exclusion is bound to THIS queue entry, not to the key alone: the
 * record only excludes when BOTH timestamps parse and its own
 * `recordedAtIso` is STRICTLY after the entry's `enqueuedAtIso` (both fields
 * the entry and the journal reliably carry). An equal timestamp cannot
 * establish which incarnation of the key the result belongs to, so it leaves
 * the entry LIVE: a would-terminal record that predates the entry's enqueue,
 * or one recorded at exactly the entry's enqueue time, belongs to an earlier
 * incarnation of the same key and a later re-enqueue at the same head is
 * LIVE again. A `runId` binds nothing and is never used as identity here: a
 * re-enqueue can carry the same `runId`, so it cannot tie a result to an
 * entry. When either timestamp is missing or unparseable the record cannot
 * be bound to the entry, so the entry stays live — staying live can only
 * cost a divergence, never a false pass.
 * Cost: linear in the journal entries; the entry's own fields are plain
 * reads.
 */
function isShadowEffectivelyLive(
  entry: Pick<MergeQueueEntryRecord, 'repoDigest' | 'pullRequest' | 'headOid' | 'state' | 'enqueuedAtIso'>,
  journalEntries: readonly LaneRunJournalEntryRecord[],
): boolean {
  if (!isMergeQueueEntryLive(entry)) {
    return false;
  }
  const head12 = head12Of(entry.headOid);
  if (head12 === null) {
    return true;
  }
  const enqueuedMs = Date.parse(entry.enqueuedAtIso);
  for (const record of journalEntries) {
    if (record.kind !== 'result' || record.outcome !== 'dry-run') {
      continue;
    }
    const parsed = parseLaneRunKey(record.key);
    if (
      parsed !== null
      && parsed.kind === 'merge'
      && parsed.repoDigest === entry.repoDigest
      && parsed.pullRequest === entry.pullRequest
      && parsed.head12 === head12
      && SHADOW_TERMINAL_WOULD_ACTIONS.includes(parsed.action)
      && record.reasonCode === parsed.action
    ) {
      // A terminal result excludes the entry ONLY when both timestamps parse
      // and the result was recorded strictly after the enqueue. An
      // unparseable timestamp (either side) cannot bind the record to the
      // entry, so the entry stays LIVE — fail-closed. An equal timestamp is
      // ambiguous in the same way. A `runId` binds nothing: a re-enqueue can
      // carry the same `runId`, so it is never used as identity here.
      const recordedMs = Date.parse(record.recordedAtIso);
      if (Number.isNaN(enqueuedMs) || Number.isNaN(recordedMs)) {
        continue;
      }
      if (recordedMs > enqueuedMs) {
        return false;
      }
    }
  }
  return true;
}

/**
 * SH24b: the heads the journaled supersessions and in-memory merges name.
 * Every journaled `dry-run` result on a `merge-pr` or `would-supersede`
 * merge key with reason `would-merge` or `would-supersede` whose `linkedId`
 * is a valid 40-hex head oid matching the key's own head12 contributes
 * `{ pullRequest, headOid: linkedId }` — the 40-hex head a superseded
 * entry's unpersisted in-memory successor resolves against, so S1 never
 * reports `fleet-head-unresolved` for it. Deduplicated by
 * `${pullRequest}:${headOid}`. Cost: linear in the journal entries.
 */
function shadowLinkedHeads(
  journalEntries: readonly LaneRunJournalEntryRecord[],
): readonly { readonly pullRequest: number; readonly headOid: string }[] {
  const heads: { pullRequest: number; headOid: string }[] = [];
  const seen = new Set<string>();
  for (const record of journalEntries) {
    if (record.kind !== 'result' || record.outcome !== 'dry-run') {
      continue;
    }
    if (record.reasonCode !== 'would-merge' && record.reasonCode !== 'would-supersede') {
      continue;
    }
    const parsed = parseLaneRunKey(record.key);
    if (
      parsed === null
      || parsed.kind !== 'merge'
      // `would-supersede` stays accepted here even though SH24a currently
      // writes no `linkedId` on a `would-supersede` result (so the branch
      // is dead in production today): the S1 contract this helper serves
      // names `would-supersede` results as a legitimate `linkedId` source,
      // so a writer that starts carrying one must be honoured, not dropped.
      || (parsed.action !== 'merge-pr' && parsed.action !== 'would-supersede')
    ) {
      continue;
    }
    const linkedId = record.linkedId;
    if (typeof linkedId !== 'string' || !LINKED_HEAD_OID_PATTERN.test(linkedId) || head12Of(linkedId) !== parsed.head12) {
      continue;
    }
    const identity = `${parsed.pullRequest}:${linkedId}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    heads.push({ pullRequest: parsed.pullRequest, headOid: linkedId });
  }
  return heads;
}

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
  /**
   * Present only when S5' was evaluated: its non-digested unresolved
   * diagnostics, carried onto `RecordShadowDayResult` for CLI observability.
   */
  readonly premergeCarry?: {
    readonly unresolvedCount: number;
    readonly unresolvedIds: readonly string[];
  };
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

/** A frozen plain-object copy of one daemon event's fields (see `snapshotEvent`). */
type DaemonEventSnapshot = { readonly kind: string; readonly recordedAtIso: string } & { readonly [field: string]: unknown };

/**
 * OD7a2 fix round: the ONE validator and snapshotter for the raw daemon
 * events handed back by `readAfterCursor`. Every own key is read exactly
 * once, from its own data descriptor's `value` (which never runs a getter),
 * and copied into a NEW frozen plain object with the same key set; nothing
 * is read a second time through the original, so a Proxy whose descriptors
 * and `get` trap disagree can only yield the descriptor's values. The event
 * is malformed — `null` — only when it is not a non-null object or when the
 * descriptor-read of `kind`/`recordedAtIso` did not yield a string; a
 * descriptor read that throws or reports an accessor carries `undefined`
 * for that key (which `evaluateShadowTickHealth` later rejects), so the
 * domain evaluator stays the ONE full-record validator and the verdicts are
 * unchanged. Cost is O(1) per event (linear in the event's capped key set —
 * a fixed 10-field projection record).
 */
function snapshotEvent(event: unknown): DaemonEventSnapshot | null {
  try {
    if (typeof event !== 'object' || event === null) {
      return null;
    }
    const snapshot = {} as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(event as object)) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(event as object, key);
      } catch {
        descriptor = undefined;
      }
      // The key set mirrors the original (even for a read that failed), so
      // the domain evaluator sees exactly the keys it would have seen; the
      // carried value is whatever the one descriptor read returned.
      Object.defineProperty(snapshot, key, {
        value: descriptor === undefined ? undefined : descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    if (typeof snapshot.kind !== 'string' || typeof snapshot.recordedAtIso !== 'string') {
      return null;
    }
    return Object.freeze(snapshot) as DaemonEventSnapshot;
  } catch {
    return null;
  }
}

/**
 * OD7a3: the validated own length of a dense, non-Proxy array of
 * non-negative safe integers, or null. Reads only the `length` own
 * descriptor and `Object.keys` (no element values), so no getter and no
 * Proxy `get` trap ever runs; an oversized, sparse or accessor-carrying
 * array is refused from its length alone, before any element is touched.
 * Cost is linear in the array's capped length (at most
 * `SHADOW_MAX_HEALTH_ITEMS` keys are walked).
 */
function readNonNegativeSafeIntegerOwnArray(value: unknown): number | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value > SHADOW_MAX_HEALTH_ITEMS
  ) {
    return null;
  }
  if (Object.keys(value).length !== lengthDescriptor.value) {
    return null;
  }
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const element = ownDataProperty(value as object, String(index));
    if (typeof element !== 'number' || !Number.isSafeInteger(element) || element < 0) {
      return null;
    }
  }
  return lengthDescriptor.value;
}

/**
 * OD7a3: whether any dropped (corrupt) `events.jsonl` line is bracketed
 * inside `day`'s parsed records. Policy: `events.jsonl` holds the whole
 * history, so a dropped line counts against a day ONLY when its file
 * position lies between the first and the last successfully parsed record
 * whose time is inside that day; a corrupt line outside every day's bracket
 * affects no day. Every own key is read through its descriptor (no getter
 * ever runs); a missing `droppedLines` field is treated as `[]` for
 * backwards compatibility; a malformed shape, a sparse/oversized array, or
 * a non-empty `droppedLines` whose `eventPositions` is missing or not a
 * same-length non-negative-integer array matching `events.length` fails
 * closed. Cost is linear in the capped `events` array.
 */
function corruptLineBracketedInDay(read: unknown, day: string): boolean {
  try {
    if (typeof read !== 'object' || read === null || Array.isArray(read)) {
      return true;
    }
    const events = ownDataProperty(read, 'events');
    if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
      return true;
    }
    const eventsLengthDescriptor = Object.getOwnPropertyDescriptor(events, 'length');
    if (
      eventsLengthDescriptor === undefined ||
      eventsLengthDescriptor.get !== undefined ||
      typeof eventsLengthDescriptor.value !== 'number' ||
      !Number.isSafeInteger(eventsLengthDescriptor.value) ||
      eventsLengthDescriptor.value > SHADOW_MAX_HEALTH_ITEMS
    ) {
      return true;
    }
    const eventsLength = eventsLengthDescriptor.value;
    const droppedDescriptor = Object.getOwnPropertyDescriptor(read, 'droppedLines');
    // An accessor (or a missing) `droppedLines` is never read through a
    // getter: an accessor fails closed, a missing field is treated as `[]`.
    if (droppedDescriptor === undefined) {
      return false;
    }
    if (droppedDescriptor.get !== undefined || droppedDescriptor.set !== undefined) {
      return true;
    }
    const droppedLines = droppedDescriptor.value;
    if (droppedLines === undefined) {
      return false;
    }
    const droppedLength = readNonNegativeSafeIntegerOwnArray(droppedLines);
    if (droppedLength === null) {
      return true;
    }
    if (droppedLength === 0) {
      return false;
    }
    const eventPositions = ownDataProperty(read, 'eventPositions');
    const positionsLength = readNonNegativeSafeIntegerOwnArray(eventPositions);
    if (positionsLength === null || positionsLength !== eventsLength) {
      return true;
    }
    let firstPos: number | null = null;
    let lastPos: number | null = null;
    for (let index = 0; index < eventsLength; index += 1) {
      const event = ownDataProperty(events as object, String(index));
      if (typeof event !== 'object' || event === null) {
        continue;
      }
      const recordedAtIso = ownDataProperty(event, 'recordedAtIso');
      if (typeof recordedAtIso !== 'string' || recordedAtIso.slice(0, 10) !== day) {
        continue;
      }
      const position = ownDataProperty(eventPositions as object, String(index));
      if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
        return true;
      }
      if (firstPos === null || position < firstPos) {
        firstPos = position;
      }
      if (lastPos === null || position > lastPos) {
        lastPos = position;
      }
    }
    // No in-day parsed record: no bracket, so no dropped line affects the day.
    if (firstPos === null || lastPos === null) {
      return false;
    }
    for (let index = 0; index < droppedLength; index += 1) {
      const position = ownDataProperty(droppedLines as object, String(index));
      if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
        return true;
      }
      if (position >= firstPos && position <= lastPos) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * OD7a3: a manual-mode S12 guard that aborts the whole run with a typed
 * result (a refusal or an unknown), writing nothing to the ledger. Thrown
 * from `evaluateTickHealthCriterion` and caught in `run`.
 */
class S12GuardResult extends Error {
  constructor(readonly result: RecordShadowDayResult) {
    super('s12-guard');
  }
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
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length !== paths.length) {
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

function unknownResult(
  reason:
    | 'ledger-unreadable'
    | 'ledger-unknown-version'
    | 'ledger-busy'
    | 'deadline-exceeded'
    | 'daemon-events-corrupt',
): RecordShadowDayResult {
  return { outcome: 'unknown', reason };
}

function refusedResult(
  reason:
    | 'invalid-request'
    | 'too-early'
    | 'too-old'
    | 'day-out-of-order'
    | 'verdict-conflict'
    | 'release-conflict'
    | 'merges-conflict'
    | 'late-last-tick'
    | 'coverage-gap',
): RecordShadowDayResult {
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

/**
 * OD7a2 fix round: the request is SNAPSHOT ONCE at entry. Each field is read
 * exactly once through its own data-property descriptor
 * (`Object.getOwnPropertyDescriptor` never runs a getter and, on a plain
 * record, never a Proxy `get` trap), an accessor property is refused, and a
 * non-plain prototype (or a non-object, or a throwing Proxy descriptor trap)
 * is refused. `resolveDay` and every later use receive the snapshot — never
 * the raw request — so a `scheduled` getter that flips between reads cannot
 * pass validation and then skip the scheduled guards. Cost is O(1): a fixed
 * five-field list, one prototype check, five own-descriptor reads.
 */
function snapshotRequest(request: unknown): RecordShadowDayRequest | null {
  try {
    if (!isPlainRecordObject(request)) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of ['repository', 'legacyStateDir', 'day', 'deadlineIso', 'scheduled']) {
      const descriptor = Object.getOwnPropertyDescriptor(request, key);
      if (descriptor === undefined) {
        continue;
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot as unknown as RecordShadowDayRequest;
  } catch {
    return null;
  }
}

/**
 * OD7a2: the scheduled flag read at the boundary, from the entry snapshot (a
 * plain record of data properties, so this read is stable across repeats).
 * A hostile value is `'invalid'` (fail closed), and only `undefined`
 * (manual mode) or a real boolean is accepted.
 */
function readScheduledFlag(request: RecordShadowDayRequest): boolean | 'invalid' {
  const value = ownDataProperty(request as unknown as object, 'scheduled');
  if (value === undefined) {
    return false;
  }
  return typeof value === 'boolean' ? value : 'invalid';
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

  private async run(rawRequest: RecordShadowDayRequest): Promise<RecordShadowDayResult> {
    // OD7a2 fix round: the request is read once, at entry, into a plain
    // snapshot; the raw request is never touched again.
    const request = snapshotRequest(rawRequest);
    if (request === null) {
      return refusedResult('invalid-request');
    }
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
    // OD7a2: in scheduled mode every guard runs BEFORE the ledger/shell reads
    // and before any other criterion, and a held guard writes nothing.
    // OD7a2 fix round: a backstop wraps the whole scheduled evaluation path —
    // any unexpected exception fails closed as `unknown` and writes nothing.
    // Deadline handling is untouched: a reached deadline keeps aborting the
    // run with `deadline-exceeded`.
    let scheduled: {
      readonly stop: RecordShadowDayResult | null;
      readonly tickHealth?: CriterionOutcome;
    } | null = null;
    if (readScheduledFlag(request) === true) {
      try {
        scheduled = await this.runScheduledPrechecks(context);
      } catch (error) {
        if (error instanceof DeadlineReachedError) {
          throw error;
        }
        return { outcome: 'unknown', reason: 'scheduled-evaluation-failed' };
      }
    }
    if (scheduled !== null && scheduled.stop !== null) {
      return scheduled.stop;
    }
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
    const intake = await this.evaluateIntakeCriterion(context, journal);
    // OD7a3: the S12 outcome is evaluated (or reused from the scheduled
    // prechecks) OUTSIDE the outcomes literal, because the manual-mode guard
    // in `evaluateTickHealthCriterion` can abort the whole run — a bracketed
    // corrupt line is `unknown/daemon-events-corrupt`, and a coverage
    // failure (`late-last-tick` / `coverage-gap`) is a refusal — each
    // writing nothing.
    let s12Outcome: CriterionOutcome;
    if (scheduled !== null && scheduled.tickHealth !== undefined) {
      s12Outcome = scheduled.tickHealth;
    } else {
      try {
        s12Outcome = await this.evaluateTickHealthCriterion(context);
      } catch (error) {
        if (error instanceof S12GuardResult) {
          return error.result;
        }
        throw error;
      }
    }
    const outcomes = [
      mergeSet,
      intake.outcome,
      await this.evaluateStateIntegrityCriterion(context, journal),
      // OD7a2: in scheduled mode the already-evaluated S12 outcome is reused
      // rather than re-reading the daemon events.
      s12Outcome,
      await this.evaluateGateAgreementCriterion(context),
      await this.evaluateConformanceCriterion(context, shellFacts),
      await this.evaluateChainsRetiredCriterion(context, intake.chains),
      await this.evaluatePremergeCarryCriterion(context, shellFacts),
      ...(await this.evaluateOneTimeCriteria(context, releaseSha)),
    ];
    const built = this.buildVerdicts(context, outcomes);
    return this.writeDay(context, ledger.ledger, releaseSha, built);
  }

  /**
   * OD7a2, scheduled mode: the fail-closed prechecks that run before anything
   * is written. A held guard returns the typed `stop` result (nothing has
   * been written at that point); otherwise the already-evaluated S12 outcome
   * is carried out so `run` never reads the daemon events twice.
   */
  private async runScheduledPrechecks(
    context: DayContext,
  ): Promise<{
    readonly stop: RecordShadowDayResult | null;
    readonly tickHealth?: CriterionOutcome;
  }> {
    // 1. Grant-coverage guard: the standing grant must cover the whole day.
    const coverage = this.deps.shadowGrantCoverage;
    if (coverage === undefined) {
      return { stop: skippedResult('grant-unavailable') };
    }
    // OD7a2 fix round: allow-list check — recording may proceed ONLY when the
    // coverage result is exactly `{ outcome: 'covered' }`. Every other value
    // (`not-covering`, `unavailable`, `unknown`, an unrecognized outcome, a
    // malformed object) or a thrown error fails closed and writes nothing.
    const grant = await this.call(context.deadlineIso, () =>
      coverage({ day: context.day, repository: context.repository }),
    );
    const grantOutcome = grant.kind === 'threw' ? undefined : grant.value?.outcome;
    if (grantOutcome !== 'covered') {
      return {
        stop: skippedResult(
          grantOutcome === 'not-covering' ? 'grant-not-covering-day' : 'grant-unavailable',
        ),
      };
    }
    // 2. Events read and first-tick `job` guard: only `job` events count, and
    // the earliest in-day one must fall within the first-tick grace window.
    const read = await this.call(context.deadlineIso, () => this.deps.daemonEvents.readAfterCursor(null));
    if (read.kind === 'threw' || !read.value.ok) {
      return { stop: { outcome: 'unknown', reason: 'daemon-events-unavailable' } };
    }
    // OD7a3: a dropped line bracketed inside the day's parsed records makes
    // the day unknown before anything is evaluated or written.
    if (corruptLineBracketedInDay(read.value, context.day)) {
      return { stop: { outcome: 'unknown', reason: 'daemon-events-corrupt' } };
    }
    // OD7a2 fix round: the raw events are validated and snapshotted exactly
    // ONCE, here, by `snapshotEvent`; every later loop and filter below uses
    // the snapshot array only and may dereference `kind`/`recordedAtIso`
    // directly, never the original (which a Proxy could make disagree).
    // OD7a2 fix round: a malformed event FAILS CLOSED. Dropping it silently
    // would let S12 evaluate a shortened list (800 good ticks plus one null
    // could pass), so any event whose snapshot is null stops the run as
    // `s12-unknown` before anything is written.
    const validatedEvents: DaemonEventSnapshot[] = [];
    for (const event of read.value.events) {
      const snapshot = snapshotEvent(event);
      if (snapshot === null) {
        return { stop: { outcome: 'unknown', reason: 's12-unknown' } };
      }
      validatedEvents.push(snapshot);
    }
    const dayStartMs = serialOfUtcDay(context.day) * DAY_MS;
    let earliestInDayMs: number | null = null;
    for (const event of validatedEvents) {
      if (event.kind !== 'job') {
        continue;
      }
      const recordedAtIso = event.recordedAtIso;
      if (recordedAtIso.slice(0, 10) !== context.day) {
        continue;
      }
      const instant = Date.parse(recordedAtIso);
      if (Number.isNaN(instant)) {
        continue;
      }
      if (earliestInDayMs === null || instant < earliestInDayMs) {
        earliestInDayMs = instant;
      }
    }
    if (earliestInDayMs === null || earliestInDayMs > dayStartMs + SHADOW_FIRST_TICK_GRACE_MS) {
      return { stop: skippedResult('partial-day') };
    }
    // 3. S12 precheck over the windowed events: an unknown evaluation and a
    // `too-few-ticks` / `late-last-tick` / `coverage-gap` failure each stop
    // the run before anything is written (OD7a3 adds the coverage guards).
    const windowed = validatedEvents.filter((event: DaemonEventSnapshot) => this.inTickWindow(event.recordedAtIso, context.day));
    const evaluation = evaluateShadowTickHealth({ day: context.day, events: windowed });
    const tickHealth: CriterionOutcome = { criterion: 'S12', kind: 'evaluated', evaluation, tickHealth: evaluation };
    if (evaluation.status === 'unknown') {
      return { stop: { outcome: 'unknown', reason: 's12-unknown' }, tickHealth };
    }
    if (evaluation.status === 'fail' && (evaluation.reason === 'too-few-ticks' || evaluation.reason === 'late-last-tick' || evaluation.reason === 'coverage-gap')) {
      return { stop: skippedResult(evaluation.reason), tickHealth };
    }
    return { stop: null, tickHealth };
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
    if (readScheduledFlag(request) === 'invalid') {
      return { ok: false, reason: 'invalid-request' };
    }
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

  /**
   * Every shadow-effectively live merge-queue entry for this repository,
   * plus the heads the journaled supersessions and in-memory merges name
   * (SH24b), or the reason S1 is unevaluated.
   */
  private async readLiveEntries(
    context: DayContext,
    journal: JournalRead,
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
    const journalEntries = journal.kind === 'ok' ? journal.entries : [];
    return [
      ...read.value
        .filter((entry) => entry.repoDigest === context.repoDigest)
        .filter((entry) => isShadowEffectivelyLive(entry, journalEntries))
        .map((entry) => ({
          pullRequest: entry.pullRequest,
          headOid: entry.headOid,
        })),
      // SH24b: a superseded entry's unpersisted in-memory successor resolves
      // its 40-hex head from the `would-supersede`/`would-merge` result's
      // `linkedId`, avoiding `fleet-head-unresolved` without changing
      // `shadow-day-merge-set.ts`'s input schema.
      ...shadowLinkedHeads(journalEntries),
    ];
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
    const liveEntries = await this.readLiveEntries(context, journal);
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
    journal: JournalRead,
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
    if (journal.kind === 'unavailable') {
      // SH24b: without the journal prefix read the shadow-terminal
      // exclusions below cannot be evaluated, so the sample is incomplete —
      // S8 reports incomplete/unevaluated and never manufactures a pass or
      // a false divergence off unevaluable evidence.
      complete = false;
    }
    const journalEntries = journal.kind === 'ok' ? journal.entries : [];
    const fleetLive =
      fleetRead.kind === 'threw'
        ? []
        : fleetRead.value
            .filter((entry) => entry.repoDigest === context.repoDigest)
            // SH24b: shadow-effective liveness — entries a journaled
            // `would-drop`, `would-supersede` or `would-already-merged`
            // result named are no longer shadow-effectively live even
            // though they stay unmutated in `merge-queue.json`.
            .filter((entry) => isShadowEffectivelyLive(entry, journalEntries))
            .map((entry) => ({
              pullRequest: entry.pullRequest,
              headOid: entry.headOid,
              base: entry.baseBranch ?? 'main',
            }));
    // Dry-run only, never apply; no grant is exercised for a dry run.
    const importRead = await this.call(context.deadlineIso, () =>
      this.deps.importDryRun.importTrainState({
        repository: context.repository,
        stateDir: context.legacyStateDir,
        apply: false,
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
    journal: JournalRead,
  ): Promise<{ readonly outcome: CriterionOutcome; readonly chains: LegacyTrainChainsRead | undefined }> {
    const nowSerial = Math.floor(Date.parse(this.deps.nowIso()) / DAY_MS);
    if (context.day !== utcDayOfSerial(nowSerial - 1)) {
      return { outcome: unevaluatedOutcome('S8', 'snapshot-only-for-yesterday'), chains: undefined };
    }
    const first = await this.intakeSample(context, journal);
    // A real wall-clock gap, matching SH5c's persistence intent: two
    // independently-moving systems sampled seconds apart can manufacture a
    // divergence that resolves itself immediately after.
    await this.deps.sleep(this.deps.settings.sampleGapMs ?? DEFAULT_SAMPLE_GAP_MS);
    const second = await this.intakeSample(context, journal);
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
    // OD7a3: a dropped line bracketed inside the day's parsed records makes
    // the day unknown — writing nothing. The typed result is carried out of
    // the outcomes evaluation by the `S12GuardResult` sentinel.
    if (corruptLineBracketedInDay(read.value, context.day)) {
      throw new S12GuardResult(unknownResult('daemon-events-corrupt'));
    }
    const events = read.value.events.filter((event: DaemonEventRecord) => this.inTickWindow(event.recordedAtIso, context.day));
    const evaluation = evaluateShadowTickHealth({ day: context.day, events });
    // OD7a3: manual mode refuses the two S12 coverage failures instead of
    // recording a `fail` verdict — nothing is written to the ledger.
    if (evaluation.status === 'fail' && (evaluation.reason === 'late-last-tick' || evaluation.reason === 'coverage-gap')) {
      throw new S12GuardResult(refusedResult(evaluation.reason));
    }
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
   *
   * Owner decision 2026-11-18: a day with zero settled heads — an empty
   * conducted-head set, or every head unsettled or outside the window —
   * records `unevaluated` (`no-settled-heads`), never `pass` and never
   * `fail`. The evaluator returns `unknown/no-settled-heads`, which the
   * `status === 'unknown'` guard below turns into the typed refusal; the
   * `unsettled > 0` guard above keeps `gate-heads-unsettled` first.
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
   * `carry`/`no-carry`, counts as `unknown` — per the 2026-11-18 owner
   * decision the evaluator no longer refuses such a day as
   * `fleet-carry-unknown`; it records the unresolved decisions in its
   * non-digested diagnostics (`unresolvedCount`/`unresolvedIds`) and compares
   * only the resolvable decisions, failing the day on any resolvable lax
   * carry or stricter no-carry. The decisions and anomalies handed to the
   * evaluator are fresh plain objects built from the extracted facts, never
   * caller-supplied structures.
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
   * `readCutoverShadowEvidence` requires all twelve criteria to pass on
   * the required shadow day. The ledger read and the release
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
    const inspectReleaseFiles = oneTime.releaseStore.inspectReleaseFiles?.bind(oneTime.releaseStore);
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
     * S5' hashes `compared` with the base. Per the 2026-11-18 owner decision
     * `compared` counts only the deduped, day-scoped carry decisions the
     * resolver answered (`carry`/`no-carry`), so it is resolver-dependent:
     * deterministic at `0` while the composition pins the resolver to
     * `'unknown'` (S5' then compares nothing and is a constant pass on any
     * day with a complete, paired shell log — owner-accepted), but if a real
     * resolver later answers differently on a rerun the digest changes and
     * `verdict-conflict` refuses that day; earlier recorded days are not
     * comparable to days recorded after this change. A lax carry is missed
     * whenever its decision is unresolved, including on a transient resolver
     * throw — by design. The unresolved decisions stay on
     * `outcome.premergeCarry` (and on `RecordShadowDayResult`) as
     * non-digested diagnostics: `unresolvedCount` and the bounded
     * `unresolvedIds` are never digested, so a rerun whose only difference is
     * which decisions stayed unresolved cannot silently become a verdict
     * conflict. This is a new digest format (allowed because no live shadow
     * day has been recorded yet).
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
    let premergeCarry: BuiltVerdicts['premergeCarry'] = undefined;
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
      // S5''s unresolved diagnostics ride along to the result as non-digested
      // diagnostics (never digested), so `cutover shadow record-day` prints
      // what the day's replay could not compare.
      if (outcome.premergeCarry !== undefined) {
        premergeCarry = {
          unresolvedCount: outcome.premergeCarry.unresolvedCount,
          unresolvedIds: outcome.premergeCarry.unresolvedIds,
        };
      }
    }
    return { verdicts, unevaluated, mergesCompared, ...(premergeCarry === undefined ? {} : { premergeCarry }) };
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
      ...(built.premergeCarry === undefined ? {} : { premergeCarry: built.premergeCarry }),
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
