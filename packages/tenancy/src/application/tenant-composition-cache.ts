/**
 * A pure, collision-free composition cache keyed by (principal, organisation)
 * (plan item FC-3.5): composed per-tenant instances are isolated across both
 * principals and organisations, bounded by `maxEntries`, and never shared or
 * leaked across tenant boundaries. Application-layer pure code: no Node,
 * filesystem, subprocess, network, clock or randomness import.
 *
 * Hostile-input posture: the optional `options` argument is read exactly once
 * through a bounded `snapshotPlainData` pass (never a getter, never a Proxy
 * trap), then its own keys are screened with the domain's `checkSnapshotKeys`
 * helper on the frozen snapshot copy. Any hostile or invalid shape — including
 * a non-function `isProxy`, which `snapshotPlainData` refuses as
 * `detector-threw` — falls back to `DEFAULT_MAX_ENTRIES` without throwing.
 * Every failure path returns a typed refusal or a safe zero-mutation result;
 * rejected inputs are never stringified, logged or echoed.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import { ACTOR_PATTERN } from "../domain/sign-in-link.js";
import { ORGANIZATION_ID_PATTERN, checkSnapshotKeys } from "../domain/entities/record-guards.js";

/** Default cache bound when (or despite) `options.maxEntries` is unusable. */
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

/** One principal id: the shared ACTOR_PATTERN plus a 1..128 length bound. O(1). */
function isValidPrincipal(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= 128 && ACTOR_PATTERN.test(value)
  );
}

/** One organisation id: the shared ORGANIZATION_ID_PATTERN plus a 1..63 length bound. O(1). */
function isValidOrganizationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 63 &&
    ORGANIZATION_ID_PATTERN.test(value)
  );
}

/** Collision-free encoding of the (principal, organisation) pair. O(1) over bounded id strings. */
function encodeKey(principal: string, organizationId: string): string {
  return JSON.stringify([principal, organizationId]);
}

interface ResolvedOptions {
  readonly maxEntries: number;
}

/**
 * Read `options` once through a bounded snapshot. Cost bound: O(1) — a single
 * bounded snapshot pass (`maxDepth: 1`, `maxKeys: 2`, `maxArrayLength: 0`,
 * `maxNodes: 4`, `maxStringLength: 64`) plus one key-screening pass over at
 * most two own keys. Any refusal, hostile shape or invalid `maxEntries` falls
 * back to `DEFAULT_MAX_ENTRIES` without throwing, running a getter or running
 * a Proxy reflection trap.
 */
function resolveOptions(options: unknown, isProxy: IsProxy): ResolvedOptions {
  const fallback: ResolvedOptions = { maxEntries: DEFAULT_MAX_ENTRIES };
  if (options === undefined) {
    return fallback;
  }
  const snapshot = snapshotPlainData(options, isProxy, {
    maxDepth: 1,
    maxKeys: 2,
    maxArrayLength: 0,
    maxNodes: 4,
    maxStringLength: 64,
  });
  if (!snapshot.ok) {
    return fallback;
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set<string>(["maxEntries"]);
  if (checkSnapshotKeys(record, allowedKeys) !== null) {
    return fallback;
  }
  if (!Object.hasOwn(record, "maxEntries")) {
    return fallback;
  }
  const maxEntries = record.maxEntries;
  if (typeof maxEntries !== "number" || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    return fallback;
  }
  return { maxEntries };
}

/**
 * Create a bounded per-(principal, organisation) composition cache.
 *
 * `isProxy` is a REQUIRED positional parameter with no default and precedes
 * the optional `options`, so the options snapshot can never run a Proxy
 * reflection trap by omission. `compose` itself is validated lazily in `get`
 * so a broken composer is a typed refusal, not a construction-time throw.
 */
export function createTenantCompositionCache<T>(
  compose: (key: { readonly principal: string; readonly organizationId: string }) => T,
  isProxy: IsProxy,
  options?: TenantCompositionCacheOptions,
): TenantCompositionCache<T> {
  const { maxEntries } = resolveOptions(options, isProxy);
  const entries = new Map<string, { readonly organizationId: string; readonly value: T }>();

  return {
    get(principal, organizationId) {
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

    size() {
      return entries.size;
    },

    evict(organizationId) {
      if (!isValidOrganizationId(organizationId)) {
        return 0;
      }
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.organizationId === organizationId) {
          entries.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };
}
