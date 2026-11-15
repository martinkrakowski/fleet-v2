// Lane CO30a: the CutoverRecord v1 (plan §3.1, D-CO9) and its pure helpers.
// Pure: no filesystem, no subprocess, no clock. Never throws, never echoes an
// input value. Ids, timestamps, digests and codes only.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
import { isPlainRecordObject } from './record-schema-version.js';
import { INITIAL_RECORD_SCHEMA_VERSION, readRecordSchemaVersion } from './record-schema-version.js';

export const CUTOVER_RECORD_SCHEMA_VERSION = INITIAL_RECORD_SCHEMA_VERSION;

export const CUTOVER_STATES = ['shadow', 'switched', 'rolled-back', 'retired'] as const;
export type CutoverState = (typeof CUTOVER_STATES)[number];

export const CUTOVER_MOVES = ['status', 'switch', 'rollback', 'retire'] as const;
export type CutoverMove = (typeof CUTOVER_MOVES)[number];

/** The thirteen shadow criteria the switch move demands evidence for (plan §3.2). */
export const CUTOVER_SHADOW_CRITERIA = [
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13',
] as const;
export type CutoverShadowCriterion = (typeof CUTOVER_SHADOW_CRITERIA)[number];

export const CUTOVER_SHADOW_CONSECUTIVE_DAYS = 3;
export const CUTOVER_SHADOW_MIN_MERGES = 20;
export const CUTOVER_ROLLBACK_WINDOW_DAYS = 14;
export const CUTOVER_ROLLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const MAX_REVISION = 1_000_000_000;
const MAX_STRING_BYTES = 64;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface CutoverRecord {
  readonly schemaVersion: typeof CUTOVER_RECORD_SCHEMA_VERSION;
  readonly revision: number;
  readonly state: CutoverState;
  readonly updatedAtIso: string;
  readonly switchedAtIso: string | null;
  readonly rolledBackAtIso: string | null;
  readonly retiredAtIso: string | null;
  readonly relaunchPlanDigest: string | null;
  readonly trainPauseSetByCutover: boolean;
}

export type CutoverRecordRead =
  | { readonly ok: true; readonly record: CutoverRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'invalid-record' };

const REQUIRED_KEYS = [
  'revision',
  'state',
  'updatedAtIso',
  'switchedAtIso',
  'rolledBackAtIso',
  'retiredAtIso',
  'relaunchPlanDigest',
  'trainPauseSetByCutover',
] as const;

const INVALID = { ok: false, reason: 'invalid-record' } as const;

function isSecretShapedText(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function isSafeStringField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).length <= MAX_STRING_BYTES &&
    !isSecretShapedText(value)
  );
}

function isCutoverState(value: unknown): value is CutoverState {
  return typeof value === 'string' && (CUTOVER_STATES as readonly string[]).includes(value);
}

/** `null` is allowed; any string must be a zoned, calendar-valid, bounded, secret-free time. */
function isNullableIso(value: unknown): value is string | null {
  return value === null || (isSafeStringField(value) && isZonedIsoDateTime(value));
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || (isSafeStringField(value) && DIGEST_PATTERN.test(value));
}

function isNotBefore(laterIso: string, earlierIso: string): boolean {
  return Date.parse(laterIso) >= Date.parse(earlierIso);
}

function statesAreConsistent(record: Omit<CutoverRecord, 'schemaVersion'>): boolean {
  const { state, switchedAtIso, rolledBackAtIso, retiredAtIso, relaunchPlanDigest, trainPauseSetByCutover } = record;
  switch (state) {
    case 'shadow':
      return (
        switchedAtIso === null &&
        rolledBackAtIso === null &&
        retiredAtIso === null &&
        relaunchPlanDigest === null &&
        !trainPauseSetByCutover
      );
    case 'switched':
      return switchedAtIso !== null && rolledBackAtIso === null && retiredAtIso === null && relaunchPlanDigest !== null;
    case 'rolled-back':
      return (
        switchedAtIso !== null &&
        rolledBackAtIso !== null &&
        retiredAtIso === null &&
        relaunchPlanDigest !== null &&
        !trainPauseSetByCutover &&
        isNotBefore(rolledBackAtIso, switchedAtIso)
      );
    case 'retired':
      return (
        switchedAtIso !== null &&
        retiredAtIso !== null &&
        rolledBackAtIso === null &&
        relaunchPlanDigest !== null &&
        !trainPauseSetByCutover &&
        isNotBefore(retiredAtIso, switchedAtIso)
      );
  }
}

