// The cutover shadow-evidence ledger v1 (plan §3.3): one ledger per
// installation, compare-and-set on its revision, and per UTC day the release
// sha, the merges compared and at most one verdict per criterion S1-S13.
// Pure: no filesystem, no subprocess, no clock. Never throws, never runs an
// accessor, never echoes an input value. Ids, digests and codes only.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { CUTOVER_SHADOW_CRITERIA, type CutoverShadowCriterion } from './cutover-records.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { isPlainRecordObject, readRecordSchemaVersion } from './record-schema-version.js';

export const SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION = 1 as const;

/** The newest 31 days are kept; older days are dropped when the ledger is next written. */
export const SHADOW_EVIDENCE_KEPT_DAYS = 31;

/**
 * A completed UTC day becomes recordable only once this grace after its end
 * has passed: the day's late writes and backfills are then expected to have
 * settled. Anything still inside the grace is refused.
 */
export const SHADOW_DAY_GRACE_MS = 6 * 60 * 60 * 1000;

/** A day older than this many days is refused; the ledger keeps 31, the rule needs 7. */
export const SHADOW_DAY_MAX_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REVISION = 1_000_000_000;
const MAX_MERGES = 1_000_000_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One recorded day-and-criterion verdict; never changed once recorded. */
export interface ShadowDayVerdict {
  readonly verdict: 'pass' | 'fail';
  readonly reasonCode: string;
  /** The digest of the inputs the verdict was decided from. */
  readonly inputDigest: string;
}

/** One recorded UTC day of the shadow period. */
export interface ShadowEvidenceDay {
  /** The release the day's merges were compared against (40-hex oid). */
  readonly releaseSha: string;
  readonly mergesCompared: number;
  readonly verdicts: Readonly<Partial<Record<CutoverShadowCriterion, ShadowDayVerdict>>>;
}

/** The one shadow-evidence ledger v1 of an installation. */
export interface ShadowEvidenceLedger {
  readonly schemaVersion: typeof SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION;
  readonly revision: number;
  /** Keyed by UTC calendar date (`YYYY-MM-DD`). */
  readonly days: Readonly<Record<string, ShadowEvidenceDay>>;
}

export type ShadowEvidenceLedgerRead =
  | { readonly ok: true; readonly ledger: ShadowEvidenceLedger }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'invalid-ledger' };

const INVALID_LEDGER = { ok: false, reason: 'invalid-ledger' } as const;

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function isBoundedReasonCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && REASON_CODE_PATTERN.test(value) && !isSecretShaped(value);
}

function isVerdictWord(value: unknown): value is 'pass' | 'fail' {
  return value === 'pass' || value === 'fail';
}

function isSafeBoundedInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isShadowDayVerdict(value: unknown): value is ShadowDayVerdict {
  if (!isPlainRecordObject(value)) return false;
  const verdict = readOwn(value, 'verdict');
  const reasonCode = readOwn(value, 'reasonCode');
  const inputDigest = readOwn(value, 'inputDigest');
  return (
    isVerdictWord(verdict) &&
    isBoundedReasonCode(reasonCode) &&
    typeof inputDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(inputDigest)
  );
}

/** The value of the own data property `name`, or undefined when it is anything else. */
function readOwn(record: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

function isShadowDayVerdicts(value: unknown): value is ShadowEvidenceDay['verdicts'] {
  if (!isPlainRecordObject(value)) return false;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (entries.some(([, descriptor]) => !descriptor.enumerable || descriptor.get !== undefined)) return false;
  if (entries.length > CUTOVER_SHADOW_CRITERIA.length) return false;
  for (const [key, descriptor] of entries) {
    if (!(CUTOVER_SHADOW_CRITERIA as readonly string[]).includes(key)) return false;
    if (!isShadowDayVerdict(descriptor.value)) return false;
  }
  return true;
}

const DAY_KEYS: readonly string[] = ['releaseSha', 'mergesCompared', 'verdicts'];

function isShadowDay(value: unknown, key: string): value is ShadowEvidenceDay {
  if (!isPlainRecordObject(value) || !isRecordedShadowDay(key)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== DAY_KEYS.length || ownKeys.some((own) => !DAY_KEYS.includes(own as string))) {
    return false;
  }
  const releaseSha = readOwn(value, 'releaseSha');
  const mergesCompared = readOwn(value, 'mergesCompared');
  return (
    typeof releaseSha === 'string' &&
    isMergeHex40(releaseSha) &&
    isSafeBoundedInt(mergesCompared, MAX_MERGES) &&
    isShadowDayVerdicts(readOwn(value, 'verdicts'))
  );
}

/** True when `key` is a real UTC calendar date (`YYYY-MM-DD`, never `02-30`). */
export function isRecordedShadowDay(key: string): boolean {
  if (!DAY_PATTERN.test(key)) return false;
  const parsed = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === key;
}

/** The typed ledger behind raw input, or the reason it is not one. */
export function readShadowEvidenceLedger(raw: unknown): ShadowEvidenceLedgerRead {
  const version = readRecordSchemaVersion(raw, SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION);
  if (!version.ok) {
    return { ok: false, reason: version.reason === 'unknown-schema-version' ? 'unknown-version' : 'invalid-ledger' };
  }
  if (!isPlainRecordObject(raw)) return INVALID_LEDGER;
  const revision = readOwn(raw, 'revision');
  const days = readOwn(raw, 'days');
  if (!isSafeBoundedInt(revision, MAX_REVISION) || !isPlainRecordObject(days)) return INVALID_LEDGER;
  const dayDescriptors = Object.entries(Object.getOwnPropertyDescriptors(days));
  if (dayDescriptors.some(([, descriptor]) => !descriptor.enumerable || descriptor.get !== undefined)) {
    return INVALID_LEDGER;
  }
  const typedDays: Record<string, ShadowEvidenceDay> = {};
  for (const [key, descriptor] of dayDescriptors) {
    if (!isShadowDay(descriptor.value, key)) return INVALID_LEDGER;
    typedDays[key] = descriptor.value;
  }
  return {
    ok: true,
    ledger: { schemaVersion: SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION, revision, days: typedDays },
  };
}

/** The ledger an absent store starts from. */
export function emptyShadowEvidenceLedger(): ShadowEvidenceLedger {
  return { schemaVersion: SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION, revision: 0, days: {} };
}

export type ShadowDayWindowClass =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-day' | 'future-day' | 'current-day' | 'grace-period' | 'day-too-old' };

/**
 * The day rules of the shadow-day recorder, decided against one clock
 * reading: the day must be a real UTC calendar date, strictly in the past,
 * past its grace period, and no older than seven days.
 */
export function classifyShadowDayWindow(day: string, nowMs: number): ShadowDayWindowClass {
  if (!isRecordedShadowDay(day) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'invalid-day' };
  }
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  const dayEndMs = dayStartMs + DAY_MS;
  if (nowMs < dayStartMs) return { ok: false, reason: 'future-day' };
  if (nowMs < dayEndMs) return { ok: false, reason: 'current-day' };
  if (nowMs < dayEndMs + SHADOW_DAY_GRACE_MS) return { ok: false, reason: 'grace-period' };
  if (nowMs >= dayEndMs + SHADOW_DAY_MAX_AGE_DAYS * DAY_MS) return { ok: false, reason: 'day-too-old' };
  return { ok: true };
}

