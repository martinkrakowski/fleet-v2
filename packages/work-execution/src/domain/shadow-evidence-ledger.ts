// Lane SH1: the pure shadow-evidence ledger and the evidence composer. The
// day-writer use case (SH7) keeps a `ShadowLedger` per cutover, appends
// per-day, per-criterion verdicts with `recordShadowVerdicts`, and composes
// the document `readCutoverShadowEvidence` (cutover-records.ts, untouched)
// checks with `composeCutoverShadowEvidence`. Pure: no filesystem, no
// subprocess, no clock. Never throws, never echoes an input value; every
// exported function takes `unknown` at its boundary and returns a typed
// refusal with a named code.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { CUTOVER_SHADOW_CRITERIA, type CutoverShadowCriterion } from './cutover-records.js';
import { readExactPlainRecord, readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
import {
  INITIAL_RECORD_SCHEMA_VERSION,
  isPlainRecordObject,
  readRecordSchemaVersion,
} from './record-schema-version.js';

export const SHADOW_LEDGER_SCHEMA_VERSION = INITIAL_RECORD_SCHEMA_VERSION;
export const SHADOW_LEDGER_MAX_DAYS = 31;
export const SHADOW_REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHADOW_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const SHADOW_RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHADOW_MAX_MERGES_PER_DAY = 10_000;

/** One criterion's computed evaluation as the later evaluator units (SH5) report it. */
export type ShadowCriterionStatus = 'pass' | 'fail' | 'unknown';

/**
 * The shared evaluator output shape (SH5a/b/c). Load-bearing: the SH7
 * day-writer turns an evaluation with status `pass` into a verdict and
 * everything else into a refusal, so fields are not added or removed lightly.
 */
export interface ShadowCriterionEvaluation {
  readonly status: ShadowCriterionStatus;
  readonly reason: string;
}

/** One criterion's recorded verdict for one day. */
export interface ShadowCriterionVerdict {
  readonly verdict: 'pass' | 'fail';
  readonly reason: string;
  readonly digest: string;
  readonly recordedAtIso: string;
}

/** One day's slice of the ledger. */
export interface ShadowDayRecord {
  readonly day: string;
  readonly releaseSha: string | null;
  readonly mergesCompared: number | null;
  readonly verdicts: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>;
}

/** The whole ledger the day-writer persists between runs. */
export interface ShadowLedger {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly days: readonly ShadowDayRecord[];
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REVISION = 1_000_000_000;
const CRITERION_SET: ReadonlySet<string> = new Set(CUTOVER_SHADOW_CRITERIA);
const EVIDENCE_DAYS = 3;
const LEDGER_DAY_KEYS: readonly string[] = ['day', 'releaseSha', 'mergesCompared', 'verdicts'];
const VERDICT_KEYS: readonly string[] = ['verdict', 'reason', 'digest', 'recordedAtIso'];

const INVALID_LEDGER: ShadowLedgerFailure = { ok: false, reason: 'invalid-ledger' };
type ShadowLedgerFailure = { readonly ok: false; readonly reason: 'invalid-ledger' };

export type ShadowLedgerRead =
  | { readonly ok: true; readonly ledger: ShadowLedger }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'invalid-ledger' };

/**
 * Read a persisted ledger. Own data properties only: every value comes from
 * its own property descriptor, so no getter ever runs. The ledger returned on
 * success is always a fresh structure built field by field from the already-
 * validated primitives — the input is never cloned, with `structuredClone` or
 * anything else that walks every enumerable property, because a clone of
 * not-yet-fully-validated input would run any getter hiding on an unchecked
 * property (an extra enumerable key the field-by-field reads below never
 * name). A Proxy stand-in either is refused by the shape checks below or
 * yields exactly the result the plain data would, since every read here goes
 * through `Object.getOwnPropertyDescriptor`/`Reflect.ownKeys`, never a `get`
 * trap. Cost: linear in the capped input — at most `SHADOW_LEDGER_MAX_DAYS`
 * days times `CUTOVER_SHADOW_CRITERIA.length` verdicts, each with a constant
 * number of descriptor reads; an oversized or non-dense `days` array is
 * refused from its own keys before any element is traversed. Never throws,
 * never echoes the input.
 */
export function readShadowLedger(raw: unknown): ShadowLedgerRead {
  try {
    const version = readRecordSchemaVersion(raw, SHADOW_LEDGER_SCHEMA_VERSION);
    if (!version.ok) {
      return version.reason === 'unknown-schema-version' && isVersionAboveCurrent(raw)
        ? { ok: false, reason: 'unknown-version' }
        : INVALID_LEDGER;
    }
    const snapshot = readPlainRecordWithOptionalKeys(raw, ['revision', 'days'], ['schemaVersion']);
    if (snapshot === null) {
      return INVALID_LEDGER;
    }
    const { revision, days } = snapshot;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > MAX_REVISION
    ) {
      return INVALID_LEDGER;
    }
    const dayArray = Array.isArray(days) ? (days as readonly unknown[]) : null;
    const dayCount = dayArray === null ? null : boundedArrayLength(dayArray);
    if (dayCount === null || dayArray === null) {
      return INVALID_LEDGER;
    }
    const readDays: ShadowDayRecord[] = [];
    let previousSerial: number | null = null;
    for (let index = 0; index < dayCount; index += 1) {
      const day = readDayRecord(ownElement(dayArray, index));
      if (day === null) {
        return INVALID_LEDGER;
      }
      const serial = dayNumber(day.day);
      if (previousSerial !== null && serial !== null && serial <= previousSerial) {
        return INVALID_LEDGER;
      }
      previousSerial = serial;
      readDays.push(day);
    }
    const ledger: ShadowLedger = { schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION, revision, days: readDays };
    return { ok: true, ledger };
  } catch {
    return INVALID_LEDGER;
  }
}

