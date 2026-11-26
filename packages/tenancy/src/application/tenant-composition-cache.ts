/**
 * A pure, collision-free composition cache keyed by
 * `(principal, organisation)` (plan item FC-3.5). Composed per-tenant
 * instances stay isolated across both principals and organisations, bounded
 * by `maxEntries`, and never shared or leaked across tenant boundaries.
 *
 * Pure application code: no Node, filesystem, subprocess, network, clock or
 * randomness. The only dependency beyond the domain is `@fleet/shared`'s
 * `snapshotPlainData` / `IsProxy`.
 *
 * Hostile-input posture: every failure path returns a typed refusal or a
 * safe zero-mutation result, never throws, and never echoes or stringifies
 * the rejected input.
 */

import {
  snapshotPlainData,
  type IsProxy,
} from "@fleet/shared";

import { ACTOR_PATTERN } from "../domain/sign-in-link.js";
import { ORGANIZATION_ID_PATTERN } from "../domain/entities/record-guards.js";

/** The default capacity when no valid `maxEntries` is supplied. */
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
  /** The cached instance for `(principal, organizationId)`, composing it once. */
  get(principal: string, organizationId: string): CacheResult<T>;
  /** The number of cached entries. */
  size(): number;
  /** Every entry of `organizationId`; returns how many were removed. */
  evict(organizationId: string): number;
}

interface Entry<T> {
  readonly organizationId: string;
  readonly value: T;
}

/**
 * Options are inspected once through a single bounded snapshot pass
 * (`maxDepth: 1`, `maxKeys: 2`, `maxNodes: 4`) plus at most 2 own-key
 * checks: O(1). Hostile or invalid options, a missing `maxEntries` or a
 * non-safe-positive-integer `maxEntries` all fall back to
 * `DEFAULT_MAX_ENTRIES` without throwing and without invoking getters.
 */
const OPTIONS_LIMITS = {
  maxDepth: 1,
  maxKeys: 2,
  maxArrayLength: 0,
  maxNodes: 4,
  maxStringLength: 64,
} as const;

const ALLOWED_OPTION_KEYS: ReadonlySet<string> = new Set(["maxEntries"]);

const FORBIDDEN_OPTION_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "length",
];

function resolveMaxEntries(
  options: TenantCompositionCacheOptions | undefined,
  isProxy: IsProxy,
): number {
  if (options === undefined) {
    return DEFAULT_MAX_ENTRIES;
  }
  const snapshot = snapshotPlainData(options, isProxy, OPTIONS_LIMITS);
  if (!snapshot.ok) {
    return DEFAULT_MAX_ENTRIES;
  }
  const value: unknown = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_MAX_ENTRIES;
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (
      typeof key !== "string" ||
      FORBIDDEN_OPTION_KEYS.includes(key) ||
      !ALLOWED_OPTION_KEYS.has(key)
    ) {
      return DEFAULT_MAX_ENTRIES;
    }
  }
  if (!Object.hasOwn(record, "maxEntries")) {
    return DEFAULT_MAX_ENTRIES;
  }
  const maxEntries: unknown = record.maxEntries;
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
 * O(1): a length check before the regex, and the pattern itself is
 * length-bounded to 128 characters.
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
 * O(1): a length check before the regex, and the pattern itself is
 * length-bounded to 63 characters.
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
 * Create a composition cache keyed by `(principal, organizationId)`.
 * `isProxy` is a separate positional parameter (never a field of
 * `options`), forwarded to `snapshotPlainData`, which refuses function
 * values outright.
 */
export function createTenantCompositionCache<T>(
  compose: (key: {
    readonly principal: string;
    readonly organizationId: string;
  }) => T,
  options?: TenantCompositionCacheOptions,
  isProxy?: IsProxy,
): TenantCompositionCache<T> {
  const maxEntries = resolveMaxEntries(options, isProxy ?? (() => false));
  const entries = new Map<string, Entry<T>>();

  return {
    get(principal: string, organizationId: string): CacheResult<T> {
      // Validate the principal first; a rejected value is never echoed.
      if (!isValidPrincipal(principal)) {
        return { ok: false, reason: "invalid-principal" };
      }
      if (!isValidOrganizationId(organizationId)) {
        return { ok: false, reason: "invalid-organization-id" };
      }
      // JSON-array encoding keeps collision-prone pairs such as
      // (a, b-c) and (a-b, c) distinct. O(1) over the bounded id strings.
      const key = JSON.stringify([principal, organizationId]);
      const cached = entries.get(key);
      if (cached !== undefined) {
        return { ok: true, value: cached.value };
      }
      // Full: refuse without evicting anything and without composing.
      if (entries.size >= maxEntries) {
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

    size(): number {
      return entries.size;
    },

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
