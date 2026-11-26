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

import type { IsProxy } from "@fleet/shared";

import {
  accepted,
  checkCommonFields,
  compareZonedIsoInstants,
  isZonedIsoDateTime,
  MAX_STRING_LENGTH,
  readCommonFields,
  refused,
  snapshotRecord,
  type CommonFields,
  type ValidationResult,
} from "./record-guards.js";

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

interface SnapshotFields extends CommonFields {
  readonly organizationId: unknown;
}

/**
 * Validate unknown input as an OrganizationRecord; a refused value never
 * throws.
 *
 * Cost bound: O(1) — one bounded snapshot pass (at most 6 keys, depth 1,
 * strings capped at 4096 characters) plus one pass over at most the 6
 * allowed own keys.
 */
export function validateOrganizationRecord(
  input: unknown,
  isProxy?: IsProxy,
): ValidationResult<OrganizationRecord> {
  const snapshot = snapshotRecord("organization", input, isProxy, ORGANIZATION_ALLOWED_KEYS);
  if (!snapshot.ok) {
    return snapshot;
  }
  return validateOrganizationFields({
    ...readCommonFields(snapshot.value),
    organizationId: snapshot.value.organizationId,
  });
}

/** Field-level validation shared by the organization validator and retire. */
function validateOrganizationFields(fields: SnapshotFields): ValidationResult<OrganizationRecord> {
  const reason = checkCommonFields("organization", fields, [
    ["organizationId", fields.organizationId],
  ]);
  if (reason !== null) {
    return refused(reason);
  }
  return accepted(finishOrganizationRecord(fields, fields.retiredAtIso as string | null));
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
  if (compareZonedIsoInstants(nowIso, validated.value.createdAtIso) < 0) {
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
