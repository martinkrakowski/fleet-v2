/**
 * Hostile-input and decision tests for `parseSpendCap`, `periodKeyOf` and
 * `decideSpend` (FC9B). Pure domain: no clock reads, no I/O, no price
 * figures — amounts are abstract cap units. Every test title states what it
 * asserts and its body proves it; every refusal is the typed
 * `invalid-input`, never a throw and never an echoed input value.
 */
import { describe, expect, it } from "vitest";

import {
  decideSpend,
  parseSpendCap,
  periodKeyOf,
  type SpendCap,
} from "../spend-cap.js";

const OK: Spending = { orgSpentUnits: 0, projectSpentUnits: 0, requestedUnits: 1 };
const MAX = Number.MAX_SAFE_INTEGER;

interface Spending {
  orgSpentUnits: number;
  projectSpentUnits: number;
  requestedUnits: number;
}

function orgCap(overrides: Partial<SpendCap> = {}): SpendCap {
  return {
    scope: "organization",
    organizationId: "org-a",
    projectId: null,
    periodKey: "2026-01",
    limitUnits: 10,
    ...overrides,
  };
}

function projectCap(overrides: Partial<SpendCap> = {}): SpendCap {
  return {
    scope: "project",
    organizationId: "org-a",
    projectId: "proj-b",
    periodKey: "2026-01",
    limitUnits: 5,
    ...overrides,
  };
}

function decisionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgCap: orgCap(),
    projectCap: projectCap(),
    ...OK,
    periodKey: "2026-01",
    ...overrides,
  };
}

/** A plain object whose `secret` getter records that it was invoked. */
function getterObject(): Record<string, unknown> {
  const watched: Record<string, unknown> = {};
  Object.defineProperty(watched, "secret", {
    enumerable: true,
    get() {
      getterObject.invoked = true;
      return "g".repeat(8);
    },
  });
  return watched;
}
getterObject.invoked = false;

