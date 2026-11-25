/**
 * FC7A: the short-lived forge credential value type and its request
 * validation. Pure domain: no node:*, filesystem, network, clock or vendor
 * imports; custom inspect formatting uses `Symbol.for('nodejs.util.inspect.custom')`
 * instead of importing `node:util`. Every externally-shaped input is refused
 * with a typed result (or the fail-closed `true` of `isExpired`) and never
 * throws, never invokes an untrusted getter, and never coerces.
 */

import { isPlainRecordObject } from './record-schema-version.js';
import { isCalendarDateTime, readExactPlainRecord } from './plain-record-reads.js';

/** The longest TTL a forge credential may request. */
export const FORGE_CREDENTIAL_MAX_TTL_SECONDS = 3600 as const;

/** The longest any single forge-credential string field may be. */
export const FORGE_CREDENTIAL_MAX_STRING_LENGTH = 300 as const;

/** The exact permission set a forge credential may carry. */
export const FORGE_CREDENTIAL_PERMISSIONS = ['read', 'push', 'status', 'merge'] as const;

export type ForgeCredentialPermission = (typeof FORGE_CREDENTIAL_PERMISSIONS)[number];

export type ForgeCredentialRefusalReason =
  | 'invalid-request'
  | 'permission-not-allowed'
  | 'ttl-too-long'
  | 'unavailable';

export interface ForgeCredentialRequest {
  readonly repository: string;
  readonly permission: ForgeCredentialPermission;
  readonly ttlSeconds: number;
  readonly purposeRef: string;
}

/** The view of a credential that is safe to publish; the secret never appears. */
export interface ScopedForgeCredentialPublicView {
  readonly repository: string;
  readonly permission: ForgeCredentialPermission;
  readonly expiresAtIso: string;
}

/** ISO-8601 calendar date-time with an explicit offset (`Z` or ±HH:MM). */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** One repository segment: `owner` or `name`. */
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The scoped forge credential value type. The secret lives in an ES `#private`
 * field, so it is never an enumerable or string-keyed property: `Object.keys`,
 * `Object.getOwnPropertyNames`, spread and `Object.entries` cannot see it, and
 * `toJSON`/`toString`/`inspect` publish only the redacted public view.
 */
export class ScopedForgeCredential {
  public readonly repository: string;
  public readonly permission: ForgeCredentialPermission;
  public readonly expiresAtIso: string;
  readonly #secret: string;

  constructor(input: {
    readonly repository: string;
    readonly permission: ForgeCredentialPermission;
    readonly expiresAtIso: string;
    readonly secret: string;
  }) {
    this.repository = input.repository;
    this.permission = input.permission;
    this.expiresAtIso = input.expiresAtIso;
    this.#secret = input.secret;
  }

  /** The credential secret itself. Callers send it to the forge, never log it. */
  reveal(): string {
    return this.#secret;
  }

  /** The secret-free view; `JSON.stringify` uses this. */
  toJSON(): ScopedForgeCredentialPublicView {
    return { repository: this.repository, permission: this.permission, expiresAtIso: this.expiresAtIso };
  }

