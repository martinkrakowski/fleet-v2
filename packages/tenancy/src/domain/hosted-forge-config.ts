/**
 * Validator for hosted-deployment forge configuration.
 *
 * Hosted forge configuration is untrusted input submitted through a hosted
 * API surface, so it is validated defensively: the raw value is read exactly
 * once through `snapshotPlainData` from `@fleet/shared` (zero getter or Proxy
 * trap execution), then the frozen snapshot is checked against a fixed schema.
 *
 * Personal forge credentials (a `personal-token` kind, or any key named like
 * a token, personal access token, password, or secret) are refused outright:
 * hosted deployments integrate through forge applications, never personal
 * credentials. This is a hardening and multi-org compatibility boundary; the
 * self-host installation forge configuration (`ForgeSection` /
 * `ForgeSectionV2`) is a different, trusted surface and is deliberately not
 * passed through here — this domain module must not import the installation
 * package.
 *
 * Every refusal is a typed result: nothing throws, and no rejected value or
 * raw key name is ever echoed; refusal fields come only from the fixed
 * `HostedForgeRefusalField` enum.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
} from "@fleet/shared";

/** A validated hosted forge configuration (forge-application integration). */
export interface HostedForgeConfig {
  readonly kind: "github-app";
  /** Non-empty, 1–64 chars, `/^[A-Za-z0-9_-]{1,64}$/`. */
  readonly installationId: string;
  /** Optional; 1–64 chars, `/^[A-Za-z0-9_-]{1,64}$/`. */
  readonly appId?: string;
  /** Optional; 1–39 chars, `/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/`. */
  readonly owner?: string;
  /** Optional; 1–512 chars, `https://` prefix, no credentials, no whitespace (ASCII or Unicode) or control chars. */
  readonly apiBaseUrl?: string;
}

/** Fixed enum of fields a refusal may name; key names are never echoed. */
export type HostedForgeRefusalField =
  | "kind"
  | "installationId"
  | "appId"
  | "owner"
  | "apiBaseUrl";

export type HostedForgeRefusalReason =
  | "personal-credential-refused"
  | "unsupported-forge-kind"
  | "invalid-forge-config"
  | "unknown-key"
  | "forbidden-key"
  | "proxy-detector-required";

export type HostedForgeValidationResult =
  | { readonly ok: true; readonly config: HostedForgeConfig }
  | {
      readonly ok: false;
      readonly reason: HostedForgeRefusalReason;
      readonly field?: HostedForgeRefusalField;
    };

/** Domain-sized bounds for a hosted forge config payload. */
const HOSTED_FORGE_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 8,
  maxKeys: 32,
  maxArrayLength: 64,
  maxNodes: 256,
  maxStringLength: 4096,
});

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "installationId",
  "appId",
  "owner",
  "apiBaseUrl",
]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CREDENTIAL_KEY_PATTERN = /token|pat|password|secret/i;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function refused(
  reason: HostedForgeRefusalReason,
  field?: HostedForgeRefusalField,
): HostedForgeValidationResult {
  return field === undefined ? { ok: false, reason } : { ok: false, reason, field };
}

/**
 * Map a snapshot refusal `path` to the unit's field, per the refusal table.
 * Cost bound: O(path length), bounded by the snapshot's own key/depth caps.
 */
