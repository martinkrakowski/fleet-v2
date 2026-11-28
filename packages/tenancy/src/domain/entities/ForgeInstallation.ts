/**
 * ForgeInstallation: one forge installation's record for one organization.
 * Pure domain code: no Node, filesystem, subprocess, network or vendor
 * imports; every timestamp is passed in, never read from a clock.
 *
 * Hostile-input posture: `parseForgeInstallationRecord` treats its input as
 * untrusted. null, undefined, wrong primitives, arrays, array-likes,
 * non-plain prototypes, symbol keys, getters/setters (never read),
 * detectable Proxies (via the injected detector, never through reflection
 * traps), sparse arrays, oversized strings and prototype-polluting own keys
 * are each refused with a typed `{ ok: false, reason }` result, never a
 * throw and never a pass. Every input is copied ONCE by `snapshotPlainData`
 * (through its own data descriptors, so no getter and no Proxy `get` trap
 * ever runs and no value can change between check and use); only the frozen
 * snapshot is validated. No rejected value is ever echoed into a refusal.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  checkSnapshotKeys,
  hasControlCharacter,
  isZonedIsoDateTime,
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  type RecordRefusal,
} from "./record-guards.js";

/** An installation's repository list is bounded. */
export const MAX_FORGE_INSTALLATION_REPOSITORIES = 500;

export const FORGE_INSTALLATION_STATUSES = [
  "active",
  "suspended",
  "removed",
] as const;

export type ForgeInstallationStatus = (typeof FORGE_INSTALLATION_STATUSES)[number];

export interface ForgeInstallationRecord {
  readonly schemaVersion?: 1;
  /** Length 1..64, `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`. */
  readonly installationId: string;
  readonly organizationId: string;
  readonly forge: "github";
  readonly repositories: readonly string[];
  readonly installedAtIso: string;
  readonly status: ForgeInstallationStatus;
}

/** The only own keys a ForgeInstallationRecord may carry. */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "installationId",
  "organizationId",
  "forge",
  "repositories",
  "installedAtIso",
  "status",
]);

/** One `owner/name` repository slug: neither segment is `.` or `..`. */
const REPOSITORY_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** A repository slug's total length bounds. */
const MIN_REPOSITORY_LENGTH = 3;
const MAX_REPOSITORY_LENGTH = 200;

/** An installation id: length 1..64, first character alphanumeric. */
const INSTALLATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type ForgeInstallationParseRefusalReason =
  | "proxy-detector-required"
  | "detector-threw"
  | "proxy"
  | "getter-not-allowed"
  | "invalid-record"
  | "forbidden-key"
  | "unknown-key"
  | "invalid-schema-version"
  | "invalid-installation-id"
  | "invalid-organization-id"
  | "invalid-forge"
  | "invalid-repositories"
  | "invalid-installed-at"
  | "invalid-status";

export type ParseForgeInstallationRecordResult =
  | { readonly ok: true; readonly record: ForgeInstallationRecord }
  | { readonly ok: false; readonly reason: ForgeInstallationParseRefusalReason };

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

/**
 * Map a snapshot refusal path to this module's typed reason. The special
 * hostile reasons (detector, Proxy, accessor, symbol key) map regardless of
 * path; every other refusal names the field it was found on, or the root.
 *
 * Cost bound: O(1) — a fixed number of reason and path comparisons.
 */
function mapSnapshotRefusal(
  reason: string,
  path: string | null,
): ForgeInstallationParseRefusalReason {
  switch (reason) {
    case "detector-threw":
    case "invalid-limits":
      return "detector-threw";
    case "proxy":
      return "proxy";
    case "accessor":
      return "getter-not-allowed";
    case "symbol-key":
      return "invalid-record";
  }
  if (path === "schemaVersion") return "invalid-schema-version";
  if (path === "installationId") return "invalid-installation-id";
  if (path === "organizationId") return "invalid-organization-id";
  if (path === "forge") return "invalid-forge";
  if (path === "repositories" || path?.startsWith("repositories[")) {
    return "invalid-repositories";
  }
  if (path === "installedAtIso") return "invalid-installed-at";
  if (path === "status") return "invalid-status";
  return "invalid-record";
}

/** Map a `checkSnapshotKeys` refusal to this module's typed reason. */
function mapKeyRefusal(refusal: RecordRefusal): ForgeInstallationParseRefusalReason {
  switch (refusal.kind) {
    case "forbidden-key":
      return "forbidden-key";
    case "symbol-key":
      return "invalid-record";
    default:
      // `unknown-key` and `too-many-keys`; the key text is never echoed.
      return "unknown-key";
  }
}

/**
 * Validate one repository slug from the frozen snapshot: a string of 3..200
 * characters matching `owner/name` with neither segment `.` or `..` and no
 * control character. Cost bound: O(1) — bounded pattern tests over a string
 * of at most 200 characters (the snapshot cap is 4096, so the scan here is
 * over the string the snapshot already copied).
 */
