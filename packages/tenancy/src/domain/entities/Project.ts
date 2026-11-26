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

import type { IsProxy } from "@fleet/shared";

import {
  accepted,
  checkCommonFields,
  compareZonedIsoInstants,
  readCommonFields,
  refused,
  snapshotRecord,
  type CommonFields,
  type ValidationResult,
} from "./record-guards.js";

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

interface ProjectFields extends CommonFields {
  readonly projectId: unknown;
  readonly organizationId: unknown;
}

/**
 * Validate unknown input as a ProjectRecord; a refused value never throws.
 *
 * Cost bound: O(1) — one bounded snapshot pass (at most 7 keys, depth 1,
 * strings capped at 4096 characters) plus one pass over at most the 7
 * allowed own keys.
 */
export function validateProjectRecord(
  input: unknown,
  isProxy?: IsProxy,
): ValidationResult<ProjectRecord> {
  const snapshot = snapshotRecord("project", input, isProxy, PROJECT_ALLOWED_KEYS);
  if (!snapshot.ok) {
    return snapshot;
  }
  return validateProjectFields({
    ...readCommonFields(snapshot.value),
    projectId: snapshot.value.projectId,
    organizationId: snapshot.value.organizationId,
  });
}

/** Field-level validation shared by the project validator and the transition function. */
function validateProjectFields(fields: ProjectFields): ValidationResult<ProjectRecord> {
  const reason = checkCommonFields("project", fields, [
    ["projectId", fields.projectId],
    ["organizationId", fields.organizationId],
  ]);
  if (reason !== null) {
    return refused(reason);
  }
  return accepted(finishProjectRecord(fields, fields.retiredAtIso as string | null));
}

/**
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