/**
 * True when the ledger's own `schemaVersion` is a positive integer strictly
 * above the current one — the only case the brief reserves `unknown-version`
 * for. Any other out-of-window version (`0`, a fraction, a string, a negative
 * number) is `invalid-ledger`. The version reader has already proved the
 * property is an enumerable own data property before reporting
 * `unknown-schema-version`, so reading the descriptor value runs no getter.
 */
function isVersionAboveCurrent(raw: unknown): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(raw as object, 'schemaVersion');
  if (descriptor === undefined || descriptor.get !== undefined) {
    return false;
  }
  const value: unknown = descriptor.value;
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > SHADOW_LEDGER_SCHEMA_VERSION
  );
}

/**
 * The capped element count of a real, dense array, or null for any stand-in,
 * oversized, sparse, or extra-keyed array. `Object.keys` lists own enumerable
 * string keys without reading any value, so it runs no getter; comparing its
 * count to `length` catches both a hole (fewer keys than `length`) and an
 * extra own enumerable property such as a getter planted beside the indices
 * (more keys than `length`) — either way, the array is refused before a
 * single element or any extra property is read, so a getter hiding on it
 * never runs, here or when the ledger is rebuilt afterward.
 */
function boundedArrayLength(value: unknown): number | null {
  // `Array.isArray` follows a Proxy without running a trap; the length is
  // read from its own descriptor, so no `get` trap ever runs.
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value > SHADOW_LEDGER_MAX_DAYS
  ) {
    return null;
  }
  if (Object.keys(value).length !== lengthDescriptor.value) {
    return null;
  }
  return lengthDescriptor.value;
}

/** The own data-property element at `index`, or undefined for a hole or an accessor. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** One day record, or null when any field is out of shape. */
function readDayRecord(raw: unknown): ShadowDayRecord | null {
  const snapshot = readExactPlainRecord(raw, LEDGER_DAY_KEYS);
  if (snapshot === null) {
    return null;
  }
  const { day, releaseSha, mergesCompared, verdicts } = snapshot;
  if (typeof day !== 'string' || dayNumber(day) === null || isSecretShaped(day)) {
    return null;
  }
  if (releaseSha !== null && !isValidReleaseSha(releaseSha)) {
    return null;
  }
  if (mergesCompared !== null && !isValidMergesCompared(mergesCompared)) {
    return null;
  }
  const readVerdictsResult = readVerdicts(verdicts);
  if (readVerdictsResult === null) {
    return null;
  }
  if (mergesCompared !== null && readVerdictsResult.S1 === undefined) {
    return null;
  }
  return { day, releaseSha, mergesCompared, verdicts: readVerdictsResult };
}

/** A 40-hex-digit release sha that carries no secret shape. */
function isValidReleaseSha(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_RELEASE_SHA_PATTERN.test(value) && !isSecretShaped(value);
}

/** A safe integer in `[0, SHADOW_MAX_MERGES_PER_DAY]`. */
function isValidMergesCompared(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SHADOW_MAX_MERGES_PER_DAY
  );
}

