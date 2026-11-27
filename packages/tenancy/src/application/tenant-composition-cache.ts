/**
 * FC-3.5: a pure, collision-free composition cache keyed by
 * `(principal, organizationId)`.
 *
 * Every composed per-(principal, organisation) instance is isolated across
 * both principals and organisations, bounded by `maxEntries`, and never
 * shared or leaked across tenant boundaries. Keys are JSON-encoded so pairs
 * like `(a, b-c)` and `(a-b, c)` can never collide.
 *
 * Hostile-input posture: every function reading untrusted input refuses
 * null, undefined, a wrong primitive, a getter (never run it; values are
 * read through the bounded snapshot copy), a Proxy (via the required
 * `isProxy: IsProxy`, no default), an array-like and a prototype-polluting
 * key, each with a typed result or a safe fallback, never a throw and never
 * an echo of the rejected value.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";
import { ACTOR_PATTERN } from "../domain/sign-in-link.js";
import { ORGANIZATION_ID_PATTERN } from "../domain/entities/record-guards.js";

/** Default cache capacity when no valid `maxEntries` is supplied. */
export const DEFAULT_MAX_ENTRIES = 1024;

export type CacheRefusalReason =
  | "invalid-principal"
  | "invalid-organization-id"
  | "cache-full"
  | "compose-failed";

export type CacheResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CacheRefusalReason };

export interface TenantCompositionCacheOptions {
  readonly maxEntries?: number;
}

export interface TenantCompositionCache<T> {
  get(principal: string, organizationId: string): CacheResult<T>;
  size(): number;
  evict(organizationId: string): number;
}

interface CacheEntry<T> {
  readonly organizationId: string;
  readonly value: T;
}

/**
 * True when `value` is a string of 1..128 characters matching
 * `ACTOR_PATTERN`. Cost bound: O(1) — a length check plus one bounded
 * regex over at most 128 characters.
 */
function isValidPrincipal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    ACTOR_PATTERN.test(value)
  );
}

/**
 * True when `value` is a string of 1..63 characters matching
 * `ORGANIZATION_ID_PATTERN`. Cost bound: O(1) — a length check plus one
 * bounded regex over at most 63 characters.
 */
function isValidOrganizationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 63 &&
    ORGANIZATION_ID_PATTERN.test(value)
  );
}

/**
 * Keys allowed on the flat options object; anything else (symbol,
 * forbidden, unknown) refuses the whole options inspection.
 */
const ALLOWED_OPTION_KEYS: ReadonlySet<string> = new Set(["maxEntries"]);

/** Keys that must never appear as own keys on a parsed options record. */
const FORBIDDEN_OPTION_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "length",
];

/**
 * Resolve `maxEntries` from `options` with a single bounded snapshot pass,
 * or fall back to `DEFAULT_MAX_ENTRIES`. Cost bound: O(1) — one bounded
 * snapshot (`maxDepth: 1`, `maxKeys: 2`, `maxArrayLength: 0`, `maxNodes: 4`,
 * `maxStringLength: 64`) plus at most 2 own-key checks.
 *
 * `isProxy` is passed through with no fallback: a non-function detector
 * makes `snapshotPlainData` refuse with `detector-threw` without ever
 * reading the options, which lands on the same default fallback.
 */
function resolveMaxEntries(
  options: TenantCompositionCacheOptions | undefined,
  isProxy: IsProxy,
): number {
  if (options === undefined) {
    return DEFAULT_MAX_ENTRIES;
  }
  const snapshot = snapshotPlainData(options, isProxy, {
    maxDepth: 1,
    maxKeys: 2,
    maxArrayLength: 0,
    maxNodes: 4,
    maxStringLength: 64,
  });
  if (!snapshot.ok) {
    return DEFAULT_MAX_ENTRIES;
  }
  const snapshotted = snapshot.value;
  if (
    typeof snapshotted !== "object" ||
    snapshotted === null ||
    Array.isArray(snapshotted)
  ) {
    return DEFAULT_MAX_ENTRIES;
  }
  const record = snapshotted as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") {
      return DEFAULT_MAX_ENTRIES;
    }
    if (FORBIDDEN_OPTION_KEYS.includes(key) || !ALLOWED_OPTION_KEYS.has(key)) {
      return DEFAULT_MAX_ENTRIES;
    }
  }
  if (!Object.hasOwn(record, "maxEntries")) {
    return DEFAULT_MAX_ENTRIES;
  }
  const maxEntries = record["maxEntries"];
  if (
    typeof maxEntries !== "number" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1
  ) {
    return DEFAULT_MAX_ENTRIES;
  }
  return maxEntries;
}

/**
 * Encode `(principal, organizationId)` as a JSON pair so no two distinct
 * pairs can ever produce the same key (a plain string join would collide on
 * `(a, b-c)` vs `(a-b, c)`). Cost bound: O(1) over bounded id strings.
 */
function encodeKey(principal: string, organizationId: string): string {
  return JSON.stringify([principal, organizationId]);
}

/**
 * Create a pure, collision-free composition cache. `isProxy` is a required
 * positional parameter with no default: it is passed directly to
 * `snapshotPlainData` when `options` is provided, so no Proxy reflection
 * trap can run during options inspection.
 */
export function createTenantCompositionCache<T>(
  compose: (key: { readonly principal: string; readonly organizationId: string }) => T,
  isProxy: IsProxy,
  options?: TenantCompositionCacheOptions,
): TenantCompositionCache<T> {
  const resolvedMaxEntries = resolveMaxEntries(options, isProxy);
  const entries = new Map<string, CacheEntry<T>>();

  return {
    /**
     * Cost bound: O(1) — two bounded validations, one JSON encode over
     * bounded strings, one Map lookup, one size compare, one bounded
     * compose call.
     */
    get(principal: string, organizationId: string): CacheResult<T> {
      if (!isValidPrincipal(principal)) {
        return { ok: false, reason: "invalid-principal" };
      }
      if (!isValidOrganizationId(organizationId)) {
        return { ok: false, reason: "invalid-organization-id" };
      }
      const key = encodeKey(principal, organizationId);
      const existing = entries.get(key);
      if (existing !== undefined) {
        return { ok: true, value: existing.value };
      }
      if (entries.size >= resolvedMaxEntries) {
        return { ok: false, reason: "cache-full" };
      }
      if (typeof compose !== "function") {
        return { ok: false, reason: "compose-failed" };
      }
      let value: T;
      try {
        value = compose({ principal, organizationId });
      } catch {
        return { ok: false, reason: "compose-failed" };
      }
      if (value === null || value === undefined) {
        return { ok: false, reason: "compose-failed" };
      }
      entries.set(key, { organizationId, value });
      return { ok: true, value };
    },

    /** Cost bound: O(1) — one Map size read. */
    size(): number {
      return entries.size;
    },

    /**
     * Cost bound: O(n) over the cached entries, bounded by
     * `resolvedMaxEntries`. An invalid `organizationId` returns 0 without
     * mutating the cache and without echoing the value.
     */
    evict(organizationId: string): number {
      if (!isValidOrganizationId(organizationId)) {
        return 0;
      }
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.organizationId === organizationId) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
