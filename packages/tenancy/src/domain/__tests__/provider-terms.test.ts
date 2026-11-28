/**
 * Domain tests for the provider-terms registry with an empty pass list
 * (FC15A).
 *
 * Every title states what the test asserts and every body proves it; the
 * refusal cases would fail against a constant-allow implementation and the
 * registry-frozen/empty cases would fail against an identity or
 * constant-registry implementation.
 *
 * Hostile-input posture: every case below proves a typed refusal (never a
 * throw, never a pass) for null, undefined, non-iterables, sparse arrays,
 * wrong primitives, getters (never invoked), Proxies (traps never run when
 * the detector is supplied), array-likes, enormous lengths,
 * prototype-polluting keys and extra or missing keys, each without echoing
 * the offending value.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import * as entry from "../../index.js";
import {
  createTestProviderTermsRegistry,
  decideTestProviderSelectability,
  isTestProviderSelectable,
} from "./provider-terms-fixture.js";

const isProxy = types.isProxy as (value: unknown) => boolean;

const PASS = {
  providerId: "acme-storage",
  reviewedAtIso: "2026-06-01T12:00:00Z",
  reviewer: "review-owner",
};

describe("DEFAULT_PROVIDER_TERMS_REGISTRY is frozen and empty", () => {
  it("exposes a frozen registry whose passes array is empty and frozen", () => {
    expect(Object.isFrozen(entry.DEFAULT_PROVIDER_TERMS_REGISTRY)).toBe(true);
    expect(entry.DEFAULT_PROVIDER_TERMS_REGISTRY.passes).toEqual([]);
    expect(Object.isFrozen(entry.DEFAULT_PROVIDER_TERMS_REGISTRY.passes)).toBe(true);
  });

  it("exposes a frozen and empty RECORDED_PROVIDER_PASSES", () => {
    expect(Object.isFrozen(entry.RECORDED_PROVIDER_PASSES)).toBe(true);
    expect(entry.RECORDED_PROVIDER_PASSES).toEqual([]);
  });
});

describe("decideProviderSelectability closes selection on the production registry", () => {
  it("returns false with reason no-recorded-pass for any providerId on DEFAULT_PROVIDER_TERMS_REGISTRY and for unknown ids on a populated fixture registry", () => {
    expect(entry.decideProviderSelectability("anything")).toEqual({
      selectable: false,
      reason: "no-recorded-pass",
    });
    expect(entry.decideProviderSelectability("acme-storage")).toEqual({
      selectable: false,
      reason: "no-recorded-pass",
    });
    const fixture = createTestProviderTermsRegistry([PASS], isProxy);
    expect(fixture.ok).toBe(true);
    if (fixture.ok) {
      expect(decideTestProviderSelectability(fixture.registry, "other-provider", isProxy)).toEqual({
        selectable: false,
        reason: "no-recorded-pass",
      });
      expect(isTestProviderSelectable(fixture.registry, "other-provider", isProxy)).toBe(false);
    }
  });

  it("selects true only for the exact recorded providerId on a populated fixture registry", () => {
    const fixture = createTestProviderTermsRegistry([PASS], isProxy);
    expect(fixture.ok).toBe(true);
    if (fixture.ok) {
      expect(decideTestProviderSelectability(fixture.registry, "acme-storage", isProxy)).toEqual({
        selectable: true,
      });
      expect(isTestProviderSelectable(fixture.registry, "acme-storage", isProxy)).toBe(true);
    }
  });
});

describe("providerId validation", () => {
  it("refuses non-string and malformed providerId values", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "",
      "a".repeat(64),
      "-leading-dash",
      "has space",
      "UPPER",
      "has_underscore",
    ];
    for (const value of bad) {
      expect(entry.decideProviderSelectability(value)).toEqual({
        selectable: false,
        reason: "invalid-provider-id",
      });
      expect(entry.isProviderSelectable(value)).toBe(false);
    }
  });

  it("refuses wrong primitive types for providerId, registry, and pass fields", () => {
    const primitives: unknown[] = [42, -0, NaN, Infinity, true, Symbol("s"), 1n, () => {}];
    for (const value of primitives) {
      expect(entry.decideProviderSelectability(value)).toEqual({
        selectable: false,
        reason: "invalid-provider-id",
      });
    }
    const badRegistry = { passes: [{ providerId: "acme", reviewedAtIso: 42, reviewer: "r" }] };
    expect(decideTestProviderSelectability(badRegistry, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    const badPasses = [{ providerId: "acme", reviewedAtIso: "2026-06-01T12:00:00Z", reviewer: 42 }];
    expect(createTestProviderTermsRegistry(badPasses, isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
  });

  it("refuses null and undefined providerId, registry, passes, and pass elements without throwing", () => {
    expect(entry.decideProviderSelectability(null)).toEqual({
      selectable: false,
      reason: "invalid-provider-id",
    });
    expect(entry.decideProviderSelectability(undefined)).toEqual({
      selectable: false,
      reason: "invalid-provider-id",
    });
    expect(decideTestProviderSelectability(null, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(decideTestProviderSelectability(undefined, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(createTestProviderTermsRegistry(null, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(createTestProviderTermsRegistry(undefined, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(createTestProviderTermsRegistry([null], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    expect(createTestProviderTermsRegistry([undefined], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    expect(decideTestProviderSelectability({ passes: [null] }, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("refuses Proxy inputs via the injected detector without running any Proxy trap", () => {
    const trapRuns: string[] = [];
    const hostile = new Proxy(
      { passes: [] },
      {
        get(target, prop) {
          trapRuns.push(String(prop));
          return Reflect.get(target, prop);
        },
      },
    );
    expect(entry.decideProviderSelectability(hostile, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-provider-id",
    });
    expect(decideTestProviderSelectability(hostile, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(createTestProviderTermsRegistry(new Proxy([PASS], {}), isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(trapRuns).toEqual([]);
  });

  it("refuses objects and arrays with getters without invoking the getter", () => {
    let getterRan = false;
    const withGetter = {
      get passes() {
        getterRan = true;
        return [];
      },
    };
    expect(decideTestProviderSelectability(withGetter, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    const withPassGetter = {
      passes: [
        {
          providerId: "acme",
          get reviewedAtIso() {
            getterRan = true;
            return "2026-06-01T12:00:00Z";
          },
          reviewer: "r",
        },
      ],
    };
    expect(decideTestProviderSelectability(withPassGetter, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(createTestProviderTermsRegistry([new Proxy(PASS, {})], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    expect(getterRan).toBe(false);
  });

  it("refuses sparse arrays with array holes", () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = { ...PASS };
    expect(createTestProviderTermsRegistry(sparse, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(
      decideTestProviderSelectability({ passes: sparse }, "acme-storage", isProxy),
    ).toEqual({ selectable: false, reason: "invalid-registry" });
  });

  it("refuses non-iterable passes and non-array registry.passes", () => {
    for (const value of [42, true, {}]) {
      expect(createTestProviderTermsRegistry(value, isProxy)).toEqual({
        ok: false,
        reason: "invalid-passes",
      });
    }
    expect(decideTestProviderSelectability({ passes: {} }, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(decideTestProviderSelectability({ passes: 42 }, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("refuses array-like objects where an array is expected", () => {
    const arrayLike = { length: 1, 0: { ...PASS } };
    expect(createTestProviderTermsRegistry(arrayLike, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(decideTestProviderSelectability({ passes: arrayLike }, "acme-storage", isProxy)).toEqual(
      { selectable: false, reason: "invalid-registry" },
    );
  });

  it("refuses enormous array lengths and oversized strings in bounded time", () => {
    const huge: unknown[] = new Array(65).fill(null).map(() => ({ ...PASS }));
    expect(huge.length).toBe(65);
    expect(createTestProviderTermsRegistry(huge, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(
      decideTestProviderSelectability({ passes: huge }, "acme-storage", isProxy),
    ).toEqual({ selectable: false, reason: "invalid-registry" });
    const oversizedId = "a".repeat(64);
    expect(entry.decideProviderSelectability(oversizedId)).toEqual({
      selectable: false,
      reason: "invalid-provider-id",
    });
    const longReviewer = { ...PASS, reviewer: "r".repeat(121) };
    expect(createTestProviderTermsRegistry([longReviewer], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
    const longIso = { ...PASS, reviewedAtIso: `2026-06-01T12:00:00.${"9".repeat(10)}Z` };
    expect(createTestProviderTermsRegistry([longIso], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewed-at",
    });
  });

  it("refuses prototype-polluting keys, symbol keys, non-enumerable keys, non-plain prototypes, and extra or missing keys", () => {
    const polluting: Record<string, unknown> = { ...PASS };
    Object.defineProperty(polluting, "__proto__", {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(createTestProviderTermsRegistry([polluting], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const symbolKey: Record<PropertyKey, unknown> = { ...PASS };
    symbolKey[Symbol("extra")] = "x";
    expect(createTestProviderTermsRegistry([symbolKey], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const nonEnumerable: Record<string, unknown> = { ...PASS };
    Object.defineProperty(nonEnumerable, "hidden", {
      value: "x",
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(createTestProviderTermsRegistry([nonEnumerable], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    class NotPlain {
      passes: unknown[] = [];
      constructor() {
        this.passes = [{ ...PASS }];
      }
    }
    expect(decideTestProviderSelectability(new NotPlain(), "acme-storage", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(decideTestProviderSelectability(Object.create(null), "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    const extraKey = { ...PASS, extra: "x" };
    expect(createTestProviderTermsRegistry([extraKey], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    expect(
      decideTestProviderSelectability({ passes: [{ ...PASS }], extra: 1 }, "acme-storage", isProxy),
    ).toEqual({ selectable: false, reason: "invalid-registry" });
    const missingReviewer = { providerId: "acme", reviewedAtIso: "2026-06-01T12:00:00Z" };
    expect(createTestProviderTermsRegistry([missingReviewer], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
    expect(createTestProviderTermsRegistry([{ providerId: "acme" }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewed-at",
    });
    expect(createTestProviderTermsRegistry([{ reviewer: "r" }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-provider-id",
    });
    expect(decideTestProviderSelectability({}, "acme", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("refuses a pass whose reviewedAtIso is not a zoned ISO-8601 timestamp", () => {
    const badDates = [
      "2026-06-01",
      "not-a-date",
      "2026-02-31T12:00:00Z",
      "2026-06-01T12:00:00",
    ];
    for (const reviewedAtIso of badDates) {
      expect(
        createTestProviderTermsRegistry([{ ...PASS, reviewedAtIso }], isProxy),
      ).toEqual({ ok: false, reason: "invalid-reviewed-at" });
    }
    expect(
      createTestProviderTermsRegistry(
        [{ ...PASS, reviewer: "r\x00" }],
        isProxy,
      ),
    ).toEqual({ ok: false, reason: "invalid-reviewer" });
  });
});

describe("package export surface", () => {
  it("exports the closed-by-default surface and no registry-taking symbol", () => {
    const names = Object.keys(entry);
    expect(names).toContain("DEFAULT_PROVIDER_TERMS_REGISTRY");
    expect(names).toContain("RECORDED_PROVIDER_PASSES");
    expect(names).toContain("isProviderSelectable");
    expect(names).toContain("decideProviderSelectability");
    expect(names).not.toContain("createProviderTermsRegistry");
    expect(names).not.toContain("createTestProviderTermsRegistry");
  });

  it("keeps the production deciders registry-free: an extra argument never selects anything", () => {
    const extra = (fn: unknown): ((...args: unknown[]) => unknown) =>
      fn as (...args: unknown[]) => unknown;
    expect(entry.isProviderSelectable("anything")).toBe(false);
    expect(entry.isProviderSelectable("anything", isProxy)).toBe(false);
    expect(extra(entry.isProviderSelectable)("anything", isProxy, { passes: [{ providerId: "anything" }] })).toBe(
      false,
    );
    expect(
      extra(entry.decideProviderSelectability)("anything", isProxy, {
        passes: [{ providerId: "anything" }],
      }),
    ).toEqual({ selectable: false, reason: "no-recorded-pass" });
  });
});