/** The verdicts map of a day, or null when any key or value is out of shape. */
function readVerdicts(
  value: unknown,
): Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const out: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = {};
  for (const key of Reflect.ownKeys(value)) {
    // A key produced by `JSON.parse` as `__proto__`, `constructor` or
    // `prototype` is an own key here; only criterion ids are accepted.
    if (typeof key !== 'string' || !CRITERION_SET.has(key)) {
      return null;
    }
    const verdict = readCriterionVerdict(ownDataValue(value, key));
    if (verdict === null) {
      return null;
    }
    out[key as CutoverShadowCriterion] = verdict;
  }
  return out;
}

/** One verdict value, or null when any of its four fields is out of shape. */
function readCriterionVerdict(raw: unknown): ShadowCriterionVerdict | null {
  const snapshot = readExactPlainRecord(raw, VERDICT_KEYS);
  if (snapshot === null) {
    return null;
  }
  const { verdict, reason, digest, recordedAtIso } = snapshot;
  if ((verdict !== 'pass' && verdict !== 'fail') || !isValidReason(reason) || !isValidDigest(digest)) {
    return null;
  }
  if (!isZonedIsoDateTime(recordedAtIso)) {
    return null;
  }
  return { verdict, reason, digest, recordedAtIso };
}

/** A lowercase reason code, at most 64 characters, carrying no secret shape. */
function isValidReason(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_REASON_PATTERN.test(value) && !isSecretShaped(value);
}

/** A 64-hex-digit criterion digest. */
function isValidDigest(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_DIGEST_PATTERN.test(value);
}

/** The own enumerable data-property value of `key`; a getter is never run. */
function ownDataValue(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined) {
    return undefined;
  }
  return descriptor.value;
}

/** Both secret registries, as the comparators check them (CO31 precedent). */
function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** The UTC day serial of a real calendar `YYYY-MM-DD` date, or null. */
function dayNumber(day: string): number | null {
  if (!DAY_PATTERN.test(day)) {
    return null;
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month < 1 || month > 12) {
    return null;
  }
  if (date < 1 || date > new Date(utcInstant(year, month, 0)).getUTCDate()) {
    return null;
  }
  return Math.floor(utcInstant(year, month - 1, date) / DAY_MS);
}

/**
 * The UTC epoch millisecond of `year`-`monthIndex`-`date`, set through
 * `setUTCFullYear` rather than computed with `Date.UTC`/the multi-argument
 * `Date` constructor: those two apply the well-known two-digit-year special
 * case (a `year` of 0-99 is read as 1900-1999), which would sort an early
 * four-digit year such as `0099` after a later one such as `0100`.
 * `setUTCFullYear` carries no such special case, so every validated 4-digit
 * `YYYY` sorts by its own value.
 */
function utcInstant(year: number, monthIndex: number, date: number): number {
  const instant = new Date(0);
  instant.setUTCFullYear(year, monthIndex, date);
  return instant.getTime();
}

export interface ShadowVerdictsInput {
  readonly day: string;
  readonly releaseSha: string | null;
  readonly mergesCompared?: number;
  readonly verdicts: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>;
}

export type ShadowVerdictsWrite =
  | { readonly ok: true; readonly ledger: ShadowLedger; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-ledger'
        | 'invalid-input'
        | 'day-out-of-order'
        | 'verdict-conflict'
        | 'release-conflict'
        | 'merges-conflict';
    };

/**
 * Record one day's verdicts onto the ledger. `ledger === null` means nothing
 * stored yet (revision 0, no days); any other invalid ledger shape is
 * refused. On an existing day the new verdicts merge into the recorded ones:
 * a criterion recorded with an equal verdict, reason and digest is an
 * idempotent no-op, and any difference refuses the whole call with
 * `verdict-conflict` — nothing partial is ever written. On a new day the date
 * must sort strictly after the current last stored day. Cost: linear in the
 * capped ledger plus the capped input (both bounds are the named constants
 * above); refusal paths leave the input arguments untouched. Never throws,
 * never echoes an input value, always returns a fresh structure.
 */