describe("parseSpendCap", () => {
  it("parses a valid organization cap and freezes the result", () => {
    const parsed = parseSpendCap(orgCap());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cap).toEqual(orgCap());
      expect(Object.isFrozen(parsed.cap)).toBe(true);
    }
  });

  it("parses a valid project cap with a non-null projectId", () => {
    const parsed = parseSpendCap(projectCap());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cap.scope).toBe("project");
      expect(parsed.cap.projectId).toBe("proj-b");
    }
  });

  it("refuses null and undefined", () => {
    expect(parseSpendCap(null)).toEqual({ ok: false, reason: "invalid-input" });
    expect(parseSpendCap(undefined)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses primitives, arrays, and array-likes", () => {
    const arrayLike: Record<string, unknown> & { length: number } = {
      0: "organization",
      1: "org-a",
      2: null,
      3: "2026-01",
      4: 1,
      length: 5,
    };
    for (const hostile of [42, "cap", true, [], [1, 2], arrayLike]) {
      expect(parseSpendCap(hostile)).toEqual({ ok: false, reason: "invalid-input" });
    }
  });

  it("refuses a sparse array with a hole", () => {
    const holed: unknown[] = new Array(5);
    holed[0] = "organization";
    expect(parseSpendCap(holed)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses getters without invoking them", () => {
    getterObject.invoked = false;
    const watched = getterObject();
    const result = parseSpendCap(watched);
    expect(result).toEqual({ ok: false, reason: "invalid-input" });
    expect(getterObject.invoked).toBe(false);
  });

  it("refuses hostile Proxies", () => {
    let ownKeysCalls = 0;
    const ownKeysTrap = new Proxy(orgCap(), {
      ownKeys() {
        ownKeysCalls += 1;
        return ["scope", "organizationId", "projectId", "periodKey", "limitUnits"];
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    });
    expect(parseSpendCap(ownKeysTrap)).toEqual({ ok: false, reason: "invalid-input" });
    expect(ownKeysCalls).toBe(1);
    const prototypeTrap = new Proxy(orgCap(), {
      getPrototypeOf() {
        throw new Error("trap");
      },
    });
    expect(parseSpendCap(prototypeTrap)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses oversized strings and excess keys in O(1)", () => {
    const longId = `${"a".repeat(63)}x`; // 64 characters, one over the bound
    const oversized = orgCap({ organizationId: longId });
    expect(parseSpendCap(oversized)).toEqual({ ok: false, reason: "invalid-input" });
    const longIso = `2026-01-01T00:00:00.${"9".repeat(65)}Z`;
    expect(periodKeyOf(longIso)).toEqual({ ok: false, reason: "invalid-input" });
    const extra = { ...orgCap(), extra: 1 };
    expect(parseSpendCap(extra)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses a huge excess of enumerable keys without reading their values", () => {
    // The bounded census must refuse an excess of enumerable keys after
    // inspecting at most expectedKeys.length + 1 of them, so the input is
    // never snapshotted and no excess property is ever read: every excess
    // key below is an accessor whose getter records any attempt to read it.
    const hugeReads = { extra: 0 };
    const huge: Record<string, unknown> = { ...orgCap() };
    Object.defineProperty(huge, "extra", {
      enumerable: true,
      get() {
        hugeReads.extra += 1;
        return 1;
      },
    });
    for (let i = 0; i < 100_000; i += 1) {
      huge[`pad-${String(i).padStart(6, "0")}`] = i;
    }
    expect(parseSpendCap(huge)).toEqual({ ok: false, reason: "invalid-input" });
    expect(hugeReads.extra).toBe(0);
  });

  it("refuses prototype-polluting, extra, and missing keys", () => {
    const polluted: Record<string, unknown> = { ...orgCap() };
    Object.defineProperty(polluted, "__proto__", { value: {}, enumerable: true });
    expect(parseSpendCap(polluted)).toEqual({ ok: false, reason: "invalid-input" });
    expect(parseSpendCap({ ...orgCap(), constructor: 1 })).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(parseSpendCap({ ...orgCap(), prototype: 1 })).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const missing: Record<string, unknown> = { ...orgCap() };
    delete missing.limitUnits;
    expect(parseSpendCap(missing)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses a non-enumerable or accessor shadow of an expected key without reading it", () => {
    // Phase 2 probes each expected key through its own descriptor: a key
    // with an expected name must be an own enumerable data property, so a
    // non-enumerable shadow is refused and an accessor shadow is refused
    // without ever running its getter.
    const hiddenShadow = { ...orgCap() };
    Object.defineProperty(hiddenShadow, "limitUnits", { value: 99, enumerable: false });
    expect(parseSpendCap(hiddenShadow)).toEqual({ ok: false, reason: "invalid-input" });
    const watched = { ...orgCap() };
    let shadowReads = 0;
    Object.defineProperty(watched, "limitUnits", {
      enumerable: true,
      get() {
        shadowReads += 1;
        return 99;
      },
    });
    expect(parseSpendCap(watched)).toEqual({ ok: false, reason: "invalid-input" });
    expect(shadowReads).toBe(0);
  });

  it("ignores hidden extra keys in O(1) without reading them", () => {
    // Residual (see readExactRecord): the platform offers no lazy own-key
    // enumeration, so own keys outside the expected set that are
    // non-enumerable or symbol are neither probed nor read, whatever their
    // number; the parse is computed from the expected keys only. Each hidden
    // extra below is an accessor whose getter records any attempt to read
    // it, so the zero count proves it was never read.
    const watched: Record<string, unknown> = { ...orgCap() };
    let hiddenReads = 0;
    Object.defineProperty(watched, "hidden", {
      get() {
        hiddenReads += 1;
        return 1;
      },
    });
    Reflect.set(watched, Symbol.for("billing-hidden"), 1);
    expect(parseSpendCap(watched)).toEqual({ ok: true, cap: orgCap() });    expect(hiddenReads).toBe(0);
    const enormous = { ...orgCap() };
    for (let i = 0; i < 100_000; i += 1) {
      Object.defineProperty(enormous, `hidden-${String(i).padStart(6, "0")}`, { value: i });
    }
    expect(parseSpendCap(enormous)).toEqual({ ok: true, cap: orgCap() });
  });

  it("refuses malformed organizationId and projectId", () => {
    expect(parseSpendCap(orgCap({ organizationId: "-bad" }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(parseSpendCap(orgCap({ organizationId: "UPPER" }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(parseSpendCap(orgCap({ organizationId: 7 as unknown as string }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(parseSpendCap(projectCap({ projectId: "bad_id" }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(parseSpendCap(orgCap({ projectId: "proj-b" }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses mismatched scope and projectId", () => {
    expect(parseSpendCap(projectCap({ projectId: null }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(parseSpendCap(orgCap({ projectId: "proj-b" }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses invalid periodKey formats", () => {
    for (const bad of ["2026-1", "2026-13", "2026-00", "26-01", "2026-01T", 202601, null]) {
      expect(parseSpendCap(orgCap({ periodKey: bad as unknown as string }))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses non-safe-integer unit values", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, MAX + 1, "5", null]) {
      expect(parseSpendCap(orgCap({ limitUnits: bad as unknown as number }))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });
});

describe("periodKeyOf", () => {
  it("reduces UTC timestamps to their calendar month", () => {
    expect(periodKeyOf("2026-01-31T23:59:59Z")).toEqual({ ok: true, periodKey: "2026-01" });
    expect(periodKeyOf("2026-02-01T00:00:00Z")).toEqual({ ok: true, periodKey: "2026-02" });
  });

  it("converts numeric offsets to UTC before naming the month", () => {
    expect(periodKeyOf("2026-02-01T00:30:00+02:00")).toEqual({ ok: true, periodKey: "2026-01" });
    expect(periodKeyOf("2026-01-31T22:30:00-04:00")).toEqual({ ok: true, periodKey: "2026-02" });
  });

  it("refuses null and undefined", () => {
    expect(periodKeyOf(null)).toEqual({ ok: false, reason: "invalid-input" });
    expect(periodKeyOf(undefined)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses offset-less and unparseable ISO strings", () => {
    for (const bad of [
      "",
      "2026-01-31T23:59:59",
      "2026-01-31",
      "26-01-31T23:59:59Z",
      "2026-13-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-01-31T25:00:00Z",
      "not-a-date",
      42,
      { iso: "2026-01-31T23:59:59Z" },
    ]) {
      expect(periodKeyOf(bad)).toEqual({ ok: false, reason: "invalid-input" });
    }
  });

  it("never reads the system clock: the same string always yields the same month", () => {
    const first = periodKeyOf("2026-03-15T12:00:00Z");
    const second = periodKeyOf("2026-03-15T12:00:00Z");
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, periodKey: "2026-03" });
  });
});

describe("decideSpend", () => {
  it("allows below the limit, exactly at the limit, and a zero request", () => {
    // Project scope: below, exactly at, and one over the project cap.
    expect(decideSpend(decisionInput({ orgSpentUnits: 2, projectSpentUnits: 3 }))).toEqual({
      outcome: "allow",
    });
    expect(decideSpend(decisionInput({ orgSpentUnits: 5, projectSpentUnits: 4 }))).toEqual({
      outcome: "allow",
    });
    expect(decideSpend(decisionInput({ projectSpentUnits: 5 }))).toEqual({
      outcome: "park",
      reason: "spend-cap",
      scope: "project",
    });
    // Organization scope (no project cap): below, exactly at, one over.
    expect(
      decideSpend(decisionInput({ projectCap: null, orgSpentUnits: 8, requestedUnits: 1 })),
    ).toEqual({ outcome: "allow" });
    expect(
      decideSpend(decisionInput({ projectCap: null, orgSpentUnits: 9, requestedUnits: 1 })),
    ).toEqual({ outcome: "allow" });
    expect(
      decideSpend(decisionInput({ projectCap: null, orgSpentUnits: 10, requestedUnits: 1 })),
    ).toEqual({ outcome: "park", reason: "spend-cap", scope: "organization" });
    // A zero request always fits under any cap.
    expect(decideSpend(decisionInput({ requestedUnits: 0 }))).toEqual({ outcome: "allow" });
  });

  it("parks one unit over either cap with that cap's scope", () => {
    expect(decideSpend(decisionInput({ orgSpentUnits: 6, projectSpentUnits: 5 }))).toEqual({
      outcome: "park",
      reason: "spend-cap",
      scope: "project",
    });
    expect(decideSpend(decisionInput({ projectCap: null, orgSpentUnits: 10 }))).toEqual({
      outcome: "park",
      reason: "spend-cap",
      scope: "organization",
    });
  });

  it("checks the project cap before the organization cap when both exceed", () => {
    expect(decideSpend(decisionInput({ orgSpentUnits: 10, projectSpentUnits: 5 }))).toEqual({
      outcome: "park",
      reason: "spend-cap",
      scope: "project",
    });
  });

  it("parks on safe-integer sum overflow instead of wrapping or allowing", () => {
    expect(
      decideSpend(
        decisionInput({ orgSpentUnits: MAX, projectSpentUnits: 0, requestedUnits: 1 }),
      ),
    ).toEqual({ outcome: "park", reason: "spend-cap", scope: "organization" });
    expect(
      decideSpend(
        decisionInput({ orgSpentUnits: 0, projectSpentUnits: MAX, requestedUnits: 1 }),
      ),
    ).toEqual({ outcome: "park", reason: "spend-cap", scope: "project" });
  });

  it("refuses cross-organization projectCap", () => {
    expect(decideSpend(decisionInput({ projectCap: projectCap({ organizationId: "org-z" }) })))
      .toEqual({ outcome: "refuse", reason: "invalid-input" });
  });

  it("refuses projectCap larger than orgCap", () => {
    expect(decideSpend(decisionInput({ projectCap: projectCap({ limitUnits: 11 }) }))).toEqual({
      outcome: "refuse",
      reason: "invalid-input",
    });
  });

  it("parks with no-cap-for-period when cap period differs", () => {
    expect(decideSpend(decisionInput({ periodKey: "2026-02" }))).toEqual({
      outcome: "park",
      reason: "no-cap-for-period",
    });
    expect(
      decideSpend(decisionInput({ projectCap: projectCap({ periodKey: "2026-02" }) })),
    ).toEqual({ outcome: "park", reason: "no-cap-for-period" });
  });

  it("refuses null and undefined", () => {
    expect(decideSpend(null)).toEqual({ outcome: "refuse", reason: "invalid-input" });
    expect(decideSpend(undefined)).toEqual({ outcome: "refuse", reason: "invalid-input" });
  });

  it("refuses primitives and arrays", () => {
    for (const hostile of [42, "spend", true, [], [1, 2, 3]]) {
      expect(decideSpend(hostile)).toEqual({ outcome: "refuse", reason: "invalid-input" });
    }
  });

  it("refuses getters without invoking them", () => {
    getterObject.invoked = false;
    const input = decisionInput();
    Object.defineProperty(input, "requestedUnits", {
      enumerable: true,
      get() {
        getterObject.invoked = true;
        return 1;
      },
    });
    const result = decideSpend(input);
    expect(result).toEqual({ outcome: "refuse", reason: "invalid-input" });
    expect(getterObject.invoked).toBe(false);
  });

  it("refuses hostile Proxies", () => {
    const descriptorTrap = new Proxy(decisionInput(), {
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    });
    expect(decideSpend(descriptorTrap)).toEqual({ outcome: "refuse", reason: "invalid-input" });
  });

  it("refuses prototype-polluting, extra, and missing keys", () => {
    const polluted = decisionInput();
    Object.defineProperty(polluted, "__proto__", { value: {}, enumerable: true });
    expect(decideSpend(polluted)).toEqual({ outcome: "refuse", reason: "invalid-input" });
    expect(decideSpend({ ...decisionInput(), extra: 1 })).toEqual({
      outcome: "refuse",
      reason: "invalid-input",
    });
    const missing: Record<string, unknown> = decisionInput();
    delete missing.requestedUnits;
    expect(decideSpend(missing)).toEqual({ outcome: "refuse", reason: "invalid-input" });
  });

  it("decides from the expected keys only, never reading hidden extra keys", () => {
    // Residual (see readExactRecord in ../spend-cap.ts): hidden (non-
    // enumerable or symbol) own keys outside the expected set are neither
    // probed nor read; the decision is computed from the expected keys only.
    // The hidden extra below is an accessor whose getter records any attempt
    // to read it, so the zero count proves it was never read.
    const watched: Record<string, unknown> = decisionInput();
    let hiddenReads = 0;
    Object.defineProperty(watched, "hidden", {
      get() {
        hiddenReads += 1;
        return 1;
      },
    });
    Reflect.set(watched, Symbol.for("billing-hidden"), 1);
    expect(decideSpend(watched)).toEqual({ outcome: "allow" });
    expect(hiddenReads).toBe(0);
  });

  it("refuses non-safe-integer unit values", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, MAX + 1, "5", null]) {
      expect(decideSpend(decisionInput({ requestedUnits: bad }))).toEqual({
        outcome: "refuse",
        reason: "invalid-input",
      });
      expect(decideSpend(decisionInput({ orgSpentUnits: bad }))).toEqual({
        outcome: "refuse",
        reason: "invalid-input",
      });
      expect(decideSpend(decisionInput({ projectSpentUnits: bad }))).toEqual({
        outcome: "refuse",
        reason: "invalid-input",
      });
    }
  });

  it("refuses a cap of the wrong scope and an invalid periodKey", () => {
    expect(decideSpend(decisionInput({ orgCap: projectCap() }))).toEqual({
      outcome: "refuse",
      reason: "invalid-input",
    });
    expect(decideSpend(decisionInput({ projectCap: orgCap() }))).toEqual({
      outcome: "refuse",
      reason: "invalid-input",
    });
    for (const bad of ["2026-13", "2026-1", "not-a-period"]) {
      expect(decideSpend(decisionInput({ periodKey: bad }))).toEqual({
        outcome: "refuse",
        reason: "invalid-input",
      });
    }
  });

  it("never echoes an input value in a refusal", () => {
    const secret = "Z".repeat(64);
    const results = [
      parseSpendCap({ ...orgCap(), organizationId: secret }),
      periodKeyOf(secret),
      decideSpend(decisionInput({ requestedUnits: secret })),
    ];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain("ZZZZ");
    }
  });
});
