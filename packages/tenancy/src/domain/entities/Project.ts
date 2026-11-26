/**
 * Project: a named unit of work inside one organisation. Pure domain code:
 * no Node, filesystem, subprocess, network or vendor imports; every
 * timestamp is passed in, never read from a clock.
 *
 * Hostile-input posture: identical to Organization — null, undefined,
 * non-objects, arrays, array-likes, non-plain prototypes, getters/setters
 * (never read), Proxies (via the injected detector), sparse arrays,
 * oversized strings and prototype-polluting own keys are each refused with
 * a typed result, never a throw and never a pass.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";
import {
  accepted,
  compareZonedIsoInstants,
  isZonedIsoDateTime,
  ORGANIZATION_ID_PATTERN,
  refused,
  type ValidationResult,
} from "./Organization.js";

export type ProjectStatus = "active" | "retired";

export interface ProjectRecord {
  readonly schemaVersion?: 1;
  readonly projectId: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly status: ProjectStatus;
  readonly createdAtIso: string;
  readonly retiredAtIso: string | null;
}

/** The only own keys a ProjectRecord may carry. */
const PROJECT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "organizationId",
  "displayName",
  "status",
  "createdAtIso",
  "retiredAtIso",
]);

const MAX_STRING_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 120;
// Control characters are refused anywhere in a display name. Scanned by
// character code instead of a regex; the length check below bounds the scan
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

/**
 * Validate unknown input as a ProjectRecord; a refused value never throws.
 *
 * Cost bound: O(1) — one bounded snapshot pass (at most 7 keys, depth 1,
 * strings capped at 4096 characters) plus one pass over at most the 7
 * allowed own keys, refusing before iterating when the own-key count exceeds
 * the allowed key set.
 */
