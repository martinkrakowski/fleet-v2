/**
 * ForgeInstallation: one forge App installation scoped to one organisation,
 * with the bounded list of repositories it may act on. Pure domain code: no
 * Node, filesystem, subprocess, network or vendor imports; every instant
 * (installedAtIso) is an input, never read from a clock.
 *
 * Hostile-input posture: `parseForgeInstallationRecord` treats its input as
 * untrusted. null, undefined, wrong primitives, arrays (where an object is
 * required), array-likes, non-plain prototypes, sparse arrays, getters
 * (inspected via property descriptors, never invoked), detectable Proxies
 * (via the injected detector, whose traps never run), oversized strings and
 * lists, and prototype-polluting own keys are each refused with a typed
 * `{ ok: false, reason }` result, never a throw and never a pass. A
 * rejected value is never echoed into a reason.
 *
 * The proxy detector is a REQUIRED second positional parameter (never a
 * field of an options object: the snapshot refuses function values, so an
 * options object carrying a function cannot be snapshotted). Because only
 * the caller can know what counts as a Proxy for the values it passes, an
 * absent detector is never silently replaced by one that detects nothing:
 * when the detector is omitted (undefined) or supplied but not a function
 * the parse is refused (`proxy-detector-required`) without reading the
 * input; a detector that throws is refused (`detector-threw`).
 *
 * The input is copied ONCE by `snapshotPlainData` through its own data
 * descriptors, so no getter and no Proxy `get` trap ever runs and no value
 * can change between check and use; only the frozen snapshot is validated.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  checkSnapshotKeys,
  hasControlCharacter,
  isZonedIsoDateTime,
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
} from "./record-guards.js";

/** An installation's repository list is bounded. */
export const MAX_FORGE_INSTALLATION_REPOSITORIES = 500;

/** The lifecycle statuses an installation record may carry. */
export const FORGE_INSTALLATION_STATUSES = [
  "active",
  "suspended",
  "removed",
] as const;

export type ForgeInstallationStatus = (typeof FORGE_INSTALLATION_STATUSES)[number];

