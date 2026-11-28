/**
 * Pure unit tests for the tenant composition cache (FC3H). No network, no
 * clock, no randomness: every composed value is a plain literal object.
 *
 * Every `createTenantCompositionCache` call passes `types.isProxy` from
 * `node:util` as the required second argument, and one test proves with a
 * throwing `ownKeys` trap that no Proxy reflection trap runs when the trusted
 * detector is passed.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_ENTRIES, createTenantCompositionCache } from "@fleet/tenancy";

const isProxy = types.isProxy as unknown as (value: unknown) => boolean;

describe("createTenantCompositionCache", () => {
  it("exports createTenantCompositionCache and DEFAULT_MAX_ENTRIES from @fleet/tenancy", () => {
    expect(typeof createTenantCompositionCache).toBe("function");
    expect(DEFAULT_MAX_ENTRIES).toBe(1024);
  });

  it("returns the identical object reference and invokes compose once across repeated gets for the same (principal, organizationId) pair", () => {
    let calls = 0;
    const cache = createTenantCompositionCache<{ id: string }>(() => {
      calls++;
      return { id: `composed-${calls}` };
    }, isProxy);
    const first = cache.get("alice", "org-a");
    expect(first).toEqual({ ok: true, value: { id: "composed-1" } });
    const second = cache.get("alice", "org-a");
    expect(second).toEqual({ ok: true, value: { id: "composed-1" } });
    // Same reference, not a recomposition.
    expect(first.ok && second.ok && first.value === second.value).toBe(true);
    expect(calls).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it("isolates instances across organizations A and B for the same principal in both directions", () => {
    const composed: string[] = [];
    const cache = createTenantCompositionCache<{ org: string }>((key) => {
      composed.push(key.organizationId);
      return { org: key.organizationId };
    }, isProxy);
    const a = cache.get("alice", "org-a");
    const b = cache.get("alice", "org-b");
    expect(a.ok && b.ok && a.value === b.value).toBe(false);
    expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { org: "org-a" } });
    expect(cache.get("alice", "org-b")).toEqual({ ok: true, value: { org: "org-b" } });
    expect(composed).toEqual(["org-a", "org-b"]);
    expect(cache.size()).toBe(2);
  });

  it("isolates instances across principals A and B for the same organization in both directions", () => {
    const composed: string[] = [];
    const cache = createTenantCompositionCache<{ principal: string }>((key) => {
      composed.push(key.principal);
      return { principal: key.principal };
    }, isProxy);
    const a = cache.get("alice", "org-a");
    const b = cache.get("bob", "org-a");
    expect(a.ok && b.ok && a.value === b.value).toBe(false);
    expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { principal: "alice" } });
    expect(cache.get("bob", "org-a")).toEqual({ ok: true, value: { principal: "bob" } });
    expect(composed).toEqual(["alice", "bob"]);
    expect(cache.size()).toBe(2);
  });

  it("keeps collision-prone pairs such as (a, b-c) and (a-b, c) as distinct entries", () => {
    const cache = createTenantCompositionCache<{ key: string }>((key) => ({ key: `${key.principal}/${key.organizationId}` }), isProxy);
    const first = cache.get("a", "b-c");
    const second = cache.get("a-b", "c");
    expect(first.ok && second.ok && first.value === second.value).toBe(false);
    expect(cache.get("a", "b-c")).toEqual({ ok: true, value: { key: "a/b-c" } });
    expect(cache.get("a-b", "c")).toEqual({ ok: true, value: { key: "a-b/c" } });
    expect(cache.size()).toBe(2);
  });

  it("refuses an invalid or hostile principal with invalid-principal and never echoes or calls compose", () => {
    let calls = 0;
    const cache = createTenantCompositionCache<{ id: string }>(() => {
      calls++;
      return { id: "x" };
    }, isProxy);
    const hostile: unknown[] = [
      "",
      null,
      undefined,
      42,
      { toString() { throw new Error("echoed"); } },
      "a".repeat(129),
      "alice;drop",
      "alice space",
    ];
    for (const principal of hostile) {
      const result = cache.get(principal as string, "org-a");
      expect(result).toEqual({ ok: false, reason: "invalid-principal" });
    }
    expect(calls).toBe(0);
    expect(cache.size()).toBe(0);
  });

  it("refuses an invalid or hostile organizationId with invalid-organization-id and never echoes or calls compose", () => {
    let calls = 0;
    const cache = createTenantCompositionCache<{ id: string }>(() => {
      calls++;
      return { id: "x" };
    }, isProxy);
    const hostile: unknown[] = ["", "ORG-A", null, undefined, {}, "o".repeat(64), "org_a", "org a"];
    for (const organizationId of hostile) {
      const result = cache.get("alice", organizationId as string);
      expect(result).toEqual({ ok: false, reason: "invalid-organization-id" });
    }
    expect(calls).toBe(0);
    expect(cache.size()).toBe(0);
  });

  it("refuses a new pair with cache-full when size reaches maxEntries without evicting existing entries", () => {
    const cache = createTenantCompositionCache<{ n: number }>(() => ({ n: 1 }), isProxy, { maxEntries: 2 });
    expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { n: 1 } });
    expect(cache.get("bob", "org-a")).toEqual({ ok: true, value: { n: 1 } });
    expect(cache.size()).toBe(2);
    const full = cache.get("carol", "org-a");
    expect(full).toEqual({ ok: false, reason: "cache-full" });
    // No eviction happened: both originals still hit.
    expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { n: 1 } });
    expect(cache.get("bob", "org-a")).toEqual({ ok: true, value: { n: 1 } });
    expect(cache.size()).toBe(2);
  });

  it("returns compose-failed and caches nothing when compose throws or returns null or undefined", () => {
    const cache = createTenantCompositionCache<{ n: number }>(() => {
      throw new Error("boom");
    }, isProxy);
    expect(cache.get("alice", "org-a")).toEqual({ ok: false, reason: "compose-failed" });
    expect(cache.size()).toBe(0);

    let calls = 0;
    const nullish = createTenantCompositionCache<{ n: number } | null | undefined>(() => {
      calls++;
      return calls === 1 ? null : undefined;
    }, isProxy);
    expect(nullish.get("alice", "org-a")).toEqual({ ok: false, reason: "compose-failed" });
    expect(nullish.get("alice", "org-a")).toEqual({ ok: false, reason: "compose-failed" });
    expect(calls).toBe(2); // re-invoked on every get: nothing was cached
    expect(nullish.size()).toBe(0);

    // Not-a-function compose.
    const broken = createTenantCompositionCache<Record<string, never>>(
      undefined as unknown as () => Record<string, never>,
      isProxy,
    );
    expect(broken.get("alice", "org-a")).toEqual({ ok: false, reason: "compose-failed" });
    expect(broken.size()).toBe(0);
  });

  it("falls back to maxEntries 1024 without running getters, Proxy traps, or throwing on hostile options (null, array, array-like, getter, Proxy, prototype-polluting keys, invalid numbers)", () => {
    const getterHostile = {
      get maxEntries(): number {
        throw new Error("getter ran");
      },
    };
    const proxyHostile = new Proxy({}, { ownKeys() { throw new Error("trap ran"); } });
    const polluting = JSON.parse('{"__proto__": 5, "maxEntries": 7}');
    const cases: unknown[] = [
      null,
      42,
      "big",
      true,
      [],
      { length: 1e12 },
      getterHostile,
      proxyHostile,
      polluting,
      { maxEntries: 0 },
      { maxEntries: -1 },
      { maxEntries: -0 },
      { maxEntries: Number.NaN },
      { maxEntries: Number.POSITIVE_INFINITY },
      { maxEntries: 1.5 },
      { maxEntries: undefined },
      { maxEntries: "5" },
      { unknown: 1 },
    ];
    for (const options of cases) {
      const cache = createTenantCompositionCache<{ n: number }>(() => ({ n: 1 }), isProxy, options as { maxEntries?: number });
      // The cache still works and is still bounded by the 1024 fallback.
      expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { n: 1 } });
      expect(cache.size()).toBe(1);
      expect(cache.evict("org-a")).toBe(1);
    }
    // The fallback bound is really 1024: 1024 entries fit, the 1025th is refused.
    let n = 0;
    const bounded = createTenantCompositionCache<{ n: number }>(() => ({ n: n++ }), isProxy, { maxEntries: Number.NaN } as { maxEntries?: number });
    for (let i = 0; i < 1024; i++) {
      expect(bounded.get(`p${i}`, "org-a").ok).toBe(true);
    }
    expect(bounded.get("overflow", "org-a")).toEqual({ ok: false, reason: "cache-full" });
  });

  it("falls back to maxEntries 1024 without touching options when a non-function isProxy is forced at runtime", () => {
    const getterHostile = {
      get maxEntries(): number {
        throw new Error("getter ran");
      },
    };
    const cache = createTenantCompositionCache<{ n: number }>(
      () => ({ n: 1 }),
      undefined as unknown as typeof isProxy,
      getterHostile,
    );
    expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { n: 1 } });
    expect(cache.size()).toBe(1);
  });

  it("evict removes every entry for the target organizationId and leaves all other organizations and invalid inputs untouched", () => {
    const cache = createTenantCompositionCache<{ n: number }>(() => ({ n: 1 }), isProxy);
    cache.get("alice", "org-a");
    cache.get("bob", "org-a");
    cache.get("alice", "org-b");
    expect(cache.evict("org-a")).toBe(2);
    expect(cache.size()).toBe(1);
    // org-b survived; its entry still hits without recomposing.
    expect(cache.get("alice", "org-b")).toEqual({ ok: true, value: { n: 1 } });
    // Invalid inputs return 0 and mutate nothing.
    for (const bad of ["", "ORG-A", null, undefined, {}, "o".repeat(64)]) {
      expect(cache.evict(bad as string)).toBe(0);
    }
    expect(cache.size()).toBe(1);
  });

  it("runs no Proxy reflection trap on hostile options when types.isProxy is passed", () => {
    const trapHostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap ran");
        },
        getOwnPropertyDescriptor() {
          throw new Error("trap ran");
        },
        get() {
          throw new Error("trap ran");
        },
      },
    );
    const cache = createTenantCompositionCache<{ n: number }>(() => ({ n: 1 }), isProxy, trapHostile);
    expect(cache.get("alice", "org-a")).toEqual({ ok: true, value: { n: 1 } });
  });
});
