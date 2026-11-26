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

const isProxy = types.isProxy.bind(types);

const VALID_PROVIDER_ID = "provider-one";

const VALID_PASS = {
  providerId: VALID_PROVIDER_ID,
  reviewedAtIso: "2026-01-02T03:04:05.000Z",
  reviewer: "reviewer@example.test",
};

/** Register exactly one pass for `provider-one`. */
function onePassRegistry(): { ok: true } {
  const built = createTestProviderTermsRegistry([VALID_PASS], isProxy);
  if (!built.ok) {
    throw new Error(`fixture registry refused: ${built.reason}`);
  }
  return built;
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
    expect(decideTestProviderSelectability({ passes: [VALID_PASS] }, VALID_PROVIDER_ID, isProxy)).toEqual({
      selectable: true,
    });
    expect(isTestProviderSelectable({ passes: [VALID_PASS] }, VALID_PROVIDER_ID, isProxy)).toBe(true);
    void onePassRegistry;
  });

  it("refuses with no-recorded-pass for any other id on a populated fixture registry", () => {
    expect(decideTestProviderSelectability({ passes: [VALID_PASS] }, "other-provider", isProxy)).toEqual({
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
    expect(isTestProviderSelectable({ passes: [VALID_PASS] }, "unknown-provider", isProxy)).toBe(false);
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
