/**
 * Organization: the top-level tenancy aggregate. Pure domain code: no Node,
 * filesystem, subprocess, network or vendor imports; every timestamp is
 * passed in, never read from a clock.
 *
 * Hostile-input posture: validators refuse null, undefined, non-objects,
 * arrays, array-likes, non-plain prototypes, getters/setters (never read),
 * Proxies (via the injected detector, never through reflection traps),
 * sparse arrays, oversized strings and prototype-polluting own keys, each
 * with a typed refused result, never a throw and never a pass.
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
 * `DEFAULT_ORGANIZATION_ID` is always a valid organisation id, and an absent
 * organisation id anywhere in a hosted record means the default organisation
 * (the reader that applies this fallback is a later unit; a stored default
 * organisation record may still be retired, in which case `acceptsNewWork`
 * returns `false`).
 */
export const DEFAULT_ORGANIZATION_ID = "default";

export type OrganizationStatus = "active" | "retired";

export interface OrganizationRecord {
  readonly schemaVersion?: 1;
  readonly organizationId: string;
  readonly displayName: string;
  readonly status: OrganizationStatus;
  readonly createdAtIso: string;
  readonly retiredAtIso: string | null;
}

/** The only own keys an OrganizationRecord may carry. */
const ORGANIZATION_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "organizationId",
  "displayName",
  "status",
  "createdAtIso",
  "retiredAtIso",
]);

const MAX_STRING_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 120;
// Control characters are refused anywhere in a display name. Scanned by
// character code instead of a regex; the length check above bounds the scan
// to at most 120 characters, so the cost is O(1).
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

interface SnapshotFields {
  readonly organizationId: unknown;
  readonly displayName: unknown;
  readonly status: unknown;
  readonly createdAtIso: unknown;
  readonly retiredAtIso: unknown;
  readonly schemaVersion: unknown;
}

/**
 * Validate unknown input as an OrganizationRecord; a refused value never
 * throws.
 *
 * Cost bound: O(1) — one bounded snapshot pass (at most 6 keys, depth 1,
 * strings capped at 4096 characters) plus one pass over at most the 6
 * allowed own keys, refusing before iterating when the own-key count exceeds
 * the allowed key set.
 */
