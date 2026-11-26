/**
 * Tests for the provider-terms domain guard. Imports the package entry point
 * (the same surface a production caller sees), `types.isProxy` from
 * `node:util` (infrastructure callers must inject the detector the same way)
 * and the test-only registry-taking helpers from the fixture.
 *
 * Every test title states what it asserts; every body proves it against a
 * real input, so a constant-`false` or identity implementation fails.
 */

import { describe, expect, it } from "vitest";
import types from "node:util/types";

import {
  DEFAULT_PROVIDER_TERMS_REGISTRY,
  RECORDED_PROVIDER_PASSES,
  decideProviderSelectability,
  isProviderSelectable,
} from "../../index.js";
import {
  createTestProviderTermsRegistry,
  decideTestProviderSelectability,
  isTestProviderSelectable,
} from "./provider-terms-fixture.js";
import type { ProviderTermsRegistry } from "../provider-terms.js";

const isProxy = types.isProxy.bind(types);

const VALID_PROVIDER_ID = "provider-one";

const VALID_PASS = {
  providerId: VALID_PROVIDER_ID,
  reviewedAtIso: "2026-01-02T03:04:05.000Z",
  reviewer: "reviewer@example.test",
};

/**
 * Build the one-pass fixture registry through the factory and return the
 * registry the factory itself produced, so selection tests exercise what
 * `createTestProviderTermsRegistry` recorded rather than a hand-built
 * literal.
 */
function onePassRegistry(): ProviderTermsRegistry {
  const built = createTestProviderTermsRegistry([VALID_PASS], isProxy);
  if (!built.ok) {
    throw new Error(`fixture registry refused: ${built.reason}`);
  }
  return built.registry;
}

describe("provider-terms registry shape", () => {
  it("exports a frozen DEFAULT_PROVIDER_TERMS_REGISTRY whose passes array is empty", () => {
    expect(Object.isFrozen(DEFAULT_PROVIDER_TERMS_REGISTRY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROVIDER_TERMS_REGISTRY.passes)).toBe(true);
    expect(DEFAULT_PROVIDER_TERMS_REGISTRY.passes).toHaveLength(0);
  });

  it("exports a frozen and empty RECORDED_PROVIDER_PASSES", () => {
    expect(Object.isFrozen(RECORDED_PROVIDER_PASSES)).toBe(true);
    expect(RECORDED_PROVIDER_PASSES).toHaveLength(0);
  });
});

describe("decideProviderSelectability against the default registry", () => {
  it("returns selectable false with reason no-recorded-pass for a valid-shaped id", () => {
    expect(decideProviderSelectability("anything")).toEqual({
      selectable: false,
      reason: "no-recorded-pass",
    });
    expect(decideProviderSelectability(VALID_PROVIDER_ID)).toEqual({
      selectable: false,
      reason: "no-recorded-pass",
    });
  });

  it("isProviderSelectable returns false for 'anything', unknown ids and valid-shaped ids", () => {
    expect(isProviderSelectable("anything")).toBe(false);
    expect(isProviderSelectable("nope")).toBe(false);
    expect(isProviderSelectable(VALID_PROVIDER_ID)).toBe(false);
  });
});

describe("providerId validation", () => {
  it("refuses null and undefined providerId without throwing", () => {
    for (const value of [null, undefined]) {
      expect(decideProviderSelectability(value)).toEqual({
        selectable: false,
        reason: "invalid-provider-id",
      });
      expect(isProviderSelectable(value)).toBe(false);
    }
  });

  it("refuses non-string, empty, oversized and malformed providerId values", () => {
    const oversized = "a".repeat(64);
    for (const value of [
      1,
      true,
      Symbol("s"),
      BigInt(1),
      () => "fn",
      NaN,
      Infinity,
      "",
      oversized,
      "-bad",
      "Bad",
      "a_b",
      "has space",
    ]) {
      expect(decideProviderSelectability(value)).toEqual({
        selectable: false,
        reason: "invalid-provider-id",
      });
      expect(isProviderSelectable(value)).toBe(false);
    }
  });

  it("refuses a Proxy providerId via the injected detector without running any Proxy trap", () => {
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error("trap ran");
        },
      },
    );
    expect(decideProviderSelectability(trapped, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-provider-id",
    });
  });
});