export interface ForgeInstallationRecord {
  readonly schemaVersion?: 1;
  /** Length 1..64, alphanumerics, dashes and underscores, starting alphanumeric. */
  readonly installationId: string;
  /** Matches ORGANIZATION_ID_PATTERN. */
  readonly organizationId: string;
  /** The only forge this record version speaks of. */
  readonly forge: "github";
  /** `owner/name` repository slugs, at most MAX_FORGE_INSTALLATION_REPOSITORIES, unique. */
  readonly repositories: readonly string[];
  /** A zoned, calendar-valid ISO-8601 timestamp, at most 64 characters. */
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

const INSTALLATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const REPOSITORY_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/**
 * Why `parseForgeInstallationRecord` refused: the exact, typed union of
 * reasons mapped from the snapshot refusal and the field checks. A rejected
 * value is never echoed into any reason.
 */
export type ForgeInstallationParseRefusalReason =
  | "proxy-detector-required"
  | "detector-threw"
  | "proxy"
  | "getter-not-allowed"
  | "forbidden-key"
  | "unknown-key"
  | "invalid-schema-version"
  | "invalid-installation-id"
  | "invalid-organization-id"
  | "invalid-forge"
  | "invalid-repositories"
  | "invalid-installed-at"
  | "invalid-status"
  | "invalid-record";

export type ParseForgeInstallationRecordResult =
  | { readonly ok: true; readonly record: ForgeInstallationRecord }
  | { readonly ok: false; readonly reason: ForgeInstallationParseRefusalReason };

/**
 * Map one snapshot refusal to this module's typed reason, using the refusal
 * path: a top-level path names an allowed field (so a field-named refusal
 * keeps the field-specific reason) and a `repositories[i]` path is a
 * repository-list refusal. The offending value itself is never echoed.
 *
 * Cost bound: O(1) — a fixed number of string comparisons on a bounded
 * path string.
 */
function mapSnapshotRefusal(
  reason: string,
  path: string | null,
): ForgeInstallationParseRefusalReason {
  switch (reason) {
    case "detector-threw":
      return "detector-threw";
    // `invalid-limits` is how the snapshot reports a detector that throws
    // while screening its own (fixed, valid) limits argument.
    case "invalid-limits":
      return "detector-threw";
    case "proxy":
      return "proxy";
    case "accessor":
      return "getter-not-allowed";
    case "symbol-key":
      return "invalid-record";
    default:
      break;
  }
  switch (path) {
    case "schemaVersion":
      return "invalid-schema-version";
    case "installationId":
      return "invalid-installation-id";
    case "organizationId":
      return "invalid-organization-id";
    case "forge":
      return "invalid-forge";
    case "installedAtIso":
      return "invalid-installed-at";
    case "status":
      return "invalid-status";
    default:
      break;
  }
  if (path === "repositories" || (path !== null && path.startsWith("repositories["))) {
    return "invalid-repositories";
  }
  return "invalid-record";
}

/**
 * Validate the fields of an already-snapshotted record (a frozen copy every
 * field was read from exactly once). Returns the field-specific refusal
 * reason, or null.
 *
 * Cost bound: O(m) where m <= 500 is `repositories.length` — a fixed
 * number of field checks plus one pass over at most 500 repository strings
 * of length <= 200 each (pattern test, segment check, control-character
 * scan and one Set insert each).
 */
function checkRecordFields(
  snapshot: Record<string, unknown>,
): { ok: true } | { ok: false; reason: ForgeInstallationParseRefusalReason } {
  if (Object.hasOwn(snapshot, "schemaVersion") && snapshot.schemaVersion !== 1) {
    return { ok: false, reason: "invalid-schema-version" };
  }
  const installationId = snapshot.installationId;
  if (
    typeof installationId !== "string" ||
    installationId.length < 1 ||
    installationId.length > 64 ||
    !INSTALLATION_ID_PATTERN.test(installationId)
  ) {
    return { ok: false, reason: "invalid-installation-id" };
  }
  const organizationId = snapshot.organizationId;
  if (typeof organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(organizationId)) {
    return { ok: false, reason: "invalid-organization-id" };
  }
  if (snapshot.forge !== "github") {
    return { ok: false, reason: "invalid-forge" };
  }
  const repositories = snapshot.repositories;
  if (!Array.isArray(repositories) || repositories.length > MAX_FORGE_INSTALLATION_REPOSITORIES) {
    return { ok: false, reason: "invalid-repositories" };
  }
  const seen = new Set<string>();
  for (const entry of repositories as unknown[]) {
    if (
      typeof entry !== "string" ||
      entry.length < 3 ||
      entry.length > 200 ||
      !REPOSITORY_PATTERN.test(entry) ||
      hasControlCharacter(entry)
    ) {
      return { ok: false, reason: "invalid-repositories" };
    }
    const slash = entry.indexOf("/");
    const owner = entry.slice(0, slash);
    const name = entry.slice(slash + 1);
    if (owner === "." || owner === ".." || name === "." || name === "..") {
      return { ok: false, reason: "invalid-repositories" };
    }
    if (seen.has(entry)) {
      return { ok: false, reason: "invalid-repositories" };
    }
    seen.add(entry);
  }
  if (typeof snapshot.installedAtIso !== "string" || snapshot.installedAtIso.length > 64) {
    return { ok: false, reason: "invalid-installed-at" };
  }
  if (!isZonedIsoDateTime(snapshot.installedAtIso)) {
    return { ok: false, reason: "invalid-installed-at" };
  }
  const status = snapshot.status;
  if (
    status !== "active" &&
    status !== "suspended" &&
    status !== "removed"
  ) {
    return { ok: false, reason: "invalid-status" };
  }
  return { ok: true };
}

/**
 * Parse unknown input as a ForgeInstallationRecord; a refused value never
 * throws. See the module doc for the hostile-input posture.
 *
 * Cost bound: O(m) where m <= 500 is `repositories.length` — one bounded
 * depth-2 snapshot pass of at most 509 nodes (1 root + up to 7 fields + up
 * to 500 items + 1 extra key), one own-key check over at most 8 keys, and
 * one pass over at most 500 repository strings of length at most 200.
 */
export function parseForgeInstallationRecord(
  raw: unknown,
  isProxy?: IsProxy,
): ParseForgeInstallationRecordResult {
  // The detector is validated before anything else touches the input.
  // An absent detector is a refusal, not a no-op default: without a trusted
  // detector a Proxy mirroring a valid record could run its reflection
  // traps during parsing and be accepted.
  if (isProxy === undefined || typeof isProxy !== "function") {
    return { ok: false, reason: "proxy-detector-required" };
  }
  const snapshot = snapshotPlainData(raw, isProxy, {
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
    switch (keyRefusal.kind) {
      case "forbidden-key":
        return { ok: false, reason: "forbidden-key" };
      case "symbol-key":
        return { ok: false, reason: "invalid-record" };
      default:
        return { ok: false, reason: "unknown-key" };
    }
  }
  const fields = checkRecordFields(record);
  if (!fields.ok) {
    return { ok: false, reason: fields.reason };
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
    installationId: record.installationId as string,
    organizationId: record.organizationId as string,
    forge: "github",
    repositories: Object.freeze([...(record.repositories as string[])]),
    installedAtIso: record.installedAtIso as string,
    status: record.status as ForgeInstallationStatus,
  };
  if (Object.hasOwn(record, "schemaVersion")) {
    parsed.schemaVersion = 1;
  }
  return { ok: true, record: Object.freeze(parsed) };
}