export function validateProjectRecord(
  input: unknown,
  isProxy?: IsProxy,
): ValidationResult<ProjectRecord> {
  const snapshot = snapshotPlainData(
    input,
    isProxy ?? (() => false),
    { maxDepth: 1, maxKeys: 7, maxStringLength: MAX_STRING_LENGTH },
  );
  if (!snapshot.ok) {
    return refused(projectSnapshotRefusal(snapshot.reason, snapshot.path, PROJECT_ALLOWED_KEYS));
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refused("project record must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  // Refuse before iterating when the shape is already wrong.
  if (ownKeys.length > PROJECT_ALLOWED_KEYS.size) {
    return refused("project record has too many own keys");
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return refused("project record has a symbol own key");
    }
    if (key === "__proto__" || key === "constructor") {
      return refused(`project record has the prototype-polluting key ${key}`);
    }
    if (!PROJECT_ALLOWED_KEYS.has(key)) {
      // The unknown key text is never echoed.
      return refused("project record has an extra unknown key");
    }
    if (key === "__proto__" || key === "constructor") {
      return refused(`project record has the prototype-polluting key ${key}`);
    }
  }
  return validateProjectFields({
    schemaVersion: record.schemaVersion,
    schemaVersionPresent: Object.hasOwn(record, "schemaVersion"),
    projectId: record.projectId,
    organizationId: record.organizationId,
    displayName: record.displayName,
    status: record.status,
    createdAtIso: record.createdAtIso,
    retiredAtIso: record.retiredAtIso,
  });
}

function projectSnapshotRefusal(
  reason: string,
  path: string | null,
  allowedKeys: ReadonlySet<string>,
): string {
  // A `too-long` refusal at a top-level field carries that field's own name
  // as the path; echoing it is safe because it must equal an allowed key
  // exactly, and the oversized string itself is never echoed.
  if (reason === "too-long" && path !== null && allowedKeys.has(path)) {
    return `project record ${path} is an oversized string`;
  }
  switch (reason) {
    case "proxy":
      return "project record must be a plain object, not a Proxy";
    case "accessor":
      // An accessor refusal carries the property path; a top-level path must
      // equal an allowed key exactly, so naming the field is safe and the
      // property value is never echoed.
      if (path !== null && allowedKeys.has(path)) {
        return `project record ${path} has a getter or setter property`;
      }
      return "project record has a getter or setter property";
    case "not-plain":
      return "project record must be a plain object";
    case "not-enumerable":
      if (path !== null && allowedKeys.has(path)) {
        return `project record ${path} is a non-enumerable property`;
      }
      return "project record has a non-enumerable property";
    case "symbol-key":
      return "project record has a symbol own key";
    case "sparse-array":
      return "project record must be a plain object, not a sparse array";
    case "too-many-keys":
      return "project record has too many own keys";
    case "too-long":
      return "project record has an oversized string";
    case "unsupported-type":
      if (path !== null && allowedKeys.has(path)) {
        return `project record ${path} has an unsupported value type`;
      }
      return "project record must be a plain object";
    case "hostile":
      return "project record is a hostile runtime value";
    default:
      return `project record is not plain data (${reason})`;
  }
}

interface ProjectFields {
  readonly schemaVersion: unknown;
  readonly schemaVersionPresent: boolean;
  readonly projectId: unknown;
  readonly organizationId: unknown;
  readonly displayName: unknown;
  readonly status: unknown;
  readonly createdAtIso: unknown;
  readonly retiredAtIso: unknown;
}

/** Field-level validation shared by the project validator and the transition function. */
function validateProjectFields(fields: ProjectFields): ValidationResult<ProjectRecord> {
  if (fields.schemaVersionPresent && fields.schemaVersion !== 1) {
    return refused("project record schemaVersion must be 1 when present");
  }
  if (typeof fields.projectId !== "string" || !ORGANIZATION_ID_PATTERN.test(fields.projectId)) {
    return refused("project record projectId must match the organization id pattern");
  }
  if (
    typeof fields.organizationId !== "string"
    || !ORGANIZATION_ID_PATTERN.test(fields.organizationId)
  ) {
    return refused("project record organizationId must match the organization id pattern");
  }
  if (typeof fields.displayName !== "string") {
    return refused("project record displayName must be a string");
  }
  if (fields.displayName.length < 1 || fields.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return refused(`project record displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  if (hasControlCharacter(fields.displayName)) {
    return refused("project record displayName must not contain control characters");
  }
  if (fields.status !== "active" && fields.status !== "retired") {
    return refused("project record status must be active or retired");
  }
  if (!isZonedIsoDateTime(fields.createdAtIso)) {
    return refused("project record createdAtIso must be a zoned ISO-8601 timestamp");
  }
  if (fields.retiredAtIso === null) {
    if (fields.status === "retired") {
      return refused("project record retiredAtIso must be set when status is retired");
    }
    return accepted(finishProjectRecord(fields, null));
  }
  if (!isZonedIsoDateTime(fields.retiredAtIso)) {
    return refused("project record retiredAtIso must be null or a zoned ISO-8601 timestamp");
  }
  if (fields.status === "active") {
    return refused("project record retiredAtIso must be null when status is active");
  }
  if (compareZonedIsoInstants(fields.retiredAtIso, fields.createdAtIso) < 0) {
    return refused("project record retiredAtIso must not precede createdAtIso");
  }
  return accepted(finishProjectRecord(fields, fields.retiredAtIso as string));
}

/**
 * Build the accepted record. `schemaVersion` is an own key only when it was
 * supplied, so the accepted value revalidates (an own `schemaVersion:
 * undefined` key would be refused as unsupported data on a second pass).
 */
function finishProjectRecord(
  fields: ProjectFields,
  retiredAtIso: string | null,
): ProjectRecord {
  const record: {
    schemaVersion?: 1;
    projectId: string;
    organizationId: string;
    displayName: string;
    status: ProjectStatus;
    createdAtIso: string;
    retiredAtIso: string | null;
  } = {
    projectId: fields.projectId as string,
    organizationId: fields.organizationId as string,
    displayName: fields.displayName as string,
    status: fields.status as ProjectStatus,
    createdAtIso: fields.createdAtIso as string,
    retiredAtIso,
  };
  if (fields.schemaVersion === 1) {
    record.schemaVersion = 1;
  }
  return Object.freeze(record);
}

/**
 * Decide whether `next` may replace `current`. Pure: validates both records,
 * refuses any change of the immutable fields (`projectId`, `organizationId`,
 * `createdAtIso`) and refuses reactivating a retired project.
 *
 * Cost bound: O(1) — two bounded validation passes plus three equality
 * comparisons.
 */
export function decideProjectTransition(
  current: unknown,
  next: unknown,
): ValidationResult<ProjectRecord> {
  const from = validateProjectRecord(current);
  if (!from.ok) {
    return refused(`current ${from.reason}`);
  }
  const to = validateProjectRecord(next);
  if (!to.ok) {
    return refused(`next ${to.reason}`);
  }
  if (from.value.projectId !== to.value.projectId) {
    return refused("projectId is immutable");
  }
  if (from.value.organizationId !== to.value.organizationId) {
    return refused("organizationId is immutable");
  }
  if (from.value.createdAtIso !== to.value.createdAtIso) {
    return refused("createdAtIso is immutable");
  }
  if (from.value.status === "retired" && to.value.status === "active") {
    return refused("status cannot transition from retired back to active");
  }
  if (to.value.status === "retired") {
    if (to.value.retiredAtIso === null) {
      return refused("retiredAtIso must be set when status is retired");
    }
    if (compareZonedIsoInstants(to.value.retiredAtIso, to.value.createdAtIso) < 0) {
      return refused("retiredAtIso must not precede createdAtIso");
    }
  }
  return accepted(to.value);
}