function versionFailure(raw: unknown, reason: 'unknown-schema-version' | 'malformed'): CutoverRecordRead {
  if (reason === 'unknown-schema-version') {
    // Only an enumerable data property reaches here; a positive integer is a newer schema, anything else is garbage.
    const value = (Object.getOwnPropertyDescriptor(raw, 'schemaVersion') as PropertyDescriptor | undefined)?.value as unknown;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return { ok: false, reason: 'unknown-version' };
    }
  }
  return INVALID;
}

/** Never throws, never runs a getter, never echoes the input. */
export function readCutoverRecord(raw: unknown): CutoverRecordRead {
  try {
    const version = readRecordSchemaVersion(raw, CUTOVER_RECORD_SCHEMA_VERSION);
    if (!version.ok) {
      return versionFailure(raw, version.reason);
    }
    const snapshot = readPlainRecordWithOptionalKeys(raw, REQUIRED_KEYS, ['schemaVersion']);
    if (snapshot === null) {
      return INVALID;
    }
    const { revision, state, updatedAtIso, switchedAtIso, rolledBackAtIso, retiredAtIso, relaunchPlanDigest } = snapshot;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > MAX_REVISION ||
      !isCutoverState(state) ||
      !isSafeStringField(updatedAtIso) ||
      !isZonedIsoDateTime(updatedAtIso) ||
      !isNullableIso(switchedAtIso) ||
      !isNullableIso(rolledBackAtIso) ||
      !isNullableIso(retiredAtIso) ||
      !isNullableDigest(relaunchPlanDigest) ||
      typeof snapshot.trainPauseSetByCutover !== 'boolean'
    ) {
      return INVALID;
    }
    const candidate = {
      revision,
      state,
      updatedAtIso,
      switchedAtIso,
      rolledBackAtIso,
      retiredAtIso,
      relaunchPlanDigest,
      trainPauseSetByCutover: snapshot.trainPauseSetByCutover,
    };
    if (!statesAreConsistent(candidate)) {
      return INVALID;
    }
    return { ok: true, record: { schemaVersion: CUTOVER_RECORD_SCHEMA_VERSION, ...candidate } };
  } catch {
    return INVALID;
  }
}

/** `cutover/<move>@<revision>`, or null for an unknown move or a revision outside `[0, 1_000_000_000]`. */
export function cutoverJournalKey(move: Exclude<CutoverMove, 'status'>, revision: number): string | null {
  if (move !== 'switch' && move !== 'rollback' && move !== 'retire') {
    return null;
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    return null;
  }
  return `cutover/${move}@${revision}`;
}

/**
 * True strictly inside the 14-day rollback window; null when either time is not a zoned ISO time or
 * `nowIso` precedes `switchedAtIso` (an unusable clock is never a yes or a no).
 */
export function isWithinCutoverRollbackWindow(switchedAtIso: string, nowIso: string): boolean | null {
  if (!isZonedIsoDateTime(switchedAtIso) || !isZonedIsoDateTime(nowIso)) {
    return null;
  }
  const elapsed = Date.parse(nowIso) - Date.parse(switchedAtIso);
  if (elapsed < 0) {
    return null;
  }
  return elapsed < CUTOVER_ROLLBACK_WINDOW_MS;
}

/** The deterministic text the F129 rollback intent digest covers. */
export function canonicalCutoverRollbackPayload(input: {
  readonly expectedRevision: number;
  readonly operationId: string;
}): string {
  return JSON.stringify({ move: 'rollback', expectedRevision: input.expectedRevision, operationId: input.operationId });
}

/** The deterministic text the F129 switch intent digest covers. */
export function canonicalCutoverSwitchPayload(input: {
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly relaunchPlanDigest: string;
}): string {
  return JSON.stringify({
    move: 'switch',
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
    relaunchPlanDigest: input.relaunchPlanDigest,
  });
}

/** The deterministic text the F129 retire intent digest covers. */
export function canonicalCutoverRetirePayload(input: {
  readonly expectedRevision: number;
  readonly operationId: string;
}): string {
  return JSON.stringify({ move: 'retire', expectedRevision: input.expectedRevision, operationId: input.operationId });
}

export type CutoverShadowEvidenceRead =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-evidence'; readonly failed: readonly string[] };

const ALL_CRITERIA: readonly string[] = CUTOVER_SHADOW_CRITERIA;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_STRING_BYTES = 64;

function allCriteriaFailed(): CutoverShadowEvidenceRead {
  return { ok: false, reason: 'invalid-evidence', failed: [...ALL_CRITERIA] };
}

/** The criterion ids in canonical order, or every id when the shape itself was unusable. */
function criteriaFailed(failed: ReadonlySet<string>): CutoverShadowEvidenceRead {
  return { ok: false, reason: 'invalid-evidence', failed: ALL_CRITERIA.filter((id) => failed.has(id)) };
}