export interface MergeShadowDayInput {
  readonly day: string;
  readonly releaseSha: string;
  readonly mergesCompared: number;
  /** The definite verdicts this evaluation reached; unevaluated criteria are absent. */
  readonly verdicts: Readonly<Partial<Record<CutoverShadowCriterion, ShadowDayVerdict>>>;
}

export type ShadowDayMerge =
  | {
      readonly ok: true;
      /** The merged ledger; the same object when nothing changed (an identical repeat). */
      readonly ledger: ShadowEvidenceLedger;
      readonly identicalRepeat: boolean;
    }
  | { readonly ok: false; readonly reason: 'day-criterion-conflict' };

/**
 * Merge one day's verdicts into the ledger under the recorded-verdict rule: a
 * verdict already recorded is kept unchanged — an identical repeat is a
 * no-op, and any other verdict, or a changed release sha or merge count, is a
 * `day-criterion-conflict`. Unevaluated criteria are recorded nowhere. The
 * merged ledger keeps only the newest `SHADOW_EVIDENCE_KEPT_DAYS` days.
 */
export function mergeShadowDay(ledger: ShadowEvidenceLedger, input: MergeShadowDayInput): ShadowDayMerge {
  const existing = ledger.days[input.day];
  const nextVerdicts: Record<string, ShadowDayVerdict> = {};
  let changed = existing === undefined;

  if (existing !== undefined) {
    if (existing.releaseSha !== input.releaseSha || existing.mergesCompared !== input.mergesCompared) {
      return { ok: false, reason: 'day-criterion-conflict' };
    }
    for (const [criterion, verdict] of Object.entries(existing.verdicts)) {
      nextVerdicts[criterion] = verdict;
    }
  }

  for (const [criterion, verdict] of Object.entries(input.verdicts)) {
    const recorded = existing?.verdicts[criterion as CutoverShadowCriterion];
    if (recorded !== undefined) {
      if (
        recorded.verdict !== verdict.verdict ||
        recorded.reasonCode !== verdict.reasonCode ||
        recorded.inputDigest !== verdict.inputDigest
      ) {
        return { ok: false, reason: 'day-criterion-conflict' };
      }
      continue;
    }
    nextVerdicts[criterion] = verdict;
    changed = true;
  }

  if (!changed) {
    return { ok: true, ledger, identicalRepeat: true };
  }

  const days: Record<string, ShadowEvidenceDay> = { ...ledger.days };
  days[input.day] = {
    releaseSha: input.releaseSha,
    mergesCompared: input.mergesCompared,
    verdicts: nextVerdicts,
  };
  return {
    ok: true,
    ledger: trimShadowEvidenceLedger({ ...ledger, revision: ledger.revision + 1, days }),
    identicalRepeat: false,
  };
}

/** The ledger with only its newest `SHADOW_EVIDENCE_KEPT_DAYS` days. */
export function trimShadowEvidenceLedger(ledger: ShadowEvidenceLedger): ShadowEvidenceLedger {
  const keys = Object.keys(ledger.days).sort();
  if (keys.length <= SHADOW_EVIDENCE_KEPT_DAYS) return ledger;
  const days: Record<string, ShadowEvidenceDay> = {};
  for (const key of keys.slice(keys.length - SHADOW_EVIDENCE_KEPT_DAYS)) {
    days[key] = ledger.days[key];
  }
  return { ...ledger, days };
}
