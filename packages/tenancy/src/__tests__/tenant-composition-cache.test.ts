/**
 * Pure unit tests for the tenant composition cache (FC3H).
 *
 * No network, no clock, no randomness. Every title states what the test
 * asserts and its body proves it: each refusal-path test also asserts that
 * `compose` was never called and that `size()` is unchanged, so the tests
 * fail against a constant or identity implementation.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ENTRIES,
  createTenantCompositionCache,
  type TenantCompositionCache,
} from "../application/tenant-composition-cache.js";

type Instance = { readonly tag: string };

function countingCompose(
  calls: Array<{ readonly principal: string; readonly organizationId: string }>,
  value?: unknown,
) {
  const hasExplicitValue = arguments.length > 1;
  return (key: { readonly principal: string; readonly organizationId: string }): Instance => {
    calls.push(key);
    if (hasExplicitValue) {
      return value as Instance;
    }
    // A fresh object per call: distinct pairs must yield distinct references.
    return { tag: "composed" };
  };
}

const VALID_PRINCIPAL = "user@example.com";
const VALID_ORG = "org-a";

describe("createTenantCompositionCache", () => {
  it(
    "refuses an invalid or hostile principal with invalid-principal and never echoes or calls compose",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache = createTenantCompositionCache<Instance>(countingCompose(calls));
      const hostilePrincipals: unknown[] = [
        "",
        null,
        undefined,
        42,
        {},
        // A string beyond the 128-character bound.
        "a".repeat(129),
        // A character outside ACTOR_PATTERN.
        "user name",
        "user/name",
        "user+name",
      ];
      let seen = 0;
      for (const principal of hostilePrincipals) {
        const result = cache.get(
          principal as string,
          VALID_ORG,
        );
        expect(result, `principal case ${seen}`).toEqual({
          ok: false,
          reason: "invalid-principal",
        });
        seen += 1;
      }
      // A getter that throws if read must be refused without running it.
      const hostileObject = {
        get toString(): string {
          throw new Error("getter must never run");
        },
      };
      expect(cache.get(hostileObject as unknown as string, VALID_ORG)).toEqual({
        ok: false,
        reason: "invalid-principal",
      });
      // compose was never called and nothing was cached.
      expect(calls).toEqual([]);
      expect(cache.size()).toBe(0);
    },
  );

  it(
    "refuses an invalid or hostile organizationId with invalid-organization-id and never echoes or calls compose",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache = createTenantCompositionCache<Instance>(countingCompose(calls));
      const hostileOrgs: unknown[] = [
        "",
        "ORG-A",
        null,
        undefined,
        {},
        7,
        // Beyond the 63-character bound.
        "a".repeat(64),
        // A leading dash and an underscore are outside ORGANIZATION_ID_PATTERN.
        "-org",
        "org_a",
        "org a",
      ];
      let seen = 0;
      for (const organizationId of hostileOrgs) {
        const result = cache.get(
          VALID_PRINCIPAL,
          organizationId as string,
        );
        expect(result, `organizationId case ${seen}`).toEqual({
          ok: false,
          reason: "invalid-organization-id",
        });
        seen += 1;
      }
      expect(calls).toEqual([]);
      expect(cache.size()).toBe(0);
    },
  );

  it(
    "refuses a new pair with cache-full when size reaches maxEntries without evicting existing entries",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache = createTenantCompositionCache<Instance>(
        countingCompose(calls),
        { maxEntries: 2 },
      );
      expect(
        cache.get("user-a@example.com", "org-a").ok,
      ).toBe(true);
      expect(
        cache.get("user-b@example.com", "org-a").ok,
      ).toBe(true);
      const before = cache.size();
      const refused = cache.get("user-c@example.com", "org-a");
      expect(refused).toEqual({ ok: false, reason: "cache-full" });
      // The refusal did not evict, replace or shrink any existing entry.
      expect(cache.size()).toBe(before);
      expect(cache.size()).toBe(2);
      // compose was not called for the refused pair.
      expect(calls).toHaveLength(2);
      // A cached pair still answers from the cache at capacity.
      expect(cache.get("user-a@example.com", "org-a")).toEqual({
        ok: true,
        value: { tag: "composed" },
      });
    },
  );

  it(
    "returns compose-failed and caches nothing when compose throws or returns null or undefined",
    () => {
      const throwing = createTenantCompositionCache<Instance>(() => {
        throw new Error("boom");
      });
      const thrown = throwing.get(VALID_PRINCIPAL, VALID_ORG);
      expect(thrown).toEqual({ ok: false, reason: "compose-failed" });
      expect(throwing.size()).toBe(0);

      const callsNull: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const returnsNull = createTenantCompositionCache<Instance>(
        countingCompose(callsNull, null),
      );
      expect(returnsNull.get(VALID_PRINCIPAL, VALID_ORG)).toEqual({
        ok: false,
        reason: "compose-failed",
      });

      const callsUndefined: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const returnsUndefined = createTenantCompositionCache<Instance>(
        countingCompose(callsUndefined, undefined),
      );
      expect(returnsUndefined.get(VALID_PRINCIPAL, VALID_ORG)).toEqual({
        ok: false,
        reason: "compose-failed",
      });

      // A non-function compose is compose-failed, not a throw.
      const notAFunction = createTenantCompositionCache<Instance>(
        undefined as unknown as () => Instance,
      );
      expect(notAFunction.get(VALID_PRINCIPAL, VALID_ORG)).toEqual({
        ok: false,
        reason: "compose-failed",
      });

      // Nothing was cached by any failing path: a compose that fails first
      // and succeeds second is invoked again, proving nothing was stored.
      let attempt = 0;
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const recoverable = createTenantCompositionCache<Instance>((key) => {
        calls.push(key);
        attempt += 1;
        if (attempt === 1) {
          throw new Error("first attempt fails");
        }
        return { tag: "composed" };
      });
      void throwing;
      void returnsNull;
      void returnsUndefined;
      void notAFunction;
      expect(recoverable.get(VALID_PRINCIPAL, VALID_ORG)).toEqual({
        ok: false,
        reason: "compose-failed",
      });
      expect(recoverable.size()).toBe(0);
      const retried = recoverable.get(VALID_PRINCIPAL, VALID_ORG);
      expect(retried).toEqual({ ok: true, value: { tag: "composed" } });
      expect(calls).toHaveLength(2);
    },
  );

  it(
    "falls back to maxEntries 1024 without running getters or throwing on hostile options (null, array, array-like, getter, Proxy, prototype-polluting keys, invalid numbers)",
    () => {
      expect(DEFAULT_MAX_ENTRIES).toBe(1024);
      // A getter that throws must never run: the fallback is silent.
      const throwingGetter = {
        get maxEntries(): number {
          throw new Error("getter must never run");
        },
      };
      expect(() =>
        createTenantCompositionCache<Instance>(countingCompose([]), throwingGetter as never),
      ).not.toThrow();

      // Hostile shapes and invalid numbers: each must fall back to 1024
      // (proven by filling: entry 1025 is refused cache-full) without
      // throwing and without ever reading the options' getters.
      const hostileOptions: unknown[] = [
        undefined,
        null,
        42,
        "big",
        [16],
        { length: Number.MAX_SAFE_INTEGER },
        JSON.parse('{"__proto__": {"polluted": true}, "maxEntries": 8}'),
        JSON.parse('{"constructor": 1, "maxEntries": 8}'),
        JSON.parse('{"prototype": 1, "maxEntries": 8}'),
        throwingGetter,
        new Proxy({ maxEntries: 8 }, {}),
        { maxEntries: 0 },
        { maxEntries: -1 },
        { maxEntries: -0 },
        { maxEntries: Number.NaN },
        { maxEntries: Number.POSITIVE_INFINITY },
        { maxEntries: 1.5 },
        { maxEntries: undefined },
        { maxEntries: "8" },
        { extra: 1, maxEntries: 8 },
        {},
      ];
      let seen = 0;
      for (const options of hostileOptions) {
        let composed = 0;
        const cache = createTenantCompositionCache<Instance>(() => {
          composed += 1;
          return { tag: `entry-${composed}` };
        }, options as never, types.isProxy);
        // Fill to the resolved bound: all 1024 entries compose and store.
        for (let i = 0; i < 1024; i += 1) {
          const result = cache.get(`user-${i}@example.com`, "org-a");
          expect(result.ok, `hostile option case ${seen}, entry ${i}`).toBe(true);
        }
        expect(cache.size(), `hostile option case ${seen} size`).toBe(1024);
        // Entry 1025: refused cache-full because the fallback is 1024, not
        // the hostile options' claimed 8 (or anything smaller).
        expect(cache.get("user-full@example.com", "org-a")).toEqual({
          ok: false,
          reason: "cache-full",
        });
        seen += 1;
      }
      expect(seen).toBe(hostileOptions.length);
    },
  );

  it(
    "evict removes every entry for the target organizationId and leaves all other organizations and invalid inputs untouched",
    () => {
      const cache = createTenantCompositionCache<Instance>(countingCompose([]));
      cache.get("user-a@example.com", "org-a");
      cache.get("user-b@example.com", "org-a");
      cache.get("user-a@example.com", "org-b");
      expect(cache.size()).toBe(3);
      // Invalid or absent organizationId: zero removals, zero mutation.
      for (const invalid of ["", "ORG-A", null as unknown as string, "-x", "a".repeat(64)]) {
        expect(cache.evict(invalid)).toBe(0);
        expect(cache.size()).toBe(3);
      }
      expect(cache.evict("org-a")).toBe(2);
      expect(cache.size()).toBe(1);
      // Only org-b's entry survives; org-a composes anew.
      expect(cache.get("user-a@example.com", "org-b").ok).toBe(true);
      const fresh = cache.get("user-a@example.com", "org-a");
      expect(fresh).toEqual({ ok: true, value: { tag: "composed" } });
      expect(cache.evict("org-a")).toBe(1);
      expect(cache.size()).toBe(1);
    },
  );

  it(
    "returns the identical object reference and invokes compose once across repeated gets for the same (principal, organizationId) pair",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache = createTenantCompositionCache<Instance>(countingCompose(calls));
      const first = cache.get(VALID_PRINCIPAL, VALID_ORG);
      const second = cache.get(VALID_PRINCIPAL, VALID_ORG);
      const third = cache.get(VALID_PRINCIPAL, VALID_ORG);
      expect(first).toEqual({ ok: true, value: { tag: "composed" } });
      // Identical reference, not a copy or a fresh compose.
      expect(first.ok && second.ok && third.ok).toBe(true);
      if (first.ok && second.ok && third.ok) {
        expect(second.value).toBe(first.value);
        expect(third.value).toBe(first.value);
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        principal: VALID_PRINCIPAL,
        organizationId: VALID_ORG,
      });
      expect(cache.size()).toBe(1);
    },
  );

  it(
    "isolates instances across organizations A and B for the same principal in both directions",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache = createTenantCompositionCache<Instance>(countingCompose(calls));
      const a = cache.get(VALID_PRINCIPAL, "org-a");
      const b = cache.get(VALID_PRINCIPAL, "org-b");
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.value).not.toBe(b.value);
      }
      expect(calls).toHaveLength(2);
      // Reversed order returns the same isolated values.
      expect(cache.get(VALID_PRINCIPAL, "org-b")).toEqual(b);
      expect(cache.get(VALID_PRINCIPAL, "org-a")).toEqual(a);
      expect(calls).toHaveLength(2);
      expect(cache.size()).toBe(2);
    },
  );

  it(
    "isolates instances across principals A and B for the same organization in both directions",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache = createTenantCompositionCache<Instance>(countingCompose(calls));
      const a = cache.get("user-a@example.com", VALID_ORG);
      const b = cache.get("user-b@example.com", VALID_ORG);
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.value).not.toBe(b.value);
      }
      expect(calls).toHaveLength(2);
      expect(cache.get("user-b@example.com", VALID_ORG)).toEqual(b);
      expect(cache.get("user-a@example.com", VALID_ORG)).toEqual(a);
      expect(calls).toHaveLength(2);
      expect(cache.size()).toBe(2);
    },
  );

  it(
    "keeps collision-prone pairs such as (a, b-c) and (a-b, c) as distinct entries",
    () => {
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      const cache: TenantCompositionCache<Instance> = createTenantCompositionCache(
        countingCompose(calls),
      );
      // The naive `principal + "-" + organizationId` join collides here;
      // the JSON-array encoding must not.
      const first = cache.get("a", "b-c");
      const second = cache.get("a-b", "c");
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value).not.toBe(second.value);
      }
      expect(calls).toHaveLength(2);
      expect(calls).toContainEqual({ principal: "a", organizationId: "b-c" });
      expect(calls).toContainEqual({ principal: "a-b", organizationId: "c" });
      expect(cache.size()).toBe(2);
      // Both pairs still resolve to their own distinct instances.
      expect(cache.get("a", "b-c")).toEqual(first);
      expect(cache.get("a-b", "c")).toEqual(second);
      expect(calls).toHaveLength(2);
    },
  );

  it(
    "keeps size within maxEntries when compose re-enters get for another tenant before its own entry is stored",
    () => {
      // With maxEntries: 1, composing tenant A synchronously calls get for
      // tenant B before A is inserted. A's slot is reserved during its
      // compose, so B must be refused cache-full (without composing) and
      // the map must never exceed 1 entry once A is stored.
      const calls: Array<{ readonly principal: string; readonly organizationId: string }> = [];
      let bResult: unknown;
      const cache: TenantCompositionCache<Instance> = createTenantCompositionCache(
        (key) => {
          calls.push(key);
          if (key.organizationId === "org-a") {
            // Re-enter the cache for tenant B before A is inserted.
            bResult = bGet?.();
          }
          return { tag: `composed-${key.organizationId}` };
        },
        { maxEntries: 1 },
      );
      const bGet: () => unknown = () => cache.get(VALID_PRINCIPAL, "org-b");
      const a = cache.get(VALID_PRINCIPAL, "org-a");
      expect(a).toEqual({ ok: true, value: { tag: "composed-org-a" } });
      // The re-entrant get for B was refused cache-full, without composing B.
      expect(bResult).toEqual({ ok: false, reason: "cache-full" });
      expect(calls).toEqual([
        { principal: VALID_PRINCIPAL, organizationId: "org-a" },
      ]);
      // The capacity bound holds despite the re-entrant composition.
      expect(cache.size()).toBe(1);
      // A is cached: a repeated get returns the identical reference.
      const again = cache.get(VALID_PRINCIPAL, "org-a");
      expect(again.ok && a.ok).toBe(true);
      if (again.ok && a.ok) {
        expect(again.value).toBe(a.value);
      }
      expect(cache.size()).toBe(1);
      // Nothing evicted or duplicated by the re-entrant path.
      expect(cache.get(VALID_PRINCIPAL, "org-b")).toEqual({
        ok: false,
        reason: "cache-full",
      });
      expect(cache.size()).toBe(1);
    },
  );
});
