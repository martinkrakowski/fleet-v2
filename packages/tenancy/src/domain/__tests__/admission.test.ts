/**
 * Tests for the pure outside-organisation admission decision (FC3C).
 *
 * Cost bound under test: `decideOutsideTenantAdmission` is O(1) — an
 * immediate `Reflect.ownKeys` length check followed by a fixed 3-key
 * descriptor pass, three bounded field checks and one id-pattern test.
 *
 * Every test title states what it asserts, and its body proves it. A
 * constant `{ admitted: false }` implementation fails the admit cases;
 * an identity `(id) => ({ admitted: true })` fails every refusal case.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORGANIZATION_ID,
  decideOutsideTenantAdmission,
  type AdmissionGateRecord,
} from "../index.js";

/** A valid, open gate; individual tests mutate a shallow copy. */
const openGate: AdmissionGateRecord = {
  state: "open",
  recordedBy: "operator",
  recordedAtIso: "2026-05-04T12:00:00Z",
};

const OTHER_ORG = "other-org";

/** Build an oversized string at runtime; no oversized literal appears. */
const filler = (unit: string, count: number): string => unit.repeat(count);

/** Assert a decision is a refusal and return its reason for further checks. */
const reasonOf = (decision: ReturnType<typeof decideOutsideTenantAdmission>): string => {
  expect(decision.admitted).toBe(false);
  return decision.admitted ? "" : decision.reason;
};

describe("decideOutsideTenantAdmission refuses hostile organizationId inputs", () => {
  const hostileIds: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a boolean", true],
    ["an object", {}],
    ["an array", ["default"]],
    ["an empty string", ""],
    ["a string with a space", "other org"],
    ["an uppercase id", "Other-Org"],
    ["a path traversal id", "../etc"],
    ["a leading dash id", "-org"],
    ["an oversized id", filler("a", 65)],
  ];

  for (const [label, value] of hostileIds) {
    it(`refuses non-string, malformed, or oversized organizationId: ${label}`, () => {
      const decision = decideOutsideTenantAdmission(value, openGate);
      expect(decision).toEqual({ admitted: false, reason: "invalid-organization-id" });
    });
  }
});

describe("decideOutsideTenantAdmission refuses hostile gate inputs", () => {
  const hostileGates: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["the string 'open'", "open"],
    ["the string 'closed'", "closed"],
    ["true", true],
    ["1", 1],
    ["an empty array", []],
    ["an array of the three keys", ["state", "recordedBy", "recordedAtIso"]],
    ["an array-like", { length: 0 }],
    ["an array-like with the keys", { length: 3, state: "open" }],
    ["a Date", new Date("2026-05-04T12:00:00Z")],
    ["a Map", new Map()],
    ["a function", (): void => undefined],
    ["an empty object", {}],
    ["an object missing recordedBy", { state: "open", recordedAtIso: openGate.recordedAtIso }],
    ["an object missing recordedAtIso", { state: "open", recordedBy: "operator" }],
    ["an object missing state", { recordedBy: "operator", recordedAtIso: openGate.recordedAtIso }],
    ["an object with an extra key", { ...openGate, extra: 1 }],
    ["an object with a symbol key", Object.assign({}, openGate, { [Symbol("x")]: 1 })],
    [
      "an object with a non-enumerable key",
      Object.defineProperties({ ...openGate }, { hidden: { value: 1, enumerable: false } }),
    ],
  ];

  for (const [label, gate] of hostileGates) {
    it(`refuses hostile gate input ${label} without throwing`, () => {
      const decision = decideOutsideTenantAdmission(OTHER_ORG, gate);
      expect(decision).toEqual({ admitted: false, reason: "invalid-gate" });
    });
  }
});

describe("decideOutsideTenantAdmission never invokes a getter", () => {
  it("refuses gate with accessor getter without invoking it", () => {
    let getterCalled = false;
    const gate = {
      get state(): string {
        getterCalled = true;
        return "open";
      },
      recordedBy: "operator",
      recordedAtIso: openGate.recordedAtIso,
    };
    const decision = decideOutsideTenantAdmission(OTHER_ORG, gate);
    expect(decision).toEqual({ admitted: false, reason: "invalid-gate" });
    expect(getterCalled).toBe(false);
  });
});

