// Lane CO30a: the CutoverRecord v1 (plan §3.1, D-CO9) and its pure helpers.
// Pure: no filesystem, no subprocess, no clock. Never throws, never echoes an
// input value. Ids, timestamps, digests and codes only.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
import { INITIAL_RECORD_SCHEMA_VERSION, readRecordSchemaVersion } from './record-schema-version.js';

export const CUTOVER_RECORD_SCHEMA_VERSION = INITIAL_RECORD_SCHEMA_VERSION;

export const CUTOVER_STATES = ['shadow', 'switched', 'rolled-back', 'retired'] as const;
export type CutoverState = (typeof CUTOVER_STATES)[number];

export const CUTOVER_MOVES = ['status', 'switch', 'rollback', 'retire'] as const;
export type CutoverMove = (typeof CUTOVER_MOVES)[number];

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