export function recordShadowVerdicts(ledger: unknown, input: unknown): ShadowVerdictsWrite {
  let existing: { readonly revision: number; readonly days: readonly ShadowDayRecord[] } = { revision: 0, days: [] };
  if (ledger !== null) {
    const read = readShadowLedger(ledger);
    if (!read.ok) {
      return { ok: false, reason: 'invalid-ledger' };
    }
    existing = { revision: read.ledger.revision, days: read.ledger.days };
  }
  // A Proxy stand-in for the input can throw from an `ownKeys` or `get`
  // trap before any field is read; the refusal is the same invalid-input.
  // A Proxy stand-in for the input can throw from an `ownKeys` or `get`
  // trap before any field is read; the refusal is the same invalid-input.
  let parsed: ShadowVerdictsInput | null;
  try {
    parsed = readVerdictsInput(input);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  return writeVerdicts(existing, parsed);
}

/** The parsed input record, or null when any field is out of shape. */
function readVerdictsInput(raw: unknown): ShadowVerdictsInput | null {
  const snapshot = readPlainRecordWithOptionalKeys(raw, ['day', 'releaseSha', 'verdicts'], ['mergesCompared']);
  if (snapshot === null) {
    return null;
  }
  const { day, releaseSha, mergesCompared, verdicts } = snapshot;
  if (typeof day !== 'string' || dayNumber(day) === null || isSecretShaped(day)) {
    return null;
  }
  if (releaseSha !== null && !isValidReleaseSha(releaseSha)) {
    return null;
  }
  // The optional-key reader above copies an accessor's descriptor `value`,
  // which is `undefined` for a getter — indistinguishable, so far, from the
  // key being genuinely absent. The descriptor on `raw` itself (never its
  // value) resolves the two: a present getter is a malformed shape, refused
  // here, rather than silently treated as "mergesCompared not given."
  if (mergesCompared === undefined) {
    if (isOwnAccessorKey(raw, 'mergesCompared')) {
      return null;
    }
  } else if (!isValidMergesCompared(mergesCompared)) {
    return null;
  }
  const readVerdictsResult = readVerdicts(verdicts);
  if (readVerdictsResult === null) {
    return null;
  }
  return {
    day,
    releaseSha,
    mergesCompared,
    verdicts: readVerdictsResult,
  };
}

/**
 * True when `record` has `key` as its own accessor property. Only the
 * descriptor is inspected, never a `get`/`set` invoked, so a getter never
 * runs here.
 */
function isOwnAccessorKey(record: unknown, key: string): boolean {
  if (typeof record !== 'object' || record === null) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined);
}

/** The merge against the stored ledger, after the input shape was accepted. */
function writeVerdicts(
  existing: { readonly revision: number; readonly days: readonly ShadowDayRecord[] },
  parsed: ShadowVerdictsInput,
): ShadowVerdictsWrite {
  const existingIndex = existing.days.findIndex((day) => day.day === parsed.day);
  if (existingIndex >= 0) {
    return mergeIntoDay(existing, existingIndex, parsed);
  }
  return appendDay(existing, parsed);
}

/** Merge the input into the day at `existingIndex`, refusing any conflict. */
function mergeIntoDay(
  existing: { readonly revision: number; readonly days: readonly ShadowDayRecord[] },
  existingIndex: number,
  parsed: ShadowVerdictsInput,
): ShadowVerdictsWrite {
  const day = existing.days[existingIndex];
  const conflict = findVerdictConflict(day.verdicts, parsed.verdicts);
  if (conflict !== null) {
    return { ok: false, reason: conflict };
  }
  if (day.releaseSha !== null && parsed.releaseSha !== day.releaseSha) {
    return { ok: false, reason: 'release-conflict' };
  }
  if (
    parsed.mergesCompared !== undefined &&
    parsed.mergesCompared !== day.mergesCompared &&
    day.mergesCompared !== null
  ) {
    return { ok: false, reason: 'merges-conflict' };
  }
  if (parsed.mergesCompared !== undefined && !carriesS1(day.verdicts, parsed.verdicts)) {
    return { ok: false, reason: 'invalid-input' };
  }
  // Only criteria not already recorded are written. An equal verdict, reason
  // and digest is an idempotent no-op for that criterion: the recorded
  // verdict (including its recordedAtIso) is kept, so a re-record with a
  // different timestamp leaves the ledger exactly as it was.
  const mergedVerdicts: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = { ...day.verdicts };
  for (const [criterion, verdict] of Object.entries(parsed.verdicts)) {
    if (day.verdicts[criterion as CutoverShadowCriterion] === undefined) {
      mergedVerdicts[criterion as CutoverShadowCriterion] = copyVerdict(verdict);
    }
  }
  const mergesCompared = parsed.mergesCompared !== undefined ? parsed.mergesCompared : day.mergesCompared;
  const changed =
    Object.keys(parsed.verdicts).some((criterion) => day.verdicts[criterion as CutoverShadowCriterion] === undefined) ||
    (day.mergesCompared === null && mergesCompared !== null) ||
    (day.releaseSha === null && parsed.releaseSha !== null);
  const nextDay: ShadowDayRecord = {
    day: day.day,
    releaseSha: day.releaseSha ?? parsed.releaseSha,
    mergesCompared,
    verdicts: mergedVerdicts,
  };
  return commit(existing, existingIndex, nextDay, changed);
}

