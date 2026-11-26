/**
 * Shared record guards for the tenancy entities: the validation result shape,
 * the id and ISO-8601 helpers, and the bounded plain-record snapshot and
 * field checks that Organization and Project both use. Pure domain code: no
 * Node, filesystem, subprocess, network or vendor imports.
 *
 * Hostile-input posture: null, undefined, non-objects, arrays, array-likes,
 * non-plain prototypes, getters/setters (never read), Proxies (via the
 * injected detector), sparse arrays, oversized strings and
 * prototype-polluting own keys are each refused with a typed result, never
 * a throw and never a pass.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

/**
 * The result shape every tenancy validator and transition function returns.
 * Nothing in this domain throws on hostile input: a refused value is a
 * result with a reason, never an exception.
 */
export type ValidationOk<T> = { readonly ok: true; readonly value: T };

export type ValidationRefused = { readonly ok: false; readonly reason: string };

export type ValidationResult<T> = ValidationOk<T> | ValidationRefused;

/** Build a refused result with a stable, human-readable reason. */
export function refused<T>(reason: string): ValidationResult<T> {
  return { ok: false, reason };
}

/** Build an accepted result carrying the parsed value. */
export function accepted<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

/** One organisation or project id: lower-case alphanumerics and dashes. */
export const ORGANIZATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * True when the date and time fields of an ISO-8601 string name a real
 * calendar instant. Date.parse rolls an impossible date such as 02-31 over
 * into the next month instead of refusing it, so the fields are checked
 * here. Cost bound: O(1) — a fixed number of field reads and one bounded
 * Date.UTC call.
 */
