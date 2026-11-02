/**
 * Shared record schema-version contract for persisted records (plan §4.5, D6,
 * D-R8, D-VZ8). An absent `schemaVersion` reads as `1` forever; a reader for
 * `currentVersion` accepts `currentVersion` and the previous version
 * `previousRecordSchemaVersion(currentVersion)`; any other present value is
 * refused with `'unknown-schema-version'` so adapters never quarantine a
 * newer schema. Pure: never throws, never runs an accessor, never echoes an
 * input value.
 */

export const INITIAL_RECORD_SCHEMA_VERSION = 1 as const;

export type RecordSchemaFailureReason = 'unknown-schema-version' | 'malformed';

export interface ReadRecordSchemaOptions {
  readonly currentVersion?: number;
}

export type RecordSchemaVersionRead =
  | { readonly ok: true; readonly schemaVersion: number; readonly explicit: boolean }
  | { readonly ok: false; readonly reason: RecordSchemaFailureReason };

export type VersionedRecordRead<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly reason: RecordSchemaFailureReason };

/** True when `value` is a non-null, non-array object with `Object.prototype` or `null` prototype. */
export function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The oldest schema version a reader at `currentVersion` accepts (§4.5 migration rule). */
export function previousRecordSchemaVersion(currentVersion: number): number {
  if (currentVersion > INITIAL_RECORD_SCHEMA_VERSION) {
    return currentVersion - 1;
  }
  return INITIAL_RECORD_SCHEMA_VERSION;
}

/** True when `version` is a safe integer in `[previousRecordSchemaVersion(currentVersion), currentVersion]`. */
export function isAcceptedRecordSchemaVersion(version: unknown, currentVersion: number): version is number {
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return false;
  }
  const minimum = previousRecordSchemaVersion(currentVersion);
  return version >= minimum && version <= currentVersion;
}

/**
 * Read and validate `schemaVersion` on `input` without invoking any getter.
 * Absent `schemaVersion` decodes to `1` (`explicit: false`); an enumerable data
 * property outside the accepted window returns `'unknown-schema-version'`; a
 * non-object, accessor, non-enumerable property or invalid `currentVersion`
 * returns `'malformed'`.
 */
export function readRecordSchemaVersion(
  input: unknown,
  currentVersion: number = INITIAL_RECORD_SCHEMA_VERSION,
): RecordSchemaVersionRead {
  try {
    return readRecordSchemaVersionUnchecked(input, currentVersion);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function readRecordSchemaVersionUnchecked(
  input: unknown,
  currentVersion: number,
): RecordSchemaVersionRead {
  if (!Number.isSafeInteger(currentVersion) || currentVersion < INITIAL_RECORD_SCHEMA_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPlainRecordObject(input)) {
    return { ok: false, reason: 'malformed' };
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, 'schemaVersion');
  if (descriptor === undefined) {
    if (!isAcceptedRecordSchemaVersion(INITIAL_RECORD_SCHEMA_VERSION, currentVersion)) {
      return { ok: false, reason: 'unknown-schema-version' };
    }
    return { ok: true, schemaVersion: INITIAL_RECORD_SCHEMA_VERSION, explicit: false };
  }
  if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
    return { ok: false, reason: 'malformed' };
  }
  if (!isAcceptedRecordSchemaVersion(descriptor.value, currentVersion)) {
    return { ok: false, reason: 'unknown-schema-version' };
  }
  return { ok: true, schemaVersion: descriptor.value, explicit: true };
}