describe("decideOutsideTenantAdmission refuses gate key-set violations", () => {
  it("refuses gate with extra, missing, non-enumerable, or prototype-polluting keys", () => {
    const valid = { ...openGate };
    expect(reasonOf(decideOutsideTenantAdmission(OTHER_ORG, { ...valid, extra: 1 }))).toBe("invalid-gate");
    expect(reasonOf(decideOutsideTenantAdmission(OTHER_ORG, { state: "open" }))).toBe("invalid-gate");
    expect(
      reasonOf(
        decideOutsideTenantAdmission(
          OTHER_ORG,
          Object.defineProperties({ ...valid }, { recordedBy: { value: "operator", enumerable: false } }),
        ),
      ),
    ).toBe("invalid-gate");
    const polluted = JSON.parse(
      '{"state":"open","recordedBy":"operator","recordedAtIso":"2026-05-04T12:00:00Z","__proto__":{}}',
    );
    expect(reasonOf(decideOutsideTenantAdmission(OTHER_ORG, polluted))).toBe("invalid-gate");
    const prototyped = JSON.parse(
      '{"state":"open","recordedBy":"operator","recordedAtIso":"2026-05-04T12:00:00Z","prototype":1}',
    );
    expect(reasonOf(decideOutsideTenantAdmission(OTHER_ORG, prototyped))).toBe("invalid-gate");
    const constructed = JSON.parse(
      '{"state":"open","recordedBy":"operator","recordedAtIso":"2026-05-04T12:00:00Z","constructor":1}',
    );
    expect(reasonOf(decideOutsideTenantAdmission(OTHER_ORG, constructed))).toBe("invalid-gate");
  });
});

