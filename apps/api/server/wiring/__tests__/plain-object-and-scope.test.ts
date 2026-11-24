// Unit tests for isPlainObject (wiring/http-input.ts) and holdsScope +
// SHARED_BEARER_TOKEN_ID (wiring/presented-token.ts). No production code is
// changed: these pin the existing guards' behaviour, including the accepted
// residuals noted below.
import { describe, expect, it } from "vitest";
import { isPlainObject } from "../http-input.js";
import {
  holdsScope,
  SHARED_BEARER_TOKEN_ID,
  type PresentedToken,
} from "../presented-token.js";

describe("isPlainObject", () => {
  it("returns true for plain objects: empty, populated, and null-prototype", () => {
    // Cost bound: O(1) — typeof check, one null comparison, one Array.isArray
    // call. No property access, no iteration, no prototype walk.
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("returns false for null, undefined, arrays, primitives, and functions", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(() => {})).toBe(false);
  });

  it("pins the residual: non-plain built-ins and class instances pass because the guard checks typeof only", () => {
    // Accepted residual: typeof on every one of these is "object", so they
    // pass. The guard is a shape refusal for arrays and null only.
    expect(isPlainObject(new Date())).toBe(true);
    expect(isPlainObject(new Map())).toBe(true);
    class Sample {
      a = 1;
    }
    expect(isPlainObject(new Sample())).toBe(true);
  });

  it("does not invoke getters on candidate objects and returns true without throwing", () => {
    // Cost bound: O(1) — the guard never reads a property, so a getter is
    // never triggered. This asserts that guarantee by throwing if it is broken.
    const candidate = {};
    Object.defineProperty(candidate, "x", {
      get() {
        throw new Error("getter called");
      },
      enumerable: true,
    });
    expect(() => isPlainObject(candidate)).not.toThrow();
    expect(isPlainObject(candidate)).toBe(true);
  });

  it("returns true without iterating or reading length on an array-like with an enormous length", () => {
    // Cost bound: O(1) — no .length access and no iteration happen.
    expect(isPlainObject({ length: 1_000_000_000 })).toBe(true);
  });

  it("returns true for __proto__-keyed objects without polluting Object.prototype", () => {
    // A literal key never reaches the prototype chain; JSON.parse never runs
    // setters. Assert both the result and that nothing was polluted.
    expect(isPlainObject({ ["__proto__"]: {} })).toBe(true);
    const parsed: Record<string, unknown> = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(isPlainObject(parsed)).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns true for a Proxy (accepted residual for a consistently lying Proxy)", () => {
    expect(isPlainObject(new Proxy({}, {}))).toBe(true);
  });
});

describe("holdsScope", () => {
  it("exposes SHARED_BEARER_TOKEN_ID as 'shared-bearer'", () => {
    expect(SHARED_BEARER_TOKEN_ID).toBe("shared-bearer");
  });

  it("returns true when token.scopes contains the scope", () => {
    // Cost bound: O(n) in token.scopes.length via Array.prototype.includes,
    // bounded by the caller's token scope list.
    const token: PresentedToken = { tokenId: "t1", scopes: ["orchestrate"] };
    expect(holdsScope(token, "orchestrate")).toBe(true);
  });

  it("returns false when scopes is empty or does not contain the scope", () => {
    const empty: PresentedToken = { tokenId: "t1", scopes: [] };
    expect(holdsScope(empty, "orchestrate")).toBe(false);
    const token: PresentedToken = { tokenId: "t1", scopes: ["dispatch"] };
    expect(holdsScope(token, "orchestrate")).toBe(false);
  });

  it("returns false for missing, different-case, and prefix scopes", () => {
    const token: PresentedToken = { tokenId: "t1", scopes: ["orchestrate"] };
    expect(holdsScope(token, "Orchestrate")).toBe(false);
    expect(holdsScope(token, "orch")).toBe(false);
  });

  it("returns false for an empty scope string against a non-empty list", () => {
    const token: PresentedToken = { tokenId: "t1", scopes: ["orchestrate"] };
    expect(holdsScope(token, "")).toBe(false);
  });

  it("holds each of two scopes and does not mutate a frozen scopes list", () => {
    const scopes = Object.freeze(["orchestrate", "dispatch"]);
    const token: PresentedToken = { tokenId: "t1", scopes };
    expect(holdsScope(token, "orchestrate")).toBe(true);
    expect(holdsScope(token, "dispatch")).toBe(true);
    expect([...token.scopes]).toEqual(["orchestrate", "dispatch"]);
    expect(Object.isFrozen(token.scopes)).toBe(true);
  });

  it("treats array holes as absent and present values as held (sparse array)", () => {
    // A hole reads as undefined in includes, and the present index is matched
    // normally: both with the same O(n) cost bound.
    const sparse: string[] = [];
    sparse[1] = "orchestrate";
    const token: PresentedToken = { tokenId: "t1", scopes: sparse };
    expect(holdsScope(token, "dispatch")).toBe(false);
    expect(holdsScope(token, "orchestrate")).toBe(true);
  });

  it("does not match prototype keys absent from scopes", () => {
    // includes uses strict equality, so inherited names never match.
    const token: PresentedToken = { tokenId: "t1", scopes: ["orchestrate"] };
    expect(holdsScope(token, "__proto__")).toBe(false);
    expect(holdsScope(token, "toString")).toBe(false);
    expect(holdsScope(token, "constructor")).toBe(false);
  });
});
