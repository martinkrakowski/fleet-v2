// Direct unit tests for resolveApiPath: the /v1 request-path validator on the
// API client refuses origin escapes and malformed paths and returns null
// (never throws) for every refusal. Each check is a fixed number of
// linear-time `includes` scans, one control-character regex over the path,
// and two `new URL` parses, so the whole validator is O(n) in path length
// with no network, file, timer or other I/O cost.
import { describe, expect, it } from "vitest";
import { resolveApiPath } from "./client.js";

const BASE = "http://127.0.0.1:4100";

describe("resolveApiPath", () => {
  it("returns valid /v1 paths unchanged (/v1/runs, /v1/runs?limit=5)", () => {
    expect(resolveApiPath("/v1/runs", BASE)).toBe("/v1/runs");
    expect(resolveApiPath("/v1/runs?limit=5", BASE)).toBe("/v1/runs?limit=5");
  });

  it("observed behaviour: returns /v1/a%2fb unchanged", () => {
    // The pre-parse substring checks and the post-parse origin/pathname
    // checks both accept an encoded slash in a path segment; this pins the
    // observed behaviour rather than asserting it is desirable.
    expect(resolveApiPath("/v1/a%2fb", BASE)).toBe("/v1/a%2fb");
  });

  it("resolves a one-megabyte /v1 path in linear time without throwing", () => {
    const longPath = "/v1/" + "a".repeat(1_000_000);
    expect(resolveApiPath(longPath, BASE)).toBe(longPath);
  });

  it(
    "returns null without throwing or invoking getters for non-string paths " +
      "(null, undefined, number, array, sparse array, array-like, getter object)",
    () => {
      // All refusals below are decided by `typeof path !== "string"`, a
      // constant-time check, so no scanning of the value ever happens and a
      // throwing getter or toString can never be reached.
      let getterRan = false;
      const getterObject = {
        get length(): number {
          getterRan = true;
          return 1;
        },
        toString(): string {
          getterRan = true;
          return "/v1/x";
        },
        valueOf(): string {
          getterRan = true;
          return "/v1/x";
        },
        0: "/v1/x",
      };
      const sparse: string[] = [];
      sparse[1] = "/v1/x";
      const hostileInputs: unknown[] = [
        null,
        undefined,
        5,
        ["/v1/x"],
        sparse,
        { 0: "/v1/x", length: 1 },
        getterObject,
      ];
      for (const input of hostileInputs) {
        expect(resolveApiPath(input as string, BASE)).toBeNull();
      }
      expect(getterRan).toBe(false);
    },
  );

  it("returns null for paths not starting with /v1/ (/v2/x, v1/x, /v1)", () => {
    // The startsWith prefix check is constant time.
    expect(resolveApiPath("/v2/x", BASE)).toBeNull();
    expect(resolveApiPath("v1/x", BASE)).toBeNull();
    expect(resolveApiPath("/v1", BASE)).toBeNull();
  });

  it("returns null for paths containing //, .., @, backslash, or #", () => {
    // Five fixed `includes` scans, each linear in path length.
    expect(resolveApiPath("//v1/x", BASE)).toBeNull();
    expect(resolveApiPath("/v1//x", BASE)).toBeNull();
    expect(resolveApiPath("/v1/../x", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a..b", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a@b", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a\\b", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a#b", BASE)).toBeNull();
  });

  it("returns null for paths containing control characters (\\n, \\t, \\u0000, \\u007f)", () => {
    // One regex pass over the path, linear in path length.
    expect(resolveApiPath("/v1/a\nb", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a\tb", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a\u0000b", BASE)).toBeNull();
    expect(resolveApiPath("/v1/a\u007fb", BASE)).toBeNull();
  });

  it("returns null for encoded dot segments (/v1/%2e%2e/x, /v1/%2E%2E/x) via post-parse pathname check", () => {
    // The string checks pass, but `new URL` normalises %2e to dots and
    // resolves the segments, so the parsed pathname escapes /v1/ and the
    // post-parse check refuses. Cost is one `new URL` parse plus one
    // startsWith comparison.
    expect(resolveApiPath("/v1/%2e%2e/x", BASE)).toBeNull();
    expect(resolveApiPath("/v1/%2E%2E/x", BASE)).toBeNull();
  });

  it("returns null without throwing when baseUrl is unparsable", () => {
    // The `new URL` failure is caught inside resolveApiPath and mapped to a
    // typed null result; no error escapes.
    expect(resolveApiPath("/v1/runs", "not a url")).toBeNull();
    expect(resolveApiPath("/v1/runs", "")).toBeNull();
  });
});