export function isCalendarDateTime(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const hour = Number(iso.slice(11, 13));
  const minute = Number(iso.slice(14, 16));
  const second = Number(iso.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** A zoned, calendar-valid ISO-8601 time: the shape of every tenancy timestamp. */
export function isZonedIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ZONED_ISO_PATTERN.test(value) &&
    isCalendarDateTime(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Compare two zoned ISO-8601 timestamps that already passed
 * isZonedIsoDateTime, to the full nine fractional digits the format allows.
 * Date.parse keeps only millisecond precision, so two instants that differ
 * below a millisecond would compare equal. Returns a negative number, zero
 * or a positive number. Cost bound: O(1) — two Date.parse calls and one
 * comparison of two fixed-width digit strings.
 */
export function compareZonedIsoInstants(a: string, b: string): number {
  const millisA = Date.parse(a);
  const millisB = Date.parse(b);
  if (millisA !== millisB) {
    return millisA < millisB ? -1 : 1;
  }
  const subMilli = (value: string): string => {
    const match = /\.(\d{1,9})/.exec(value);
    return (match === null ? "" : match[1]).padEnd(9, "0").slice(3);
  };
  const subA = subMilli(a);
  const subB = subMilli(b);
  if (subA === subB) {
    return 0;
  }
  return subA < subB ? -1 : 1;
}

export const MAX_STRING_LENGTH = 4096;
export const MAX_DISPLAY_NAME_LENGTH = 120;

// Control characters are refused anywhere in a display name. Scanned by
// character code instead of a regex; the display-name length check bounds
// the scan to at most 120 characters, so the cost is O(1).
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function snapshotRefusal(
  label: string,
  reason: string,
  path: string | null,
  allowedKeys: ReadonlySet<string>,
): string {
  // A top-level path must equal an allowed key exactly, so naming the field
  // is safe; the offending value itself is never echoed.
  const named = path !== null && allowedKeys.has(path);
  switch (reason) {
    case "too-long":
      return named
        ? `${label} record ${path} is an oversized string`
        : `${label} record has an oversized string`;
    case "proxy":
      return `${label} record must be a plain object, not a Proxy`;
    case "accessor":
      return named
        ? `${label} record ${path} has a getter or setter property`
        : `${label} record has a getter or setter property`;
    case "not-plain":
      return `${label} record must be a plain object`;
    case "not-enumerable":
      return named
        ? `${label} record ${path} is a non-enumerable property`
        : `${label} record has a non-enumerable property`;
    case "symbol-key":
      return `${label} record has a symbol own key`;
    case "sparse-array":
      return `${label} record must be a plain object, not a sparse array`;
    case "too-many-keys":
      return `${label} record has too many own keys`;
    case "unsupported-type":
      return named
        ? `${label} record ${path} has an unsupported value type`
        : `${label} record must be a plain object`;
    case "hostile":
      return `${label} record is a hostile runtime value`;
    default:
      return `${label} record is not plain data (${reason})`;
  }
}

/**
 * Snapshot unknown input as a plain record whose own keys are all in
 * `allowedKeys`. Cost bound: O(1) — one bounded snapshot pass (at most
 * `allowedKeys.size` keys, depth 1, strings capped at 4096 characters) plus
 * one pass over at most that many own keys, refusing before iterating when
 * the own-key count exceeds the allowed key set.
 */
export function snapshotRecord(
  label: string,
  input: unknown,
  isProxy: IsProxy | undefined,
  allowedKeys: ReadonlySet<string>,
): ValidationResult<Record<string, unknown>> {
  const snapshot = snapshotPlainData(
    input,
    isProxy ?? (() => false),
    { maxDepth: 1, maxKeys: allowedKeys.size, maxStringLength: MAX_STRING_LENGTH },
  );
  if (!snapshot.ok) {
    return refused(snapshotRefusal(label, snapshot.reason, snapshot.path, allowedKeys));
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refused(`${label} record must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  // Refuse before iterating when the shape is already wrong.
  if (ownKeys.length > allowedKeys.size) {
    return refused(`${label} record has too many own keys`);
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return refused(`${label} record has a symbol own key`);
    }
    if (key === "__proto__" || key === "constructor") {
      return refused(`${label} record has the prototype-polluting key ${key}`);
    }
    if (!allowedKeys.has(key)) {
      // The unknown key text is never echoed.
      return refused(`${label} record has an extra unknown key`);
    }
  }
  return accepted(record);
}

/** The fields every tenancy record carries besides its own id fields. */
export interface CommonFields {
  readonly schemaVersion: unknown;
  readonly schemaVersionPresent: boolean;
  readonly displayName: unknown;
  readonly status: unknown;
  readonly createdAtIso: unknown;
  readonly retiredAtIso: unknown;
}

/**
 * Read the common fields from a snapshotted record. `schemaVersionPresent`
 * records whether the own key exists, so an own `schemaVersion: undefined`
 * is refused rather than treated as absent.
 */
export function readCommonFields(record: Record<string, unknown>): CommonFields {
  return {
    schemaVersion: record.schemaVersion,
    schemaVersionPresent: Object.hasOwn(record, "schemaVersion"),
    displayName: record.displayName,
    status: record.status,
    createdAtIso: record.createdAtIso,
    retiredAtIso: record.retiredAtIso,
  };
}

/**
 * Validate schemaVersion, the id fields (in the given order), displayName,
 * status and the createdAtIso/retiredAtIso lifecycle of one record. Returns
 * the refusal reason, or null when every check passes. Cost bound: O(1) —
 * a fixed number of field checks over bounded strings.
 */
export function checkCommonFields(
  label: string,
  fields: CommonFields,
  ids: ReadonlyArray<readonly [string, unknown]>,
): string | null {
  if (fields.schemaVersionPresent && fields.schemaVersion !== 1) {
    return `${label} record schemaVersion must be 1 when present`;
  }
  for (const [name, value] of ids) {
    if (typeof value !== "string" || !ORGANIZATION_ID_PATTERN.test(value)) {
      return `${label} record ${name} must match the organization id pattern`;
    }
  }
  if (typeof fields.displayName !== "string") {
    return `${label} record displayName must be a string`;
  }
  if (fields.displayName.length < 1 || fields.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return `${label} record displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters`;
  }
  if (hasControlCharacter(fields.displayName)) {
    return `${label} record displayName must not contain control characters`;
  }
  if (fields.status !== "active" && fields.status !== "retired") {
    return `${label} record status must be active or retired`;
  }
  if (!isZonedIsoDateTime(fields.createdAtIso)) {
    return `${label} record createdAtIso must be a zoned ISO-8601 timestamp`;
  }
  if (fields.retiredAtIso === null) {
    return fields.status === "retired"
      ? `${label} record retiredAtIso must be set when status is retired`
      : null;
  }
  if (!isZonedIsoDateTime(fields.retiredAtIso)) {
    return `${label} record retiredAtIso must be null or a zoned ISO-8601 timestamp`;
  }
  if (fields.status === "active") {
    return `${label} record retiredAtIso must be null when status is active`;
  }
  if (compareZonedIsoInstants(fields.retiredAtIso, fields.createdAtIso) < 0) {
    return `${label} record retiredAtIso must not precede createdAtIso`;
  }
  return null;
}
