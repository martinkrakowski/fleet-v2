/**
 * Pure hosted-record default-organisation reader (Plan FC-3.8).
 *
 * Pure domain code: no Node, filesystem, subprocess, network or vendor
 * imports; no clock reads; no randomness. Every refusal is a typed result —
 * the function never throws and never echoes a rejected input value.
 *
 * Hostile-input rule: every public function refuses null, undefined, wrong
 * primitives, array holes, accessors (never run — read through property
 * descriptors by the snapshot), Proxies (via the required injected
 * `isProxy` detector), array-likes, oversized lengths and
 * prototype-polluting own keys, each with a typed result, never a pass.
 *
 * Cost bound: O(1) — one bounded `snapshotPlainData` pass under
 * `DEFAULT_PLAIN_DATA_LIMITS` (`maxDepth: 16`, `maxKeys: 128`,
 * `maxArrayLength: 1024`, `maxNodes: 4096`, `maxStringLength: 16_384`),
 * one `Reflect.ownKeys` pass over at most 128 keys, and one bounded regex
 * check on at most 64 characters.
 */
import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import { DEFAULT_ORGANIZATION_ID } from "./entities/Organization.js";
import { ORGANIZATION_ID_PATTERN } from "./entities/record-guards.js";

/** The highest hosted-record schema version this reader understands. */
export const HOSTED_RECORD_SUPPORTED_SCHEMA_VERSION = 1 as const;

export type HostedRecordOrgRefusalReason =
  | "invalid-input"
  | "unknown-schema-version"
  | "invalid-schema-version"
  | "invalid-organization-id";

export type HostedRecordOrgResult =
  | { readonly ok: true; readonly organizationId: string; readonly defaulted: boolean }
  | { readonly ok: false; readonly reason: HostedRecordOrgRefusalReason };

/** Own-property names refused outright, screened on the snapshotted copy. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "length",
]);

const MAX_ORGANIZATION_ID_LENGTH = 64;

/**
 * Read the organisation of an unknown hosted-record value without running a
 * single getter or Proxy trap. A record without `organizationId` reads as
 * `DEFAULT_ORGANIZATION_ID`; a present `organizationId` must match
 * `ORGANIZATION_ID_PATTERN`; `null` or a wrong-type `organizationId` is
 * refused; and a `schemaVersion` above
 * `HOSTED_RECORD_SUPPORTED_SCHEMA_VERSION` is refused as
 * `unknown-schema-version` (never a best-effort default).
 *
 * `isProxy` is a required positional parameter with no default value and no
 * fallback detector: the caller (infrastructure) always passes the trusted
 * `types.isProxy` predicate.
 */
export function readHostedRecordOrg(raw: unknown, isProxy: IsProxy): HostedRecordOrgResult {
  const snapshot = snapshotPlainData(raw, isProxy);
  if (!snapshot.ok) {
    return { ok: false, reason: "invalid-input" };
  }
  const value: unknown = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "invalid-input" };
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key === "string" && FORBIDDEN_KEYS.has(key)) {
      return { ok: false, reason: "invalid-input" };
    }
  }
  if (Object.hasOwn(record, "schemaVersion")) {
    const schemaVersion: unknown = record.schemaVersion;
    if (
      typeof schemaVersion !== "number" ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1
    ) {
      return { ok: false, reason: "invalid-schema-version" };
    }
    if (schemaVersion > HOSTED_RECORD_SUPPORTED_SCHEMA_VERSION) {
      return { ok: false, reason: "unknown-schema-version" };
    }
  }
  if (!Object.hasOwn(record, "organizationId")) {
    return { ok: true, organizationId: DEFAULT_ORGANIZATION_ID, defaulted: true };
  }
  const organizationId: unknown = record.organizationId;
  if (
    typeof organizationId !== "string" ||
    organizationId.length === 0 ||
    organizationId.length > MAX_ORGANIZATION_ID_LENGTH ||
    !ORGANIZATION_ID_PATTERN.test(organizationId)
  ) {
    return { ok: false, reason: "invalid-organization-id" };
  }
  return { ok: true, organizationId, defaulted: false };
}
