/**
 * InstallationTokenBrokerPort: outbound port for issuing one short-lived,
 * scope-pinned GitHub App installation token for one forge action. The port is
 * defined before any adapter exists: the shared in-memory fake under
 * `__tests__` is the only implementation, and the shared contract suite pins
 * its semantics so a later real adapter cannot drift from the fake.
 *
 * The App's private key never appears in any request, result or exported type;
 * the port speaks only in scope descriptors and opaque branded tokens.
 *
 * Every request is untrusted input: it is read once through
 * `snapshotPlainData` from `@fleet/shared` (no getter ever runs, no Proxy trap
 * ever fires), then validated against the exact key set on the frozen
 * snapshot. Every failure is a typed result, never a throw and never a
 * guessed state.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
} from '@fleet/shared';

/** The longest TTL an installation token may request (60 minutes). */
export const MAX_INSTALLATION_TOKEN_TTL_SECONDS = 3600 as const;

/** The longest any single broker string field may be (mirrors FC7A). */
export const FORGE_CREDENTIAL_MAX_STRING_LENGTH = 300 as const;

/** The exact permission set an installation token may carry (mirrors FC7A). */
export const FORGE_CREDENTIAL_PERMISSIONS = ['read', 'push', 'status', 'merge'] as const;

export type ForgeCredentialPermission = (typeof FORGE_CREDENTIAL_PERMISSIONS)[number];

/**
 * The secret-free view of a scoped forge credential, mirrored locally from
 * FC7A's `ScopedForgeCredentialPublicView` without importing
 * `@fleet/work-execution`. `repository` is exactly `owner/name`.
 */
export interface ScopedCredentialScope {
  readonly repository: string;
  readonly permission: ForgeCredentialPermission;
  readonly expiresAtIso: string;
}

/** An opaque, short-lived installation token. The brand keeps it from being confused with raw text. */
export type InstallationToken = string & { readonly __brand: 'InstallationToken' };

/** A fixed failure reason, never a throw; never carries request detail. */
export type BrokerRefusalReason =
  | 'invalid-request'
  | 'ttl-too-long'
  | 'scope-denied'
  | 'credential-expired';

/** Request one installation token for one scoped credential. Every field is required. */
export interface IssueInstallationTokenRequest {
  /** The installation's organization; must equal the credential repository's `owner` segment. */
  readonly organization: string;
  /** The repository the token will act on; must equal `credential.repository`. */
  readonly repository: string;
  /** The single permission requested; must equal `credential.permission`. */
  readonly permission: ForgeCredentialPermission;
  /** Token lifetime in seconds; a finite integer in `(0, 3600]`. */
  readonly ttlSeconds: number;
  /** The caller-supplied instant the request is evaluated at; no ambient clock. */
  readonly nowIso: string;
  /** The scoped credential the request claims to act under. */
  readonly credential: ScopedCredentialScope;
}

export type BrokerResult =
  | {
      readonly ok: true;
      readonly token: InstallationToken;
      readonly expiresAtIso: string;
      readonly repository: string;
      readonly permission: ForgeCredentialPermission;
    }
  | { readonly ok: false; readonly reason: BrokerRefusalReason };

export interface InstallationTokenBrokerPort {
  issue(request: IssueInstallationTokenRequest): Promise<BrokerResult>;
}

/**
 * Domain-sized snapshot limits for one broker request: 6 top-level keys plus
 * 3 nested `credential` keys, no arrays, every string at most 300 characters
 * (1024 leaves headroom for the bounded ISO instant). Fixed at the call site,
 * so the snapshot cost is O(1): bounded by `maxNodes`, `maxKeys`,
 * `maxArrayLength`, `maxDepth` and `maxStringLength` regardless of input.
 */
const BROKER_REQUEST_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 3,
  maxKeys: 8,
  maxArrayLength: 1,
  maxNodes: 32,
  maxStringLength: 1024,
});

/** One repository segment: `owner` or `name` (mirrors FC7A). */
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** ISO-8601 calendar date-time with an explicit offset (`Z` or ±HH:MM). */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The only own keys a broker request may carry. */
const REQUEST_KEYS: readonly string[] = [
  'organization',
  'repository',
  'permission',
  'ttlSeconds',
  'nowIso',
  'credential',
];

/** The only own keys a `ScopedCredentialScope` may carry. */
const CREDENTIAL_KEYS: readonly string[] = ['repository', 'permission', 'expiresAtIso'];

/** Keys that must never appear as own data keys on any untrusted object. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * True when `value` is exactly `owner/name`: one `/`, both segments matching
 * `REPOSITORY_SEGMENT_PATTERN`, neither `.` nor `..`, no wildcard, no URL
 * scheme, total length at most 300. Cost bound: O(1) — non-strings and
 * empty/over-length strings are refused before any scan, and the scan is one
 * pass over at most 300 characters.
 */
export function validateForgeRepository(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value.length > FORGE_CREDENTIAL_MAX_STRING_LENGTH) {
    return false;
  }
  if (value.includes('*') || value.includes('://')) {
    return false;
  }
  const slash = value.indexOf('/');
  if (slash === -1 || value.indexOf('/', slash + 1) !== -1) {
    return false;
  }
  const owner = value.slice(0, slash);
  const name = value.slice(slash + 1);
  if (!REPOSITORY_SEGMENT_PATTERN.test(owner) || !REPOSITORY_SEGMENT_PATTERN.test(name)) {
    return false;
  }
  return owner !== '.' && owner !== '..' && name !== '.' && name !== '..';
}