export function validateOrganizationRecord(
  input: unknown,
  isProxy?: IsProxy,
): ValidationResult<OrganizationRecord> {
  const snapshot = snapshotPlainData(
    input,
    isProxy ?? (() => false),
    { maxDepth: 1, maxKeys: 6, maxStringLength: MAX_STRING_LENGTH },
  );
  if (!snapshot.ok) {
    return refused(organizationSnapshotRefusal(snapshot.reason, snapshot.path, ORGANIZATION_ALLOWED_KEYS));
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refused("organization record must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  // Refuse before iterating when the shape is already wrong.
  if (ownKeys.length > ORGANIZATION_ALLOWED_KEYS.size) {
    return refused("organization record has too many own keys");
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return refused("organization record has a symbol own key");
    }
    if (key === "__proto__" || key === "constructor") {
      return refused(`organization record has the prototype-polluting key ${key}`);
    }
    if (!ORGANIZATION_ALLOWED_KEYS.has(key)) {
      // The unknown key text is never echoed.
      return refused("organization record has an extra unknown key");
    }
  }
  const fields: SnapshotFields = {
    schemaVersion: record.schemaVersion,
    organizationId: record.organizationId,
    displayName: record.displayName,
    status: record.status,
    createdAtIso: record.createdAtIso,
    retiredAtIso: record.retiredAtIso,
  };
  return validateOrganizationFields(fields);
}

function organizationSnapshotRefusal(
  reason: string,
  path: string | null,
  allowedKeys: ReadonlySet<string>,
): string {
  // A `too-long` refusal at a top-level field carries that field's own name
  // as the path; echoing it is safe because it must equal an allowed key
  // exactly, and the oversized string itself is never echoed.
  if (reason === "too-long" && path !== null && allowedKeys.has(path)) {
    return `organization record ${path} is an oversized string`;
  }
  switch (reason) {
    case "proxy":
      return "organization record must be a plain object, not a Proxy";
    case "accessor":
      return "organization record has a getter or setter property";
    case "not-plain":
      return "organization record must be a plain object";
    case "not-enumerable":
      return "organization record has a non-enumerable property";
    case "symbol-key":
      return "organization record has a symbol own key";
    case "sparse-array":
      return "organization record must be a plain object, not a sparse array";
    case "too-many-keys":
      return "organization record has too many own keys";
    case "too-long":
      return "organization record has an oversized string";
    case "unsupported-type":
      return "organization record must be a plain object";
    case "hostile":
      return "organization record is a hostile runtime value";
    default:
      return `organization record is not plain data (${reason})`;
  }
}

/** Field-level validation shared by the organization validator and retire. */
function validateOrganizationFields(fields: SnapshotFields): ValidationResult<OrganizationRecord> {
  if (fields.schemaVersion !== undefined && fields.schemaVersion !== 1) {
    return refused("organization record schemaVersion must be 1 when present");
  }
  if (typeof fields.organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(fields.organizationId)) {
    return refused("organization record organizationId must match the organization id pattern");
  }
  if (typeof fields.displayName !== "string") {
    return refused("organization record displayName must be a string");
  }
  if (fields.displayName.length < 1 || fields.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return refused(`organization record displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  if (hasControlCharacter(fields.displayName)) {
    return refused("organization record displayName must not contain control characters");
  }
  if (fields.status !== "active" && fields.status !== "retired") {
    return refused("organization record status must be active or retired");
  }
  if (!isZonedIsoDateTime(fields.createdAtIso)) {
    return refused("organization record createdAtIso must be a zoned ISO-8601 timestamp");
  }
  if (fields.retiredAtIso === null) {
    if (fields.status === "retired") {
      return refused("organization record retiredAtIso must be set when status is retired");
    }
    return accepted(finishOrganizationRecord(fields, null));
  }
  if (!isZonedIsoDateTime(fields.retiredAtIso)) {
    return refused("organization record retiredAtIso must be null or a zoned ISO-8601 timestamp");
  }
  if (fields.status === "active") {
    return refused("organization record retiredAtIso must be null when status is active");
  }
  if (Date.parse(fields.retiredAtIso) < Date.parse(fields.createdAtIso)) {
    return refused("organization record retiredAtIso must not precede createdAtIso");
  }
  return accepted(finishOrganizationRecord(fields, fields.retiredAtIso as string));
}

/**
 * Build the accepted record. `schemaVersion` is an own key only when it was
 * supplied, so the accepted value revalidates (an own `schemaVersion:
 * undefined` key would be refused as unsupported data on a second pass).
 */
function finishOrganizationRecord(
  fields: SnapshotFields,
  retiredAtIso: string | null,
): OrganizationRecord {
  const record: {
    schemaVersion?: 1;
    organizationId: string;
    displayName: string;
    status: OrganizationStatus;
    createdAtIso: string;
    retiredAtIso: string | null;
  } = {
    organizationId: fields.organizationId as string,
    displayName: fields.displayName as string,
    status: fields.status as OrganizationStatus,
    createdAtIso: fields.createdAtIso as string,
    retiredAtIso,
  };
  if (fields.schemaVersion === 1) {
    record.schemaVersion = 1;
  }
  return Object.freeze(record);
}

export type RetireOrganizationResult =
  | { readonly ok: true; readonly record: OrganizationRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Retire an organisation at `nowIso`. Pure: never mutates `record`, never
 * reads a clock, and no reactivation exists — retirement is one-way.
 *
 * Cost bound: O(1) — one bounded validation pass plus two timestamp parses.
 */
export function retireOrganization(
  record: OrganizationRecord,
  nowIso: string,
): RetireOrganizationResult {
  const validated = validateOrganizationRecord(record);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  if (typeof nowIso !== "string" || nowIso.length > MAX_STRING_LENGTH || !isZonedIsoDateTime(nowIso)) {
    return { ok: false, reason: "nowIso must be a zoned ISO-8601 timestamp" };
  }
  if (validated.value.status === "retired") {
    return { ok: false, reason: "organization record status is already retired" };
  }
  if (Date.parse(nowIso) < Date.parse(validated.value.createdAtIso)) {
    return { ok: false, reason: "nowIso must not precede createdAtIso" };
  }
  const retired: OrganizationRecord = Object.freeze({
    ...validated.value,
    status: "retired",
    retiredAtIso: nowIso,
  });
  return { ok: true, record: retired };
}

/**
 * Whether an organisation still accepts new work. The input is untrusted:
 * it is validated with the same bounded hostile-input guard as any other
 * record reader, so `null`, getters (never invoked), Proxies (via the
 * injected detector) and every other hostile shape return `false` instead
 * of throwing or executing attacker code.
 *
 * Cost bound: O(1) — one bounded validation pass (at most 6 keys, depth 1,
 * strings capped at 4096 characters) plus two field reads on the validated
 * snapshot.
 */
export function acceptsNewWork(org: unknown, isProxy?: IsProxy): boolean {
  const validated = validateOrganizationRecord(org, isProxy);
  if (!validated.ok) {
    return false;
  }
  return validated.value.status === "active" && validated.value.retiredAtIso === null;
}