describe("test-fixture registry selection", () => {
  it("builds a registry from a valid one-entry pass list and selects that exact providerId", () => {
    const built = createTestProviderTermsRegistry([VALID_PASS], isProxy);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return; // narrows `built` for the assertions below
    }
    // The registry the factory itself produced carries the recorded pass:
    // it selects the pass's exact providerId, proving the factory recorded
    // the supplied pass rather than returning an empty registry.
    expect(built.registry.passes).toEqual([VALID_PASS]);
    expect(decideTestProviderSelectability(built.registry, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: true,
    });
    expect(isTestProviderSelectable(built.registry, VALID_PROVIDER_ID, isProxy)).toBe(true);
    expect(onePassRegistry().passes).toEqual([VALID_PASS]);
  });

  it("refuses with no-recorded-pass for any other id on the factory-built registry", () => {
    expect(decideTestProviderSelectability(onePassRegistry(), "other-provider", isProxy)).toEqual({
      selectable: false,
      reason: "no-recorded-pass",
    });
  });

  it("refuses null and undefined providerId, registry, passes, and pass elements without throwing", () => {
    for (const value of [null, undefined]) {
      expect(decideTestProviderSelectability(value, VALID_PROVIDER_ID, isProxy)).toEqual({
        selectable: false,
        reason: "invalid-registry",
      });
      expect(createTestProviderTermsRegistry(value, isProxy)).toEqual({
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
    }
  });

  it("refuses non-iterable passes and non-array registry.passes", () => {
    for (const value of [1, true, {}]) {
      expect(createTestProviderTermsRegistry(value, isProxy)).toEqual({
        ok: false,
        reason: "invalid-passes",
      });
      expect(decideTestProviderSelectability({ passes: value }, VALID_PROVIDER_ID, isProxy)).toEqual({
        selectable: false,
        reason: "invalid-registry",
      });
    }
  });

  it("refuses sparse arrays with array holes", () => {
    const holey: unknown[] = new Array(2);
    holey[1] = VALID_PASS;
    expect(createTestProviderTermsRegistry(holey, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(decideTestProviderSelectability({ passes: holey }, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("refuses wrong primitive types for providerId, registry, and pass fields", () => {
    for (const value of [1, true, Symbol("s"), BigInt(1), NaN, Infinity, -0]) {
      expect(decideProviderSelectability(value)).toEqual({
        selectable: false,
        reason: "invalid-provider-id",
      });
      expect(createTestProviderTermsRegistry([{ ...VALID_PASS, providerId: value }], isProxy)).toEqual({
        ok: false,
        reason: "invalid-provider-id",
      });
      expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewedAtIso: value }], isProxy)).toEqual({
        ok: false,
        reason: "invalid-reviewed-at",
      });
      expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewer: value }], isProxy)).toEqual({
        ok: false,
        reason: "invalid-reviewer",
      });
      expect(decideTestProviderSelectability(value, VALID_PROVIDER_ID, isProxy)).toEqual({
        selectable: false,
        reason: "invalid-registry",
      });
    }
  });

  it("refuses objects and arrays with getters without invoking the getter", () => {
    let getterRan = false;
    const hostilePass = {
      get providerId() {
        getterRan = true;
        return VALID_PROVIDER_ID;
      },
      reviewedAtIso: VALID_PASS.reviewedAtIso,
      reviewer: VALID_PASS.reviewer,
    };
    expect(createTestProviderTermsRegistry([hostilePass], isProxy)).toEqual({
      ok: false,
      reason: "invalid-provider-id",
    });
    expect(getterRan).toBe(false);
    const hostileRegistry = {
      get passes() {
        getterRan = true;
        return [VALID_PASS];
      },
    };
    expect(decideTestProviderSelectability(hostileRegistry, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(getterRan).toBe(false);
  });

  it("refuses Proxy inputs via the injected detector without running any Proxy trap", () => {
    let trapRan = false;
    const trapped = new Proxy(
      { passes: [VALID_PASS] },
      {
        get() {
          trapRan = true;
          return [VALID_PASS];
        },
      },
    );
    expect(decideTestProviderSelectability(trapped, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(createTestProviderTermsRegistry(new Proxy([VALID_PASS], {}), isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(trapRan).toBe(false);
  });

  it("refuses array-like objects where an array is expected", () => {
    const arrayLike = { length: 1, 0: VALID_PASS };
    expect(createTestProviderTermsRegistry(arrayLike, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    expect(decideTestProviderSelectability({ passes: arrayLike }, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("refuses enormous array lengths and oversized strings in bounded time", () => {
    const giant = new Array(65);
    giant[0] = VALID_PASS;
    expect(createTestProviderTermsRegistry(giant, isProxy)).toEqual({
      ok: false,
      reason: "invalid-passes",
    });
    const longReviewer = "r".repeat(121);
    expect(
      createTestProviderTermsRegistry([{ ...VALID_PASS, reviewer: longReviewer }], isProxy),
    ).toEqual({ ok: false, reason: "invalid-reviewer" });
    expect(decideProviderSelectability("a".repeat(64))).toEqual({
      selectable: false,
      reason: "invalid-provider-id",
    });
  });

  it("refuses prototype-polluting keys, symbol keys, non-enumerable keys, non-plain prototypes, and extra or missing keys", () => {
    const protoEntry = JSON.parse('{"providerId":"provider-one","reviewedAtIso":"2026-01-02T03:04:05.000Z","reviewer":"r","__proto__":{}}');
    expect(createTestProviderTermsRegistry([protoEntry], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const symbolEntry = { ...VALID_PASS, [Symbol("x")]: 1 };
    expect(createTestProviderTermsRegistry([symbolEntry], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const nonEnumerable = { ...VALID_PASS };
    Object.defineProperty(nonEnumerable, "reviewer", {
      value: VALID_PASS.reviewer,
      enumerable: false,
    });
    expect(createTestProviderTermsRegistry([nonEnumerable], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
    class NotPlain {
      providerId = VALID_PROVIDER_ID;
      reviewedAtIso = VALID_PASS.reviewedAtIso;
      reviewer = VALID_PASS.reviewer;
    }
    expect(createTestProviderTermsRegistry([new NotPlain()], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const extraKey = { ...VALID_PASS, extra: 1 };
    expect(createTestProviderTermsRegistry([extraKey], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const missingField = { providerId: VALID_PROVIDER_ID, reviewedAtIso: VALID_PASS.reviewedAtIso };
    expect(createTestProviderTermsRegistry([missingField], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
    const missingPasses = { nope: [] };
    expect(decideTestProviderSelectability(missingPasses, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("returns false for any providerId on DEFAULT_PROVIDER_TERMS_REGISTRY and for unknown ids on a populated fixture registry", () => {
    for (const id of ["anything", VALID_PROVIDER_ID, "unknown-provider"]) {
      expect(isProviderSelectable(id)).toBe(false);
    }
    expect(isTestProviderSelectable(onePassRegistry(), "unknown-provider", isProxy)).toBe(false);
  });
});

describe("hostile fixture inputs", () => {
  it("refuses null and undefined fixture providerId values with invalid-provider-id", () => {
    for (const id of [null, undefined]) {
      expect(decideTestProviderSelectability(onePassRegistry(), id, isProxy)).toEqual({
        selectable: false,
        reason: "invalid-provider-id",
      });
      expect(isTestProviderSelectable(onePassRegistry(), id, isProxy)).toBe(false);
    }
  });

  it("refuses null and undefined pass fields with the field's typed reason", () => {
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, providerId: null }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-provider-id",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewedAtIso: null }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewed-at",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewer: null }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, providerId: undefined }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-provider-id",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewedAtIso: undefined }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewed-at",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewer: undefined }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
  });

  it("refuses function-valued pass fields without calling them", () => {
    let called = false;
    const fn = (): string => {
      called = true;
      return VALID_PROVIDER_ID;
    };
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, providerId: fn }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-provider-id",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewedAtIso: fn }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewed-at",
    });
    expect(createTestProviderTermsRegistry([{ ...VALID_PASS, reviewer: fn }], isProxy)).toEqual({
      ok: false,
      reason: "invalid-reviewer",
    });
    expect(called).toBe(false);
  });

  it("refuses oversized pass strings with the field's typed reason", () => {
    expect(
      createTestProviderTermsRegistry(
        [{ ...VALID_PASS, providerId: "a".repeat(64) }],
        isProxy,
      ),
    ).toEqual({ ok: false, reason: "invalid-provider-id" });
    expect(
      createTestProviderTermsRegistry(
        [{ ...VALID_PASS, reviewedAtIso: `2026-01-02T03:04:05.000${"0".repeat(4096)}Z` }],
        isProxy,
      ),
    ).toEqual({ ok: false, reason: "invalid-reviewed-at" });
    expect(
      createTestProviderTermsRegistry([{ ...VALID_PASS, reviewer: "r".repeat(4097) }], isProxy),
    ).toEqual({ ok: false, reason: "invalid-reviewer" });
  });

  it("refuses a registry whose passes array exceeds the 64-entry bound", () => {
    const giant = Array.from({ length: 65 }, (_, i) => ({
      ...VALID_PASS,
      providerId: `provider-${i}`,
    }));
    expect(decideTestProviderSelectability({ passes: giant }, "provider-0", isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });

  it("refuses array-index getters on the passes array without invoking the getter", () => {
    let getterRan = false;
    const passes: unknown[] = [];
    Object.defineProperty(passes, 0, {
      enumerable: true,
      get() {
        getterRan = true;
        return VALID_PASS;
      },
    });
    expect(createTestProviderTermsRegistry(passes, isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    expect(getterRan).toBe(false);
    expect(decideTestProviderSelectability({ passes }, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
    expect(getterRan).toBe(false);
  });

  it("refuses own constructor and prototype keys on pass entries and the registry", () => {
    const constructorEntry = JSON.parse(
      '{"providerId":"provider-one","reviewedAtIso":"2026-01-02T03:04:05.000Z","reviewer":"r","constructor":{}}',
    );
    expect(createTestProviderTermsRegistry([constructorEntry], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const prototypeEntry = JSON.parse(
      '{"providerId":"provider-one","reviewedAtIso":"2026-01-02T03:04:05.000Z","reviewer":"r","prototype":{}}',
    );
    expect(createTestProviderTermsRegistry([prototypeEntry], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pass-entry",
    });
    const pollutedRegistry = JSON.parse(
      '{"passes":[],"constructor":{}}',
    );
    expect(decideTestProviderSelectability(pollutedRegistry, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: false,
      reason: "invalid-registry",
    });
  });
});

describe("export surface", () => {
  it("exports the expected symbols and never a registry-taking factory", async () => {
    const entry = await import("../../index.js");
    const keys = Object.keys(entry);
    expect(keys).toContain("DEFAULT_PROVIDER_TERMS_REGISTRY");
    expect(keys).toContain("RECORDED_PROVIDER_PASSES");
    expect(keys).toContain("isProviderSelectable");
    expect(keys).toContain("decideProviderSelectability");
    expect(keys).not.toContain("createProviderTermsRegistry");
  });

  it("does not let an extra second argument select a provider (no runtime registry injection)", () => {
    expect(isProviderSelectable("anything", { passes: [VALID_PASS] } as never)).toBe(false);
    expect(decideProviderSelectability("anything", { passes: [VALID_PASS] } as never)).toEqual({
      selectable: false,
      reason: "no-recorded-pass",
    });
  });
});