  /** Redacted representation; never contains the secret. */
  toString(): string {
    return `ScopedForgeCredential(${this.repository}, ${this.permission}, ${this.expiresAtIso}, [REDACTED])`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

/**
 * True when `value` is exactly `owner/name`: one `/`, both segments
 * alphanumeric with `._-`, neither `.` nor `..`, no wildcard, no URL scheme,
 * no trailing slash. Cost bound: O(1) — non-strings and length-0/length>300
 * strings are rejected before any scan, and the scan itself is one pass over
 * at most 300 characters.
 */
export function validateForgeRepository(value: unknown): boolean {
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

/**
 * Validate an untrusted forge-credential request shape. Cost bound: O(1) —
 * the plain-record check, the exact own-key count (4), and the four fixed
 * descriptor reads all bound the work regardless of how many keys a hostile
 * object carries; the Proxy-trap enumeration is the one unavoidable listing
 * and its count is refused immediately when it is not 4.
 */
export function validateForgeCredentialRequest(
  input: unknown,
): { readonly ok: true; readonly request: ForgeCredentialRequest } | { readonly ok: false; readonly reason: 'invalid-request' | 'ttl-too-long' } {
  try {
    if (!isPlainRecordObject(input)) {
      return { ok: false, reason: 'invalid-request' };
    }
    // One enumeration; the count refusal is the accepted bound on hostile
    // objects with many keys. Exactly the four request keys, nothing else.
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== 4) {
      return { ok: false, reason: 'invalid-request' };
    }
    for (const key of ownKeys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return { ok: false, reason: 'invalid-request' };
      }
    }
    const fields = readExactPlainRecord(input, ['repository', 'permission', 'ttlSeconds', 'purposeRef']);
    if (fields === null) {
      return { ok: false, reason: 'invalid-request' };
    }
    const repository = fields.repository;
    if (typeof repository !== 'string' || !validateForgeRepository(repository)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const permission = fields.permission;
    if (
      typeof permission !== 'string' ||
      !FORGE_CREDENTIAL_PERMISSIONS.includes(permission as ForgeCredentialPermission)
    ) {
      return { ok: false, reason: 'invalid-request' };
    }
    const ttlSeconds = fields.ttlSeconds;
    if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      return { ok: false, reason: 'invalid-request' };
    }
    if (ttlSeconds > FORGE_CREDENTIAL_MAX_TTL_SECONDS) {
      return { ok: false, reason: 'ttl-too-long' };
    }
    const purposeRef = fields.purposeRef;
    if (
      typeof purposeRef !== 'string' ||
      purposeRef.length === 0 ||
      purposeRef.length > FORGE_CREDENTIAL_MAX_STRING_LENGTH ||
      purposeRef.trim().length === 0
    ) {
      return { ok: false, reason: 'invalid-request' };
    }
    return {
      ok: true,
      request: {
        repository,
        permission: permission as ForgeCredentialPermission,
        ttlSeconds,
        purposeRef,
      },
    };
  } catch {
    // A revoked Proxy, or a Proxy whose getPrototypeOf/ownKeys trap throws,
    // lands here: fail closed with the typed refusal.
    return { ok: false, reason: 'invalid-request' };
  }
}

/**
 * Fail-closed expiry check: `true` (expired) unless both `expiresAtIso` and
 * `nowIso` are well-formed bounded ISO strings that name a real calendar
 * instant and parse to a finite number, in which case expiry is
 * `nowMs >= expiresAtMs` (the credential is expired at its exact
 * `expiresAtIso`). Cost bound: O(1) — two bounded (≤100 char) string
 * validations and two parses.
 */
export function isExpired(credential: unknown, nowIso: unknown): boolean {
  try {
    const expiresAtIso = readExpiresAtIso(credential);
    if (expiresAtIso === null || !isBoundedIsoInstant(expiresAtIso)) {
      return true;
    }
    if (typeof nowIso !== 'string' || !isBoundedIsoInstant(nowIso)) {
      return true;
    }
    const expiresAtMs = Date.parse(expiresAtIso);
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(expiresAtMs) || Number.isNaN(nowMs)) {
      return true;
    }
    return nowMs >= expiresAtMs;
  } catch {
    return true;
  }
}

/** Read `expiresAtIso` without ever invoking a getter, or null when absent/hostile. */
function readExpiresAtIso(credential: unknown): string | null {
  if (credential instanceof ScopedForgeCredential) {
    // Own instance property; the class stores it as a plain data field.
    return credential.expiresAtIso;
  }
  if (!isPlainRecordObject(credential)) {
    return null;
  }
  const fields = readExactPlainRecord(credential, ['expiresAtIso']);
  if (fields === null) {
    return null;
  }
  const value = fields.expiresAtIso;
  return typeof value === 'string' ? value : null;
}

/** A bounded, well-formed ISO-8601 instant that names a real calendar date-time. */
function isBoundedIsoInstant(value: string): boolean {
  if (value.length > 100) {
    return false;
  }
  return ISO_INSTANT_PATTERN.test(value) && isCalendarDateTime(value);
}