describe("decideOutsideTenantAdmission refuses hostile Proxy gates without throwing", () => {
  it("refuses a Proxy whose getOwnPropertyDescriptor trap throws", () => {
    const target = { ...openGate };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
        throw new Error("never surfaced");
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a Proxy whose ownKeys trap throws", () => {
    const target = { ...openGate };
    const proxy = new Proxy(target, {
      ownKeys(): ArrayLike<string> {
        throw new Error("never surfaced");
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a Proxy that reports an extra own key the target does not have", () => {
    const target = { ...openGate };
    const proxy = new Proxy(target, {
      ownKeys(): ArrayLike<string> {
        return ["state", "recordedBy", "recordedAtIso", "extra"];
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a Proxy that reports a symbol key among the three keys", () => {
    const target = { ...openGate };
    const hidden = Symbol("hidden");
    const proxy = new Proxy(target, {
      ownKeys(): ArrayLike<string | symbol> {
        return ["state", "recordedBy", hidden];
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a Proxy whose getPrototypeOf trap throws", () => {
    const target = { ...openGate };
    const proxy = new Proxy(target, {
      getPrototypeOf(): object | null {
        throw new Error("never surfaced");
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a revoked Proxy without throwing", () => {
    const target = { ...openGate };
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a Proxy that reports three unrelated keys while fabricating valid descriptors", () => {
    const target = { ...openGate };
    const fakeDescriptor: PropertyDescriptor = {
      enumerable: true,
      value: "open",
      writable: true,
      configurable: true,
    };
    const proxy = new Proxy(target, {
      ownKeys(): ArrayLike<string> {
        return ["a", "b", "c"];
      },
      getOwnPropertyDescriptor(): PropertyDescriptor {
        return fakeDescriptor;
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });

  it("refuses a Proxy reporting a non-data accessor descriptor for state", () => {
    const target = { ...openGate };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(target_, key): PropertyDescriptor | undefined {
        if (key === "state") {
          return {
            enumerable: true,
            get(): string {
              return "open";
            },
          };
        }
        return Object.getOwnPropertyDescriptor(target_, key);
      },
    });
    expect(decideOutsideTenantAdmission(OTHER_ORG, proxy)).toEqual({
      admitted: false,
      reason: "invalid-gate",
    });
  });
});

describe("decideOutsideTenantAdmission refuses closed and non-open gate states", () => {
  const hostileStates: ReadonlyArray<readonly [string, unknown, string]> = [
    ["'closed'", "closed", "gate-closed"],
    ["'OPEN'", "OPEN", "invalid-gate-state"],
    ["'opened'", "opened", "invalid-gate-state"],
    ["true", true, "invalid-gate-state"],
    ["1", 1, "invalid-gate-state"],
    ["an empty string", "", "invalid-gate-state"],
    ["null", null, "invalid-gate-state"],
    ["undefined", undefined, "invalid-gate-state"],
  ];

  for (const [label, state, reason] of hostileStates) {
    it(`refuses non-open state variant ${label} for a non-default organisation`, () => {
      const decision = decideOutsideTenantAdmission(OTHER_ORG, { ...openGate, state });
      expect(decision).toEqual({ admitted: false, reason });
    });
  }
});

describe("decideOutsideTenantAdmission refuses hostile recordedBy values", () => {
  const hostileRecordedBy: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["an object", {}],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["an oversized string of 257 characters", filler("a", 257)],
  ];

  for (const [label, value] of hostileRecordedBy) {
    it(`refuses non-string, empty, whitespace-only, or oversized recordedBy: ${label}`, () => {
      const decision = decideOutsideTenantAdmission(OTHER_ORG, { ...openGate, recordedBy: value });
      expect(decision).toEqual({ admitted: false, reason: "invalid-recorded-by" });
    });
  }

  it("accepts a recordedBy of exactly 256 characters", () => {
    const decision = decideOutsideTenantAdmission(OTHER_ORG, {
      ...openGate,
      recordedBy: filler("a", 256),
    });
    expect(decision).toEqual({ admitted: true });
  });
});

describe("decideOutsideTenantAdmission refuses hostile recordedAtIso values", () => {
  const hostileIso: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 0],
    ["an unparseable string", "not-a-date"],
    ["a missing timezone", "2026-05-04T12:00:00"],
    ["an invalid calendar date", "2026-02-31T00:00:00Z"],
    ["an impossible month", "2026-13-01T00:00:00Z"],
    ["an impossible hour", "2026-05-04T24:00:00Z"],
    ["an empty string", ""],
    ["an oversized string", `2026-05-04T12:00:00Z${filler("0", 10)}`],
  ];

  for (const [label, value] of hostileIso) {
    it(`refuses non-string, unparseable, missing-zone, or invalid calendar recordedAtIso: ${label}`, () => {
      const decision = decideOutsideTenantAdmission(OTHER_ORG, { ...openGate, recordedAtIso: value });
      expect(decision).toEqual({ admitted: false, reason: "invalid-recorded-at" });
    });
  }

  it("accepts a calendar-valid zoned ISO timestamp with a fractional second and offset", () => {
    const decision = decideOutsideTenantAdmission(OTHER_ORG, {
      ...openGate,
      recordedAtIso: "2026-05-04T12:00:00.123456789+02:00",
    });
    expect(decision).toEqual({ admitted: true });
  });
});

describe("decideOutsideTenantAdmission paired admit and refuse cases", () => {
  it("admits valid non-default organisation with open gate", () => {
    expect(decideOutsideTenantAdmission(OTHER_ORG, openGate)).toEqual({ admitted: true });
  });

  it("refuses valid non-default organisation with closed gate", () => {
    expect(decideOutsideTenantAdmission(OTHER_ORG, { ...openGate, state: "closed" })).toEqual({
      admitted: false,
      reason: "gate-closed",
    });
  });

  it("admits DEFAULT_ORGANIZATION_ID even when gate is closed", () => {
    expect(
      decideOutsideTenantAdmission(DEFAULT_ORGANIZATION_ID, { ...openGate, state: "closed" }),
    ).toEqual({ admitted: true });
  });

  it("admits DEFAULT_ORGANIZATION_ID without inspecting a hostile gate at all", () => {
    expect(decideOutsideTenantAdmission(DEFAULT_ORGANIZATION_ID, null)).toEqual({ admitted: true });
  });

  it("refuses the same organisation when the open gate carries a malformed recordedAtIso", () => {
    expect(decideOutsideTenantAdmission(OTHER_ORG, { ...openGate, recordedAtIso: "not-a-date" })).toEqual({
      admitted: false,
      reason: "invalid-recorded-at",
    });
  });
});