/** True when `value` is one bounded repository segment (an organization or repository name). */
function isValidSegment(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value.length > FORGE_CREDENTIAL_MAX_STRING_LENGTH) {
    return false;
  }
  if (value === '.' || value === '..' || value.includes('*') || value.includes('://')) {
    return false;
  }
  return REPOSITORY_SEGMENT_PATTERN.test(value);
}

/**
 * A bounded, well-formed ISO-8601 calendar instant that `Date.parse` accepts.
 * Cost bound: O(1) — the length cap (≤100) runs before the pattern and the
 * fixed-size calendar scan.
 */
export function isBoundedIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    return false;
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  return day <= daysInMonth;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * True when the string is one of the exact forge permissions; O(1) — a fixed
 * four-element list scan.
 */
function isForgePermission(value: unknown): value is ForgeCredentialPermission {
  return (
    typeof value === 'string' &&
    FORGE_CREDENTIAL_PERMISSIONS.includes(value as ForgeCredentialPermission)
  );
}

export type ValidateBrokerRequestResult =
  | { readonly ok: true; readonly request: IssueInstallationTokenRequest }
  | { readonly ok: false; readonly reason: 'invalid-request' | 'ttl-too-long' };

/**
 * Validate an untrusted broker request shape on a `snapshotPlainData` copy.
 *
 * Every snapshot refusal (Proxy, accessor, sparse array, symbol key,
 * non-enumerable key, non-plain prototype, cycle, oversized string, hostile
 * value, …) maps to `invalid-request`; after the snapshot succeeds the root
 * is required to be a plain non-array object carrying exactly the six request
 * keys (no polluting, extra, missing, symbol or non-enumerable key), and each
 * field is type-checked on the frozen copy.
 *
 * Cost bound: O(1) — the snapshot is bounded by the fixed
 * `BROKER_REQUEST_LIMITS`, and every per-field check runs over a
 * length-capped string or a fixed key set.
 */
export function validateBrokerRequest(
  input: unknown,
  isProxy?: IsProxy,
): ValidateBrokerRequestResult {
  const snapshot = snapshotPlainData(input, isProxy ?? alwaysFalse, BROKER_REQUEST_LIMITS);
  if (!snapshot.ok) {
    return { ok: false, reason: 'invalid-request' };
  }
  const root = snapshot.value;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const record = root as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== REQUEST_KEYS.length) {
    return { ok: false, reason: 'invalid-request' };
  }
  for (const key of ownKeys) {
    if (!REQUEST_KEYS.includes(key) || POLLUTING_KEYS.has(key)) {
      return { ok: false, reason: 'invalid-request' };
    }
  }
  const organization = record['organization'];
  if (!isValidSegment(organization)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const repository = record['repository'];
  if (!validateForgeRepository(repository)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const permission = record['permission'];
  if (!isForgePermission(permission)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const ttlSeconds = record['ttlSeconds'];
  if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (ttlSeconds > MAX_INSTALLATION_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: 'ttl-too-long' };
  }
  const nowIso = record['nowIso'];
  if (!isBoundedIsoInstant(nowIso)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const credential = readCredentialScope(record['credential']);
  if (credential === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  return {
    ok: true,
    request: {
      organization,
      repository,
      permission,
      ttlSeconds,
      nowIso,
      credential,
    },
  };
}

/**
 * Read one frozen `ScopedCredentialScope` off the snapshot copy: exactly the
 * three credential keys, a valid `owner/name` repository, one permission and
 * a bounded ISO `expiresAtIso`. Cost bound: O(1) — a fixed key set over
 * length-capped strings.
 */
function readCredentialScope(value: unknown): ScopedCredentialScope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== CREDENTIAL_KEYS.length) {
    return null;
  }
  for (const key of ownKeys) {
    if (!CREDENTIAL_KEYS.includes(key) || POLLUTING_KEYS.has(key)) {
      return null;
    }
  }
  const repository = record['repository'];
  if (!validateForgeRepository(repository)) {
    return null;
  }
  const permission = record['permission'];
  if (!isForgePermission(permission)) {
    return null;
  }
  const expiresAtIso = record['expiresAtIso'];
  if (!isBoundedIsoInstant(expiresAtIso)) {
    return null;
  }
  return { repository, permission, expiresAtIso };
}

/**
 * Fail-closed expiry check for an issued token's `expiresAtIso`: `true`
 * (expired) unless both arguments are bounded, well-formed ISO instants that
 * parse to finite numbers, in which case expiry is `nowMs >= expiresAtMs`
 * (the token is expired at its exact `expiresAtIso`). Cost bound: O(1) — two
 * bounded (≤100 char) string validations and two parses.
 */
export function isInstallationTokenExpired(expiresAtIso: unknown, nowIso: unknown): boolean {
  if (!isBoundedIsoInstant(expiresAtIso) || !isBoundedIsoInstant(nowIso)) {
    return true;
  }
  const expiresAtMs = Date.parse(expiresAtIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(expiresAtMs) || Number.isNaN(nowMs)) {
    return true;
  }
  return nowMs >= expiresAtMs;
}

/** A side-effect-free detector that never flags anything; only a default when a caller omits `isProxy`. */
function alwaysFalse(_value: unknown): boolean {
  return false;
}