/** The first conflict between the recorded and the new verdicts, or null. */
function findVerdictConflict(
  recorded: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>,
  incoming: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>,
): 'verdict-conflict' | null {
  for (const [criterion, verdict] of Object.entries(incoming)) {
    const prior = recorded[criterion as CutoverShadowCriterion];
    if (
      prior !== undefined &&
      (prior.verdict !== verdict.verdict || prior.reason !== verdict.reason || prior.digest !== verdict.digest)
    ) {
      return 'verdict-conflict';
    }
  }
  return null;
}

/** True when the day or the input carries an `S1` verdict. */
function carriesS1(
  recorded: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>,
  incoming: Readonly<Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>>,
): boolean {
  return recorded.S1 !== undefined || incoming.S1 !== undefined;
}

/** Append the input as a new day, refusing an out-of-order date. */
function appendDay(
  existing: { readonly revision: number; readonly days: readonly ShadowDayRecord[] },
  parsed: ShadowVerdictsInput,
): ShadowVerdictsWrite {
  const last = existing.days[existing.days.length - 1];
  if (last !== undefined && (dayNumber(parsed.day) ?? 0) <= (dayNumber(last.day) ?? 0)) {
    return { ok: false, reason: 'day-out-of-order' };
  }
  if (parsed.mergesCompared !== undefined && parsed.verdicts.S1 === undefined) {
    return { ok: false, reason: 'invalid-input' };
  }
  const verdicts: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = {};
  for (const [criterion, verdict] of Object.entries(parsed.verdicts)) {
    verdicts[criterion as CutoverShadowCriterion] = copyVerdict(verdict);
  }
  const nextDay: ShadowDayRecord = {
    day: parsed.day,
    releaseSha: parsed.releaseSha,
    mergesCompared: parsed.mergesCompared !== undefined ? parsed.mergesCompared : null,
    verdicts,
  };
  return commit(existing, existing.days.length, nextDay, true);
}

/** A fresh copy of one verdict, never the stored reference. */
function copyVerdict(verdict: ShadowCriterionVerdict): ShadowCriterionVerdict {
  return { ...verdict };
}

/**
 * The final ledger, bumping the revision and pruning only on a real change.
 * At the revision cap a real change is refused: the bumped revision would
 * fall outside the reader's accepted range, so the write never persists an
 * unreadable ledger. An idempotent no-op at the cap stays a valid no-op.
 */
function commit(
  existing: { readonly revision: number; readonly days: readonly ShadowDayRecord[] },
  replaceIndex: number,
  nextDay: ShadowDayRecord,
  changed: boolean,
): ShadowVerdictsWrite {
  if (changed && existing.revision + 1 > MAX_REVISION) {
    return { ok: false, reason: 'invalid-ledger' };
  }
  const appended = replaceIndex >= existing.days.length;
  const withReplacement = appended
    ? [...existing.days.map(copyDay), nextDay]
    : existing.days.map((day, index) => (index === replaceIndex ? nextDay : copyDay(day)));
  const revision = changed ? existing.revision + 1 : existing.revision;
  const days = changed ? pruneDays(withReplacement) : withReplacement;
  return { ok: true, ledger: { schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION, revision, days }, changed };
}

/** Keep only the newest `SHADOW_LEDGER_MAX_DAYS` days, dropping the oldest first. */
function pruneDays(days: readonly ShadowDayRecord[]): ShadowDayRecord[] {
  if (days.length <= SHADOW_LEDGER_MAX_DAYS) {
    return [...days];
  }
  return days.slice(days.length - SHADOW_LEDGER_MAX_DAYS);
}

