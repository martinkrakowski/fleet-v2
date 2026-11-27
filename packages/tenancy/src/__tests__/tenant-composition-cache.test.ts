/**
 * FC-3.5 tests for the tenant composition cache.
 *
 * Pure unit tests: no network, no clock, no randomness. Every call to
 * `createTenantCompositionCache` passes `types.isProxy` from `node:util` as
 * the required second argument, proving no reflection trap can execute
 * during options inspection.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createTenantCompositionCache,
  DEFAULT_MAX_ENTRIES,
  type TenantCompositionCache,
  type TenantCompositionCacheOptions,
} from "@fleet/tenancy";

type Composed = { readonly key: { readonly principal: string; readonly organizationId: string } };

function makeComposingCache(): {
  cache: TenantCompositionCache<Composed>;
  calls: Composed["key"][];
} {
  const calls: Composed["key"][] = [];
  const cache = createTenantCompositionCache<Composed>(
    (key) => {
      calls.push(key);
      return { key };
    },
    types.isProxy,
  );
  return { cache, calls };
}

describe("createTenantCompositionCache", () => {
  it("exports createTenantCompositionCache and DEFAULT_MAX_ENTRIES from @fleet/tenancy", () => {
    expect(typeof createTenantCompositionCache).toBe("function");
    expect(DEFAULT_MAX_ENTRIES).toBe(1024);
  });

  it("returns the identical object reference and invokes compose once across repeated gets for the same (principal, organizationId) pair", () => {
    const { cache, calls } = makeComposingCache();
    const first = cache.get("user-1", "org-a");
    expect(first.ok).toBe(true);
    const second = cache.get("user-1", "org-a");
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toBe(first.value);
    }
    expect(cache.size()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ principal: "user-1", organizationId: "org-a" });
  });

  it("isolates instances across organizations A and B for the same principal in both directions", () => {
    const { cache, calls } = makeComposingCache();
    const a = cache.get("user-1", "org-a");
    const b = cache.get("user-1", "org-b");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).not.toBe(b.value);
      expect(a.value.key.organizationId).toBe("org-a");
      expect(b.value.key.organizationId).toBe("org-b");
    }
    // Both directions: re-getting each pair composes nothing new.
    const aAgain = cache.get("user-1", "org-a");
    const bAgain = cache.get("user-1", "org-b");
    if (a.ok && aAgain.ok && b.ok && bAgain.ok) {
      expect(aAgain.value).toBe(a.value);
      expect(bAgain.value).toBe(b.value);
    }
    expect(calls).toHaveLength(2);
    expect(cache.size()).toBe(2);
  });

  it("isolates instances across principals A and B for the same organization in both directions", () => {
    const { cache, calls } = makeComposingCache();
    const a = cache.get("user-1", "org-a");
    const b = cache.get("user-2", "org-a");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).not.toBe(b.value);
      expect(a.value.key.principal).toBe("user-1");
      expect(b.value.key.principal).toBe("user-2");
    }
    const aAgain = cache.get("user-1", "org-a");
    const bAgain = cache.get("user-2", "org-a");
    if (a.ok && aAgain.ok && b.ok && bAgain.ok) {
      expect(aAgain.value).toBe(a.value);
      expect(bAgain.value).toBe(b.value);
    }
    expect(calls).toHaveLength(2);
    expect(cache.size()).toBe(2);
  });

  it("keeps collision-prone pairs such as (a, b-c) and (a-b, c) as distinct entries", () => {
    const { cache, calls } = makeComposingCache();
    const first = cache.get("a", "b-c");
    const second = cache.get("a-b", "c");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value).not.toBe(second.value);
      expect(first.value.key).toEqual({ principal: "a", organizationId: "b-c" });
      expect(second.value.key).toEqual({ principal: "a-b", organizationId: "c" });
    }
    expect(calls).toHaveLength(2);
    expect(cache.size()).toBe(2);
  });

  it("refuses an invalid or hostile principal with invalid-principal and never echoes or calls compose", () => {
    const { cache, calls } = makeComposingCache();
    const hostileToString = JSON.parse(
      `{"toString": {"hostile": true}}`,
    ) as unknown;
    const invalid: unknown[] = [
      "",
      null,
      undefined,
      42,
      hostileToString,
      "a".repeat(129),
      "user space", // space is outside ACTOR_PATTERN
      "user/slash", // slash is outside ACTOR_PATTERN
    ];
    for (const principal of invalid) {
      const result = cache.get(principal as string, "org-a");
      expect(result).toEqual({ ok: false, reason: "invalid-principal" });
    }
    expect(calls).toHaveLength(0);
    expect(cache.size()).toBe(0);
  });

  it("refuses an invalid or hostile organizationId with invalid-organization-id and never echoes or calls compose", () => {
    const { cache, calls } = makeComposingCache();
    const invalid: unknown[] = [
      "",
      "ORG-A", // uppercase refused
      null,
      undefined,
      {},
      "o".repeat(64),
      "org space", // space is outside ORGANIZATION_ID_PATTERN
      "org_underscore", // underscore is outside ORGANIZATION_ID_PATTERN
    ];
    for (const organizationId of invalid) {
      const result = cache.get("user-1", organizationId as string);
      expect(result).toEqual({ ok: false, reason: "invalid-organization-id" });
    }
    expect(calls).toHaveLength(0);
    expect(cache.size()).toBe(0);
  });

  it("refuses a new pair with cache-full when size reaches maxEntries without evicting existing entries", () => {
    const { calls } = makeComposingCache();
    const small = createTenantCompositionCache<Composed>(
      (key) => {
        calls.push(key);
        return { key };
      },
      types.isProxy,
      { maxEntries: 2 },
    );
    expect(small.get("user-1", "org-a").ok).toBe(true);
    expect(small.get("user-2", "org-a").ok).toBe(true);
    expect(small.size()).toBe(2);
    const refused = small.get("user-3", "org-a");
    expect(refused).toEqual({ ok: false, reason: "cache-full" });
    // No eviction happened: both originals are still served from cache.
    expect(small.size()).toBe(2);
    expect(calls).toHaveLength(2);
    const firstAgain = small.get("user-1", "org-a");
    expect(firstAgain.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("returns compose-failed and caches nothing when compose throws or returns null or undefined", () => {
    let throwCount = 0;
    const throwing = createTenantCompositionCache<Composed>(
      () => {
        throwCount += 1;
        throw new Error("compose exploded");
      },
      types.isProxy,
    );
    expect(throwing.get("user-1", "org-a")).toEqual({
      ok: false,
      reason: "compose-failed",
    });
    expect(throwing.size()).toBe(0);
    // A refused compose is retried on the next get, never cached.
    expect(throwing.get("user-1", "org-a")).toEqual({
      ok: false,
      reason: "compose-failed",
    });
    expect(throwCount).toBe(2);

    for (const empty of [null, undefined] as const) {
      const emptyComposing = createTenantCompositionCache<Composed>(
        () => empty as unknown as Composed,
        types.isProxy,
      );
      expect(emptyComposing.get("user-1", "org-a")).toEqual({
        ok: false,
        reason: "compose-failed",
      });
      expect(emptyComposing.size()).toBe(0);
    }

    // A non-function compose is a compose-failed refusal, never a throw.
    const nonFunction = createTenantCompositionCache<Composed>(
      undefined as unknown as () => Composed,
      types.isProxy,
    );
    expect(nonFunction.get("user-1", "org-a")).toEqual({
      ok: false,
      reason: "compose-failed",
    });
    expect(nonFunction.size()).toBe(0);
  });

  it("falls back to maxEntries 1024 without running getters, Proxy traps, or throwing on hostile options (null, array, array-like, getter, Proxy, prototype-polluting keys, invalid numbers)", () => {
    // A cache whose compose records every call, so a wrongly-resolved
    // capacity would surface as a cached or refused entry past the real
    // bound.
    function composeCounting(maxEntries: number): TenantCompositionCache<Composed> {
      const cache = createTenantCompositionCache<Composed>(
        (key) => ({ key }),
        types.isProxy,
        maxEntries as unknown as undefined,
      );
      return cache;
    }
    function fillBeyond(cache: TenantCompositionCache<Composed>, limit: number): void {
      for (let i = 0; i < limit; i += 1) {
        const result = cache.get(`user-${i}`, "org-a");
        expect(result.ok).toBe(true);
      }
    }
    // Capacity must be DEFAULT_MAX_ENTRIES (1024): entry 1024 succeeds.
    const checkDefault = (cache: TenantCompositionCache<Composed>): void => {
      fillBeyond(cache, DEFAULT_MAX_ENTRIES);
      expect(cache.size()).toBe(DEFAULT_MAX_ENTRIES);
      expect(cache.get("user-over", "org-a")).toEqual({
        ok: false,
        reason: "cache-full",
      });
    };

    // Hostile options shapes: each must fall back to 1024, never throw.
    checkDefault(composeCounting(null as unknown as number));
    checkDefault(composeCounting(42 as unknown as number));
    checkDefault(composeCounting([] as unknown as number));
    checkDefault(composeCounting(JSON.parse(`{"length": 3}`) as unknown as number));
    checkDefault(
      composeCounting(
        JSON.parse(`{"length": ${"9".repeat(30)}}`) as unknown as number,
      ),
    );

    // An accessor that throws if read must never be read; snapshotPlainData
    // refuses accessors by descriptor without running the getter.
    const getterHostile = JSON.parse(`{"maxEntries": 0}`);
    Object.defineProperty(getterHostile, "maxEntries", {
      get() {
        throw new Error("getter ran");
      },
      enumerable: true,
    });
    checkDefault(composeCounting(getterHostile as unknown as number));

    // A Proxy with a throwing ownKeys trap must never run the trap.
    checkDefault(
      composeCounting(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("trap ran");
            },
          },
        ) as unknown as number,
      ),
    );

    // Prototype-polluting and unknown keys refuse the whole options object.
    for (const hostileKey of ["__proto__", "constructor", "prototype", "length"]) {
      const hostile = JSON.parse(
        `{"${hostileKey}": 1, "maxEntries": 5}`,
      ) as unknown;
      checkDefault(composeCounting(hostile as unknown as number));
    }
    checkDefault(
      composeCounting(JSON.parse(`{"unknown": 1, "maxEntries": 5}`) as unknown as number),
    );

    // Invalid maxEntries values all fall back to 1024.
    // Plain objects carrying the bad value directly (JSON.stringify cannot
    // round-trip `undefined` or `-0` faithfully).
    for (const bad of [0, -1, -0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, undefined, "5", null]) {
      checkDefault(
        composeCounting({ maxEntries: bad } as unknown as number),
      );
    }
  });

  it("falls back to maxEntries 1024 without touching options when a non-function isProxy is forced at runtime", () => {
    // snapshotPlainData refuses a non-function detector with `detector-threw`
    // before reading the options at all, so this getter must never run.
    const getterHostile = JSON.parse(`{"maxEntries": 5}`);
    Object.defineProperty(getterHostile, "maxEntries", {
      get() {
        throw new Error("getter ran");
      },
      enumerable: true,
    });
    const cache = createTenantCompositionCache<Composed>(
      (key) => ({ key }),
      undefined as unknown as (value: unknown) => boolean,
      getterHostile as TenantCompositionCacheOptions,
    );
    // Prove the fallback took effect: capacity is 1024, not 5.
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      expect(cache.get(`user-${i}`, "org-a").ok).toBe(true);
    }
    expect(cache.get("user-over", "org-a")).toEqual({
      ok: false,
      reason: "cache-full",
    });
  });

  it("evict removes every entry for the target organizationId and leaves all other organizations and invalid inputs untouched", () => {
    const { cache } = makeComposingCache();
    expect(cache.get("user-1", "org-a").ok).toBe(true);
    expect(cache.get("user-2", "org-a").ok).toBe(true);
    expect(cache.get("user-1", "org-b").ok).toBe(true);
    expect(cache.get("user-2", "org-b").ok).toBe(true);
    expect(cache.size()).toBe(4);

    expect(cache.evict("org-a")).toBe(2);
    expect(cache.size()).toBe(2);
    // org-b entries are untouched; org-a re-composes on demand.
    const b = cache.get("user-1", "org-b");
    expect(b.ok).toBe(true);
    expect(cache.size()).toBe(2);

    // Invalid inputs return 0 and leave the cache untouched.
    for (const invalid of ["", "ORG-A", "org space", null, undefined, 42, "o".repeat(64)]) {
      expect(cache.evict(invalid as string)).toBe(0);
    }
    expect(cache.size()).toBe(2);

    // Evicting an organization with no cached entries removes nothing.
    expect(cache.evict("org-z")).toBe(0);
    expect(cache.size()).toBe(2);
  });

  it("never runs a Proxy reflection trap during options inspection when the required types.isProxy is passed", () => {
    const trapSpy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap ran");
        },
      },
    );
    const cache = createTenantCompositionCache<Composed>(
      (key) => ({ key }),
      types.isProxy,
      trapSpy as unknown as TenantCompositionCacheOptions,
    );
    // No trap executed: the cache still works with the default capacity.
    const result = cache.get("user-1", "org-a");
    expect(result.ok).toBe(true);
    expect(cache.size()).toBe(1);
    // And the capacity is the default 1024, not whatever a trap would have
    // produced.
    for (let i = 1; i < DEFAULT_MAX_ENTRIES; i += 1) {
      expect(cache.get(`user-${i}`, "org-a").ok).toBe(true);
    }
  });
});