function fieldForPath(path: string): HostedForgeRefusalField | undefined {
  const root = path.split(/[.[]/, 1)[0];
  if (
    root === "kind" ||
    root === "installationId" ||
    root === "appId" ||
    root === "owner" ||
    root === "apiBaseUrl"
  ) {
    return root;
  }
  return undefined;
}

/**
 * Walk the frozen snapshot and check every own key at the root and in any
 * nested object or array element. Cost bound: O(own keys), one enumeration
 * per visited object, bounded by the snapshot (`maxNodes: 256`, `maxKeys: 32`,
 * `maxDepth: 8`).
 */
function checkNestedKeys(
  branch: unknown,
  depth: number,
): { reason: "forbidden-key" | "personal-credential-refused" } | null {
  if (depth > HOSTED_FORGE_LIMITS.maxDepth) {
    return { reason: "forbidden-key" };
  }
  if (Array.isArray(branch)) {
    for (const item of branch) {
      if (typeof item === "object" && item !== null) {
        const nested = checkNestedKeys(item, depth + 1);
        if (nested !== null) {
          return nested;
        }
      }
    }
    return null;
  }
  if (typeof branch !== "object" || branch === null) {
    return null;
  }
  for (const key of Reflect.ownKeys(branch)) {
    if (typeof key !== "string") {
      continue;
    }
    if (FORBIDDEN_KEYS.has(key)) {
      return { reason: "forbidden-key" };
    }
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      return { reason: "personal-credential-refused" };
    }
    const child = (branch as Record<string, unknown>)[key];
    if (typeof child === "object" && child !== null) {
      const nested = checkNestedKeys(child, depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isValidOwner(value: unknown): value is string {
  return typeof value === "string" && OWNER_PATTERN.test(value);
}

function isValidApiBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return false;
  }
  if (!value.startsWith("https://")) {
    return false;
  }
  // Reject embedded `username:password@` credentials and any whitespace or
  // control character. The code-point scan covers ASCII whitespace/controls,
  // DEL, and C1 controls; the `\p{White_Space}` check covers Unicode
  // whitespace (e.g. U+00A0). One scan each, O(n) with n bounded by the
  // 512-char limit.
  if (/[\p{White_Space}]/u.test(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7e && code <= 0x9f)) {
      return false;
    }
  }
  const afterScheme = value.slice("https://".length);
  const at = afterScheme.indexOf("@");
  if (at !== -1) {
    return false;
  }
  return true;
}

/**
 * Validate untrusted hosted forge configuration input. `isProxy` is always a
 * separate positional parameter (never a field of an options object);
 * infrastructure callers pass `types.isProxy`.
 */
export function validateHostedForgeConfig(
  raw: unknown,
  isProxy?: IsProxy,
): HostedForgeValidationResult {
  if (isProxy !== undefined && typeof isProxy !== "function") {
    return refused("proxy-detector-required");
  }
  // Read the untrusted value exactly once: zero getter or Proxy trap
  // execution, bounded by `HOSTED_FORGE_LIMITS`.
  const snapshot = snapshotPlainData(raw, isProxy ?? (() => false), HOSTED_FORGE_LIMITS);
  if (!snapshot.ok) {
    const field = snapshot.path === null ? undefined : fieldForPath(snapshot.path);
    return refused("invalid-forge-config", field);
  }
  const value = snapshot.value;
  // The snapshot copies an own `__proto__` key as data, so check the root
  // type explicitly: a non-null, non-array plain object is required.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refused("invalid-forge-config");
  }
  const record = value as Record<string, unknown>;
  const keyCheck = checkNestedKeys(record, 0);
  if (keyCheck !== null) {
    return refused(keyCheck.reason);
  }
  const kind = record.kind;
  if (kind === "personal-token") {
    return refused("personal-credential-refused", "kind");
  }
  if (kind !== "github-app") {
    return refused("unsupported-forge-kind", "kind");
  }
  // One pass over the root's own keys: any key outside the allowed set is
  // refused without echoing the key name or value.
  for (const key of Reflect.ownKeys(record)) {
    if (!ALLOWED_KEYS.has(key as string)) {
      return refused("unknown-key");
    }
  }
  const installationId = record.installationId;
  if (!isValidId(installationId)) {
    return refused("invalid-forge-config", "installationId");
  }
  const config: {
    kind: "github-app";
    installationId: string;
    appId?: string;
    owner?: string;
    apiBaseUrl?: string;
  } = { kind: "github-app", installationId };
  if (Object.prototype.hasOwnProperty.call(record, "appId")) {
    if (!isValidId(record.appId)) {
      return refused("invalid-forge-config", "appId");
    }
    config.appId = record.appId;
  }
  if (Object.prototype.hasOwnProperty.call(record, "owner")) {
    if (!isValidOwner(record.owner)) {
      return refused("invalid-forge-config", "owner");
    }
    config.owner = record.owner;
  }
  if (Object.prototype.hasOwnProperty.call(record, "apiBaseUrl")) {
    if (!isValidApiBaseUrl(record.apiBaseUrl)) {
      return refused("invalid-forge-config", "apiBaseUrl");
    }
    config.apiBaseUrl = record.apiBaseUrl;
  }
  return { ok: true, config: Object.freeze(config) };
}