function isValidRepositorySlug(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < MIN_REPOSITORY_LENGTH || value.length > MAX_REPOSITORY_LENGTH) {
    return false;
  }
  if (hasControlCharacter(value)) return false;
  if (!REPOSITORY_PATTERN.test(value)) return false;
  const slash = value.indexOf("/");
  return value.slice(0, slash) !== "." && value.slice(0, slash) !== ".."
    && value.slice(slash + 1) !== "." && value.slice(slash + 1) !== "..";
}

/**
 * Validate the `repositories` field of a frozen snapshot: a dense array of
 * at most 500 unique, valid `owner/name` slugs. Returns the frozen copy, or
 * null when the field is refused. Cost bound: O(m) over at most
 * `MAX_FORGE_INSTALLATION_REPOSITORIES` items, each validated in O(1) over
 * a string of at most 200 characters.
 */
function parseRepositories(value: unknown):
  | { readonly ok: true; readonly repositories: readonly string[] }
  | { readonly ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (!isValidRepositorySlug(item)) return { ok: false };
    if (seen.has(item)) return { ok: false };
    seen.add(item);
  }
  return { ok: true, repositories: Object.freeze([...seen]) };
}

/**
 * Parse unknown input as a ForgeInstallationRecord; a refused value never
 * throws and is never echoed. The input is snapshotted ONCE with fixed,
 * frozen bounds (depth 2, at most 8 own keys, at most 500 array items, at
 * most 509 nodes, strings capped at 4096 characters), the snapshot's own
 * keys are checked against the 7 allowed keys, and every field is validated
 * on the frozen snapshot only. The returned record and its repositories
 * array are frozen.
 *
 * Cost bound: O(m) where m <= 500 is `repositories.length` — one bounded
 * depth-2 snapshot pass of at most 509 nodes, one own-key check over at
 * most 8 keys, and one pass over at most 500 repository strings of length
 * at most 200.
 */
export function parseForgeInstallationRecord(
  raw: unknown,
  isProxy?: IsProxy,
): ParseForgeInstallationRecordResult {
  const detector = isProxy === undefined ? NO_DETECTOR : isProxy;
  if (typeof detector !== "function") {
    return { ok: false, reason: "proxy-detector-required" };
  }
  const snapshot = snapshotPlainData(raw, detector, {
    maxDepth: 2,
    maxKeys: ALLOWED_KEYS.size + 1,
    maxArrayLength: MAX_FORGE_INSTALLATION_REPOSITORIES,
    maxNodes: MAX_FORGE_INSTALLATION_REPOSITORIES + 9,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    return { ok: false, reason: mapSnapshotRefusal(snapshot.reason, snapshot.path) };
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "invalid-record" };
  }
  const record = value as Record<string, unknown>;
  const keyRefusal = checkSnapshotKeys(record, ALLOWED_KEYS);
  if (keyRefusal !== null) {
    return { ok: false, reason: mapKeyRefusal(keyRefusal) };
  }
  if (Object.hasOwn(record, "schemaVersion") && record.schemaVersion !== 1) {
    return { ok: false, reason: "invalid-schema-version" };
  }
  const installationId = record.installationId;
  if (typeof installationId !== "string" || !INSTALLATION_ID_PATTERN.test(installationId)) {
    return { ok: false, reason: "invalid-installation-id" };
  }
  const organizationId = record.organizationId;
  if (typeof organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(organizationId)) {
    return { ok: false, reason: "invalid-organization-id" };
  }
  if (record.forge !== "github") {
    return { ok: false, reason: "invalid-forge" };
  }
  const repositories = parseRepositories(record.repositories);
  if (!repositories.ok) {
    return { ok: false, reason: "invalid-repositories" };
  }
  const installedAtIso = record.installedAtIso;
  if (
    typeof installedAtIso !== "string"
    || installedAtIso.length > 64
    || !isZonedIsoDateTime(installedAtIso)
  ) {
    return { ok: false, reason: "invalid-installed-at" };
  }
  const status = record.status;
  if (
    status !== "active"
    && status !== "suspended"
    && status !== "removed"
  ) {
    return { ok: false, reason: "invalid-status" };
  }
  const parsed: {
    schemaVersion?: 1;
    installationId: string;
    organizationId: string;
    forge: "github";
    repositories: readonly string[];
    installedAtIso: string;
    status: ForgeInstallationStatus;
  } = {
    installationId,
    organizationId,
    forge: "github",
    repositories: repositories.repositories,
    installedAtIso,
    status,
  };
  if (Object.hasOwn(record, "schemaVersion")) {
    parsed.schemaVersion = 1;
  }
  return { ok: true, record: Object.freeze(parsed) };
}