/** The own enumerable data-property value of `key`; a getter is never run. */
function ownDataValue(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
    return undefined;
  }
  return descriptor.value;
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).length <= MAX_EVIDENCE_STRING_BYTES;
}

/** The UTC day serial of a real calendar `YYYY-MM-DD` date, or null. */
function utcDayNumber(day: string): number | null {
  if (!DAY_PATTERN.test(day)) {
    return null;
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month < 1 || month > 12) {
    return null;
  }
  if (date < 1 || date > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return null;
  }
  return Math.floor(Date.UTC(year, month - 1, date) / DAY_MS);
}

/**
 * Read one shadow-evidence document without running a single getter. The root is a plain data
 * record whose only own key is `days`: exactly three consecutive ascending UTC calendar dates,
 * none after the UTC date of `nowIso`, each carrying the thirteen criteria, every verdict the
 * string `pass`. Key counts are checked before any descriptor walk, so a document padded with
 * extra keys costs a constant number of descriptor reads, and a structured-clone probe refuses
 * a Proxy stand-in for the document before any result is built. Never throws, never echoes the
 * input, never runs a getter.
 */
export function readCutoverShadowEvidence(raw: unknown, nowIso: string): CutoverShadowEvidenceRead {
  try {
    if (!isPlainRecordObject(raw) || Reflect.ownKeys(raw).length !== 1) {
      return allCriteriaFailed();
    }
    const days = ownDataValue(raw, 'days');
    // The prototype check rejects a stand-in before any length read.
    if (!Array.isArray(days) || Object.getPrototypeOf(days) !== Array.prototype) {
      return allCriteriaFailed();
    }
    const dayKeys = Reflect.ownKeys(days);
    const allowedDayKeys: readonly string[] = ['0', '1', '2', 'length'];
    // Key-count guard first: an over-count is refused before any descriptor read.
    if (dayKeys.length !== allowedDayKeys.length || dayKeys.some((key) => !allowedDayKeys.includes(key as string))) {
      return allCriteriaFailed();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(days, 'length');
    if (
      lengthDescriptor === undefined ||
      lengthDescriptor.get !== undefined ||
      lengthDescriptor.set !== undefined ||
      typeof lengthDescriptor.value !== 'number' ||
      lengthDescriptor.value !== CUTOVER_SHADOW_CONSECUTIVE_DAYS
    ) {
      return allCriteriaFailed();
    }
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(nowMs)) {
      return allCriteriaFailed();
    }
    const nowDay = Math.floor(nowMs / DAY_MS);
    const failed = new Set<string>();
    const dayNumbers: number[] = [];
    for (let index = 0; index < CUTOVER_SHADOW_CONSECUTIVE_DAYS; index += 1) {
      const element = ownDataValue(days, String(index));
      if (!isPlainRecordObject(element) || Reflect.ownKeys(element).length !== 2) {
        return allCriteriaFailed();
      }
      const day = ownDataValue(element, 'day');
      const verdicts = ownDataValue(element, 'verdicts');
      if (!isBoundedText(day) || !isPlainRecordObject(verdicts)) {
        return allCriteriaFailed();
      }
      const dayNumber = utcDayNumber(day);
      if (dayNumber === null) {
        return allCriteriaFailed();
      }
      const verdictKeys = Reflect.ownKeys(verdicts);
      if (verdictKeys.length > ALL_CRITERIA.length || verdictKeys.some((key) => !ALL_CRITERIA.includes(key as string))) {
        return allCriteriaFailed();
      }
      for (const criterion of ALL_CRITERIA) {
        if (ownDataValue(verdicts, criterion) !== 'pass') {
          failed.add(criterion);
        }
      }
      dayNumbers.push(dayNumber);
    }
    const ascendingConsecutive =
      dayNumbers[0] < dayNumbers[1] && dayNumbers[1] < dayNumbers[2] && dayNumbers[2] - dayNumbers[0] === 2;
    if (!ascendingConsecutive || dayNumbers[2] > nowDay) {
      return allCriteriaFailed();
    }
    if (failed.size > 0) {
      return criteriaFailed(failed);
    }
    // A transparent Proxy over the document answers every prototype, key and
    // descriptor read exactly as its target would, so the checks above cannot
    // tell it from data. The structured-clone serializer refuses any Proxy
    // exotic object, and at this point every own property on the document is a
    // validated data property with a primitive value, so the probe reads no
    // getter and costs a constant walk over at most the permitted keys. A
    // clone failure here means a stand-in, never data.
    try {
      structuredClone(raw);
    } catch {
      return allCriteriaFailed();
    }
    return { ok: true };
  } catch {
    return allCriteriaFailed();
  }
}
