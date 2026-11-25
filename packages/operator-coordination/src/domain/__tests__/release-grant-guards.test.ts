import { describe, expect, it } from "vitest";
import {
  isReleaseActionScope,
  isReleaseRootCoordinate,
  isReleaseNonce,
  readReleaseRoot,
  readReleaseNonce,
} from "../coordination-records.js";

// Cost bounds:
// - isReleaseActionScope: O(1) membership check against the 3 allowed scopes.
// - isReleaseRootCoordinate: linear in input length, bounded at 4096 chars
//   (length check first in O(1), then one pass for leading '/', control/format
//   chars, and the '..' segment check).
// - readReleaseRoot: O(1) own-property descriptor lookup inside try/catch, plus
//   O(n <= 4096) coordinate validation.
// - isReleaseNonce: O(1) typeof check plus fixed-length 32-char anchored hex regex.
// - readReleaseNonce: O(1) own-property descriptor lookup inside try/catch, plus O(1) isReleaseNonce.
describe("isReleaseActionScope", () => {
  it("returns true for the three exact release action scopes", () => {
    expect(isReleaseActionScope("release:install")).toBe(true);
    expect(isReleaseActionScope("release:swap")).toBe(true);
    expect(isReleaseActionScope("release:rollback")).toBe(true);
  });

  it("returns false for unknown, cased, padded, empty, wildcard, and non-string scopes", () => {
    for (const scope of [
      "release:other",
      "Release:install",
      "release:install ",
      "",
      "release:*",
      null,
      undefined,
      5,
      ["release:install"] as never,
    ]) {
      expect(isReleaseActionScope(scope as never)).toBe(false);
    }
  });
});

describe("isReleaseRootCoordinate", () => {
  it("accepts absolute paths within the 4096-character bound, including a whole ..-containing segment name", () => {
    expect(isReleaseRootCoordinate("/srv/root")).toBe(true);
    expect(isReleaseRootCoordinate("/")).toBe(true);
    expect(isReleaseRootCoordinate("/" + "a".repeat(4095))).toBe(true);
    expect(isReleaseRootCoordinate("/a/..b")).toBe(true);
  });

  it("returns false for empty, relative, dot-dot segment, control/format chars, oversized, and non-string inputs", () => {
    for (const path of [
      "/" + "a".repeat(4096),
      "",
      "srv/root",
      "/a/../b",
      "/a/..",
      "/a\nb",
      "/a\u0000b",
      "/a\u202eb",
      null,
      undefined,
      5,
      ["/a"],
    ]) {
      expect(isReleaseRootCoordinate(path as never)).toBe(false);
    }
  });

  it("refuses a 5,000,000-character path at once via the length check", () => {
    // Cost bound: the O(1) length check rejects this before any linear scan runs.
    expect(isReleaseRootCoordinate("/" + "a".repeat(4_999_999))).toBe(false);
  });
});

describe("readReleaseRoot", () => {
  it("returns absent for missing, own undefined, inherited, array-like, array-hole, and prototype-polluting records", () => {
    expect(readReleaseRoot({})).toEqual({ state: "absent" });
    expect(readReleaseRoot({ releaseRoot: undefined })).toEqual({
      state: "absent",
    });
    expect(readReleaseRoot(Object.create({ releaseRoot: "/a" }))).toEqual({
      state: "absent",
    });
    expect(readReleaseRoot({ length: 1, 0: "/a" })).toEqual({
      state: "absent",
    });
    const arrayHole = new Array(1); // one array hole at index 0
    expect(readReleaseRoot(arrayHole)).toEqual({ state: "absent" });
    expect(
      readReleaseRoot(
        JSON.parse('{"__proto__":{"releaseRoot":"/a"}}') as object,
      ),
    ).toEqual({ state: "absent" });
  });

  it("returns the value for valid own releaseRoot coordinates", () => {
    expect(readReleaseRoot({ releaseRoot: "/srv/root" })).toEqual({
      state: "valid",
      value: "/srv/root",
    });
    expect(readReleaseRoot({ releaseRoot: "/" })).toEqual({
      state: "valid",
      value: "/",
    });
  });

  it("returns invalid for malformed own releaseRoot values and null or undefined records", () => {
    for (const record of [
      { releaseRoot: "" },
      { releaseRoot: "srv/root" },
      { releaseRoot: 5 },
      { releaseRoot: "/" + "a".repeat(4096) },
      null as never,
      undefined as never,
    ]) {
      const read = readReleaseRoot(record);
      expect(read).toEqual({ state: "invalid" });
      expect(read).not.toEqual({ state: "absent" });
    }
  });

  it("returns invalid for a numeric primitive record (VC14F: a non-object is never absent)", () => {
    // VC14F: readReleaseRoot refuses any non-object before any property lookup,
    // so a primitive is never boxed and never reads as absent.
    expect(readReleaseRoot(5 as unknown as object)).toEqual({
      state: "invalid",
    });
  });

  it("returns invalid and never invokes an own releaseRoot getter", () => {
    let calls = 0;
    const record = {};
    Object.defineProperty(record, "releaseRoot", {
      enumerable: true,
      get() {
        calls += 1;
        return "/srv/root";
      },
    });
    expect(readReleaseRoot(record)).toEqual({ state: "invalid" });
    expect(calls).toBe(0);
  });

  it("returns invalid without throwing when Proxy getOwnPropertyDescriptor throws", () => {
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );
    expect(readReleaseRoot(trapped)).toEqual({ state: "invalid" });
  });
});

describe("isReleaseNonce", () => {
  it("returns true for a runtime-built 32-character lowercase hex string", () => {
    expect(isReleaseNonce("0123456789abcdef".repeat(2))).toBe(true);
  });

  it("returns false for wrong length, uppercase, trailing newline, empty, and non-string nonces", () => {
    for (const nonce of [
      "a".repeat(31),
      "a".repeat(33),
      "A".repeat(32),
      "a".repeat(32) + "\n",
      "",
      null,
      undefined,
      5,
      ["a".repeat(32)],
    ]) {
      expect(isReleaseNonce(nonce as never)).toBe(false);
    }
  });
});

describe("readReleaseNonce", () => {
  it("returns the value for an own valid runtime-built nonce", () => {
    const nonce = "0123456789abcdef".repeat(2);
    expect(readReleaseNonce({ releaseNonce: nonce })).toBe(nonce);
  });

  it("returns undefined for missing, inherited, malformed, non-object, getter (never invoked), and throwing Proxy records", () => {
    let calls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "releaseNonce", {
      enumerable: true,
      get() {
        calls += 1;
        return "a".repeat(32);
      },
    });
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );
    for (const record of [
      {},
      Object.create({ releaseNonce: "a".repeat(32) }),
      { releaseNonce: undefined },
      { releaseNonce: "a".repeat(31) },
      { releaseNonce: "a".repeat(33) },
      { releaseNonce: "A".repeat(32) },
      { releaseNonce: "a".repeat(32) + "\n" },
      { releaseNonce: 5 },
      null as never,
      undefined as never,
      new Array(1), // one array hole at index 0
      { length: 1 },
      accessor,
      trapped,
    ]) {
      expect(readReleaseNonce(record)).toBeUndefined();
    }
    expect(calls).toBe(0);
  });
});