/** A fresh copy of one day record, never the stored reference. */
function copyDay(day: ShadowDayRecord): ShadowDayRecord {
  const verdicts: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = {};
  for (const [criterion, verdict] of Object.entries(day.verdicts)) {
    verdicts[criterion as CutoverShadowCriterion] = copyVerdict(verdict);
  }
  return { day: day.day, releaseSha: day.releaseSha, mergesCompared: day.mergesCompared, verdicts };
}

export type ShadowEvidenceCompose =
  | {
      readonly status: 'ok';
      readonly evidence: {
        readonly merges: number;
        readonly days: readonly { readonly day: string; readonly verdicts: Record<string, 'pass' | 'fail'> }[];
      };
    }
  | {
      readonly status: 'absent';
      readonly reason:
        | 'no-ledger'
        | 'invalid-ledger'
        | 'invalid-clock'
        | 'invalid-options'
        | 'too-few-days'
        | 'stale'
        | 'release-changed';
    };

/**
 * Compose the shadow-evidence document the switch move checks. Only the
 * document shape is composed here: `readCutoverShadowEvidence` (already
 * built, untouched) checks consecutiveness, the thirteen-criterion floor and
 * the twenty-merge floor from the returned evidence. Cost: linear in the
 * capped ledger. Never throws, never echoes an input value; the evidence is
 * freshly built, never a reference into the input ledger.
 */
export function composeCutoverShadowEvidence(
  ledger: unknown,
  nowIso: unknown,
  options: unknown,
): ShadowEvidenceCompose {
  // A Proxy stand-in for `options` can throw from an `ownKeys` trap before
  // any field is read; the refusal is the same invalid-options.
  let optionSnapshot: Record<string, unknown> | null;
  try {
    optionSnapshot = readExactPlainRecord(options, ['requireSingleRelease']);
  } catch {
    optionSnapshot = null;
  }
  if (optionSnapshot === null || typeof optionSnapshot.requireSingleRelease !== 'boolean') {
    return { status: 'absent', reason: 'invalid-options' };
  }
  if (ledger === null) {
    return { status: 'absent', reason: 'no-ledger' };
  }
  const read = readShadowLedger(ledger);
  if (!read.ok) {
    return { status: 'absent', reason: 'invalid-ledger' };
  }
  if (!isZonedIsoDateTime(nowIso) || typeof nowIso !== 'string') {
    return { status: 'absent', reason: 'invalid-clock' };
  }
  return composeEvidence(read.ledger, nowIso, optionSnapshot.requireSingleRelease);
}

/** The newest three days composed, after the shapes were accepted. */
function composeEvidence(ledger: ShadowLedger, nowIso: string, requireSingleRelease: boolean): ShadowEvidenceCompose {
  const days = ledger.days;
  if (days.length < EVIDENCE_DAYS) {
    return { status: 'absent', reason: 'too-few-days' };
  }
  const last = days.slice(-EVIDENCE_DAYS);
  if (isStale(last[EVIDENCE_DAYS - 1].day, nowIso)) {
    return { status: 'absent', reason: 'stale' };
  }
  if (requireSingleRelease && !singleRelease(last)) {
    return { status: 'absent', reason: 'release-changed' };
  }
  return { status: 'ok', evidence: { merges: totalMerges(last), days: last.map(evidenceDay) } };
}

/** True when the newest stored day is more than one UTC day before `nowIso`. */
function isStale(newestDay: string, nowIso: string): boolean {
  const newest = dayNumber(newestDay) ?? 0;
  const now = Math.floor(Date.parse(nowIso) / DAY_MS);
  return newest < now - 1;
}

/** True when all three days carry the same non-null release sha. */
function singleRelease(days: readonly ShadowDayRecord[]): boolean {
  const first = days[0].releaseSha;
  return (
    first !== null &&
    days.every((day) => day.releaseSha === first)
  );
}

/** The sum of the three days' merge counts, with `null` counted as 0. */
function totalMerges(days: readonly ShadowDayRecord[]): number {
  return days.reduce((sum, day) => sum + (day.mergesCompared ?? 0), 0);
}

/** One composed day: only the criteria actually recorded, unpadded. */
function evidenceDay(day: ShadowDayRecord): { day: string; verdicts: Record<string, 'pass' | 'fail'> } {
  const verdicts: Record<string, 'pass' | 'fail'> = {};
  for (const [criterion, verdict] of Object.entries(day.verdicts)) {
    verdicts[criterion] = verdict.verdict;
  }
  return { day: day.day, verdicts };
}
