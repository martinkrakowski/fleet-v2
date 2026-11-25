// Unit tests for the pure deprecation-header policy. Nothing here is wired
// into middleware, and the fixtures carry no host, address, or token material.
import { describe, expect, it } from "vitest";
import {
  API_DEPRECATIONS,
  deprecationHeadersFor,
  validateDeprecationTable,
  type DeprecationEntry,
} from "../deprecation-policy.js";

const DEPRECATED_AT_MS = 1500;
const LATER_AT_MS = 2500;
const SUNSET_AT_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const SUCCESSOR = "/v1/next";
const LINK_HEADER = '</v1/next>; rel="successor-version"';

function validEntry(overrides: Partial<DeprecationEntry> = {}): DeprecationEntry {
  return {
    method: "GET",
    path: "/v1/old",
    deprecatedAtMs: DEPRECATED_AT_MS,
    ...overrides,
  };
}

function rawEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    method: "GET",
    path: "/v1/old",
    deprecatedAtMs: DEPRECATED_AT_MS,
    ...overrides,
  };
}

function expectRefused(table: unknown): void {
  const result = validateDeprecationTable(table);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  }
}

function pathWithSegmentCount(segmentCount: number): string {
  return "/a".repeat(segmentCount - 1);
}

describe("API_DEPRECATIONS", () => {
  it("API_DEPRECATIONS is an empty frozen array", () => {
    // Cost bound: O(1) length and frozen checks, no scan of a table.
    expect(Array.isArray(API_DEPRECATIONS)).toBe(true);
    expect(API_DEPRECATIONS).toHaveLength(0);
    expect(Object.isFrozen(API_DEPRECATIONS)).toBe(true);
    expect(() => {
      (API_DEPRECATIONS as DeprecationEntry[]).push(validEntry());
    }).toThrow();
    expect(API_DEPRECATIONS).toHaveLength(0);
    expect(validateDeprecationTable(API_DEPRECATIONS).ok).toBe(true);
  });
});

describe("deprecationHeadersFor", () => {
  it("deprecationHeadersFor formats deprecation as @<floor(ms/1000)> before, at, and after nowMs, sunset only when set, link only when set, and returns {} when unmatched", () => {
    // Cost bound: one pass over one entry and a handful of path segments.
    // 1500 ms floors to 1; rounding or ceiling would produce 2.
    const bare = [validEntry()];
    const atBefore = deprecationHeadersFor("GET", "/v1/old", bare, 0);
    const atEqual = deprecationHeadersFor("GET", "/v1/old", bare, DEPRECATED_AT_MS);
    const atAfter = deprecationHeadersFor("GET", "/v1/old", bare, 99_000);
    expect(atBefore).toEqual({ deprecation: "@1" });
    expect(atEqual).toEqual({ deprecation: "@1" });
    expect(atAfter).toEqual({ deprecation: "@1" });
    expect("sunset" in atBefore).toBe(false);
    expect("link" in atBefore).toBe(false);

    const sunsetOnly = [validEntry({ sunsetAtMs: SUNSET_AT_MS })];
    const sunsetHeaders = deprecationHeadersFor("GET", "/v1/old", sunsetOnly, 0);
    expect(sunsetHeaders).toEqual({
      deprecation: "@1",
      sunset: new Date(SUNSET_AT_MS).toUTCString(),
    });
    expect("link" in sunsetHeaders).toBe(false);

    const linkOnly = [validEntry({ successorPath: SUCCESSOR })];
    const linkHeaders = deprecationHeadersFor("GET", "/v1/old", linkOnly, 99_000);
    expect(linkHeaders).toEqual({
      deprecation: "@1",
      link: LINK_HEADER,
    });
    expect("sunset" in linkHeaders).toBe(false);

    const both = [validEntry({ sunsetAtMs: SUNSET_AT_MS, successorPath: SUCCESSOR })];
    expect(deprecationHeadersFor("GET", "/v1/old", both, DEPRECATED_AT_MS)).toEqual({
      deprecation: "@1",
      sunset: new Date(SUNSET_AT_MS).toUTCString(),
      link: LINK_HEADER,
    });

    const second = [
      validEntry({ path: "/v1/first" }),
      validEntry({ path: "/v1/second", deprecatedAtMs: LATER_AT_MS }),
    ];
    expect(deprecationHeadersFor("GET", "/v1/second", second, 0)).toEqual({ deprecation: "@2" });
    expect(deprecationHeadersFor("GET", "/v1/missing", bare, 0)).toEqual({});
    expect(deprecationHeadersFor("POST", "/v1/old", bare, 0)).toEqual({});
  });

  it("deprecationHeadersFor matches GET, POST, PUT, PATCH, and DELETE on one path and does not match their lowercase forms", () => {
    // Cost bound: five entries, one path comparison each.
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
    const table = methods.map((method) => validEntry({ method, path: "/v1/item" }));
    expect(validateDeprecationTable(table).ok).toBe(true);
    for (const method of methods) {
      expect(deprecationHeadersFor(method, "/v1/item", table, 0)).toEqual({ deprecation: "@1" });
      expect(deprecationHeadersFor(method.toLowerCase(), "/v1/item", table, 0)).toEqual({});
    }
  });

  it("deprecationHeadersFor matches trailing-slash, query-string, and repeated-slash request paths and compares other segments case-sensitively", () => {
    // Cost bound: normalizePath plus one slash collapse, then at most 64 segments.
    const table = [validEntry({ path: "/v1/attempts/:id" })];
    const expected = { deprecation: "@1" };
    expect(deprecationHeadersFor("GET", "/v1/attempts/abc/", table, 0)).toEqual(expected);
    expect(deprecationHeadersFor("GET", "/v1/attempts/abc?x=1", table, 0)).toEqual(expected);
    expect(deprecationHeadersFor("GET", "/v1/attempts/abc?x=//", table, 0)).toEqual(expected);
    expect(deprecationHeadersFor("GET", "/v1//attempts///abc", table, 0)).toEqual(expected);
    expect(deprecationHeadersFor("GET", "/v1//attempts/abc/?q=1", table, 0)).toEqual(expected);
    expect(deprecationHeadersFor("GET", "/v1/Attempts/abc/", table, 0)).toEqual({});
  });

  it("deprecationHeadersFor matches a :id segment to exactly one non-empty request segment and uses the first matching entry", () => {
    // Cost bound: segment compare is bounded by the 64-segment cap.
    const table = [validEntry({ path: "/v1/attempts/:id" })];
    expect(deprecationHeadersFor("GET", "/v1/attempts/abc", table, 0)).toEqual({
      deprecation: "@1",
    });
    expect(deprecationHeadersFor("GET", "/v1/attempts/xyz", table, 0)).toEqual({
      deprecation: "@1",
    });

    const root = [validEntry({ path: "/:id" })];
    expect(deprecationHeadersFor("GET", "/abc", root, 0)).toEqual({ deprecation: "@1" });
    expect(deprecationHeadersFor("GET", "/", root, 0)).toEqual({});

    const nested = [validEntry({ path: "/v1/:group/items" })];
    expect(deprecationHeadersFor("GET", "/v1/attempts/items", nested, 0)).toEqual({
      deprecation: "@1",
    });
    expect(deprecationHeadersFor("GET", "/v1//items", nested, 0)).toEqual({});

    const overlapping = [
      validEntry({ path: "/v1/attempts/:id", deprecatedAtMs: DEPRECATED_AT_MS }),
      validEntry({ path: "/v1/attempts/:attemptId", deprecatedAtMs: LATER_AT_MS }),
    ];
    expect(validateDeprecationTable(overlapping).ok).toBe(true);
    expect(deprecationHeadersFor("GET", "/v1/attempts/abc", overlapping, 0)).toEqual({
      deprecation: "@1",
    });
  });

  it("deprecationHeadersFor leaves the table deeply equal to its prior value", () => {
    // Cost bound: the compare walks the caller's table once; the policy does not write it.
    const entry = validEntry({ sunsetAtMs: SUNSET_AT_MS, successorPath: SUCCESSOR });
    const table = [entry, validEntry({ method: "POST", path: "/v1/other" })];
    const before = JSON.parse(JSON.stringify(table)) as unknown;
    const headers = deprecationHeadersFor("GET", "/v1/old", table, DEPRECATED_AT_MS);
    expect(headers).toEqual({
      deprecation: "@1",
      sunset: new Date(SUNSET_AT_MS).toUTCString(),
      link: LINK_HEADER,
    });
    expect(table).toEqual(before);
    expect(table[0]).toBe(entry);
    expect(Object.keys(table[0]).sort()).toEqual(
      ["deprecatedAtMs", "method", "path", "successorPath", "sunsetAtMs"].sort(),
    );
  });

  it("deprecationHeadersFor refuses lowercase and non-string methods", () => {
    // Cost bound: O(1) type and exact-string checks before any path walk.
    const table = [validEntry()];
    expect(deprecationHeadersFor("get", "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor("Get", "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor("GET ", "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor(1 as never, "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor(null as never, "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor(undefined as never, "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor(false as never, "/v1/old", table, 0)).toEqual({});
    expect(deprecationHeadersFor(new String("GET") as never, "/v1/old", table, 0)).toEqual({});
    expect(() => deprecationHeadersFor(1 as never, "/v1/old", table, 0)).not.toThrow();
  });

  it("deprecationHeadersFor returns {} for invalid table inputs without throwing", () => {
    // Cost bound: non-arrays are refused in O(1), before length is read or entries are walked.
    let lengthReads = 0;
    const enormous = {};
    Object.defineProperty(enormous, "length", {
      get() {
        lengthReads += 1;
        throw new Error("length getter invoked");
      },
      enumerable: false,
      configurable: true,
    });
    const arrayLike = { 0: validEntry(), length: 1 };
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      "[]",
      true,
      false,
      { length: 1_000_000_000 },
      arrayLike,
      enormous,
      Object.create(null),
    ];
    for (const table of inputs) {
      expect(() => deprecationHeadersFor("GET", "/v1/old", table as never, 0)).not.toThrow();
      expect(deprecationHeadersFor("GET", "/v1/old", table as never, 0)).toEqual({});
    }
    expect(lengthReads).toBe(0);
  });

  it("deprecationHeadersFor returns {} for non-string paths, over-long segment paths, and extra segments", () => {
    // Cost bound: non-strings return before normalize; segment count stops past 64.
    const table = [validEntry({ path: "/v1/attempts/:id" })];
    const tooManySegments = pathWithSegmentCount(65);
    expect(tooManySegments.split("/").length).toBe(65);
    expect(deprecationHeadersFor("GET", 1 as never, table, 0)).toEqual({});
    expect(deprecationHeadersFor("GET", null as never, table, 0)).toEqual({});
    expect(deprecationHeadersFor("GET", undefined as never, table, 0)).toEqual({});
    expect(deprecationHeadersFor("GET", { length: 4 } as never, table, 0)).toEqual({});
    expect(deprecationHeadersFor("GET", tooManySegments, table, 0)).toEqual({});
    expect(deprecationHeadersFor("GET", "/v1/attempts/a/b", table, 0)).toEqual({});
    expect(() => deprecationHeadersFor("GET", 1 as never, table, 0)).not.toThrow();
  });
});

describe("validateDeprecationTable", () => {
  it("validateDeprecationTable refuses null, undefined, primitives, plain objects, non-iterables, and enormous array-likes", () => {
    // Cost bound: O(1). Array.isArray is false, so length is never read and nothing is iterated.
    let lengthReads = 0;
    const enormous = {};
    Object.defineProperty(enormous, "length", {
      get() {
        lengthReads += 1;
        throw new Error("length getter invoked");
      },
      enumerable: false,
      configurable: true,
    });
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      1,
      "[]",
      true,
      false,
      1n,
      Symbol(),
      function notIterable() {
        return undefined;
      },
      { method: "GET", path: "/v1/old", deprecatedAtMs: DEPRECATED_AT_MS },
      Object.create(null),
      { 0: validEntry(), length: 1 },
      { length: 1_000_000_000 },
      enormous,
    ];
    for (const table of inputs) {
      expectRefused(table);
    }
    expect(lengthReads).toBe(0);
  });

  it("validateDeprecationTable refuses tables with more than 256 entries", () => {
    // Cost bound: O(1) length check. 257 entries are not walked.
    const tooMany = Array.from({ length: 257 }, (_unused, index) =>
      validEntry({ path: `/v1/e${index}` }),
    );
    expect(tooMany).toHaveLength(257);
    expectRefused(tooMany);
  });

  it("validateDeprecationTable accepts exactly 256 entries", () => {
    // Cost bound: one pass over 256 entries, each path three segments long.
    const table = Array.from({ length: 256 }, (_unused, index) =>
      validEntry({ path: `/v1/e${index}` }),
    );
    expect(validateDeprecationTable(table).ok).toBe(true);
  });

  it("validateDeprecationTable refuses sparse arrays with holes", () => {
    // Cost bound: O(1) own-property check per index, at most 256 indexes.
    const sparse: unknown[] = [];
    sparse[1] = validEntry();
    expect(Object.prototype.hasOwnProperty.call(sparse, 0)).toBe(false);
    expectRefused(sparse);

    const punched: unknown[] = [validEntry(), validEntry({ path: "/v1/other" })];
    delete punched[0];
    expect(Object.prototype.hasOwnProperty.call(punched, 0)).toBe(false);
    expectRefused(punched);
  });

  it("validateDeprecationTable and deprecationHeadersFor refuse accessor properties without invoking getters", () => {
    // Cost bound: descriptors are inspected and never called. At most 256 indexes and 5 own keys.
    let indexReads = 0;
    const indexTable: unknown[] = [];
    Object.defineProperty(indexTable, "0", {
      get() {
        indexReads += 1;
        return validEntry();
      },
      enumerable: true,
      configurable: true,
    });
    expectRefused(indexTable);
    expect(indexReads).toBe(0);
    expect(deprecationHeadersFor("GET", "/v1/old", indexTable as never, 0)).toEqual({});
    expect(indexReads).toBe(0);

    let methodReads = 0;
    const methodEntry = {
      path: "/v1/old",
      deprecatedAtMs: DEPRECATED_AT_MS,
    };
    Object.defineProperty(methodEntry, "method", {
      get() {
        methodReads += 1;
        return "GET";
      },
      enumerable: true,
      configurable: true,
    });
    expectRefused([methodEntry]);
    expect(methodReads).toBe(0);
    expect(deprecationHeadersFor("GET", "/v1/old", [methodEntry] as never, 0)).toEqual({});
    expect(methodReads).toBe(0);

    let sunsetSets = 0;
    const sunsetEntry = {
      method: "GET" as const,
      path: "/v1/old",
      deprecatedAtMs: DEPRECATED_AT_MS,
    };
    Object.defineProperty(sunsetEntry, "sunsetAtMs", {
      set() {
        sunsetSets += 1;
      },
      enumerable: true,
      configurable: true,
    });
    expectRefused([sunsetEntry]);
    expect(sunsetSets).toBe(0);

    let inheritedReads = 0;
    Object.defineProperty(Object.prototype, "method", {
      configurable: true,
      get() {
        inheritedReads += 1;
        return "GET";
      },
    });
    try {
      const plain = { path: "/v1/old", deprecatedAtMs: DEPRECATED_AT_MS };
      expectRefused([plain]);
      expect(inheritedReads).toBe(0);
      expect(deprecationHeadersFor("GET", "/v1/old", [plain] as never, 0)).toEqual({});
      expect(inheritedReads).toBe(0);
    } finally {
      delete (Object.prototype as { method?: unknown }).method;
    }
  });

  it("validateDeprecationTable pins accepted residual for a consistently lying Proxy", () => {
    // Cost bound: the same 256-entry pass. A proxy is not unwrapped; inconsistent shapes are refused.
    const presented = validEntry({ path: "/v1/shown" });
    const hidden = { method: "nope", path: "relative", deprecatedAtMs: -1 };
    const target = [hidden];
    const lying = new Proxy(target, {
      get(targetObject, prop, receiver) {
        if (prop === "0") {
          return presented;
        }
        return Reflect.get(targetObject, prop, receiver);
      },
      getOwnPropertyDescriptor(targetObject, prop) {
        if (prop === "0") {
          return {
            value: presented,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(targetObject, prop);
      },
    });
    const accepted = validateDeprecationTable(lying);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.table).toHaveLength(1);
      expect(accepted.table[0]?.path).toBe("/v1/shown");
    }
    expect(target[0]).toBe(hidden);
    expect(lying[0]).toBe(presented);

    expectRefused(new Proxy({ length: 1, 0: presented }, {}));
    expectRefused(new Proxy([null], {}));
    expectRefused(
      new Proxy([{ method: "get", path: "/v1/old", deprecatedAtMs: DEPRECATED_AT_MS }], {}),
    );
  });

  it("validateDeprecationTable refuses non-plain entries", () => {
    // Cost bound: O(1) typeof, null, array, and prototype checks per entry. No key walk on failure.
    class RouteRow {
      method: DeprecationEntry["method"] = "GET";
      path = "/v1/old";
      deprecatedAtMs = DEPRECATED_AT_MS;
    }
    const dated = new Date();
    Object.assign(dated, {
      method: "GET",
      path: "/v1/old",
      deprecatedAtMs: DEPRECATED_AT_MS,
    });
    expectRefused([null]);
    expectRefused([undefined]);
    expectRefused([1]);
    expectRefused(["GET"]);
    expectRefused([false]);
    expectRefused([[validEntry()]]);
    expectRefused([dated]);
    expectRefused([new RouteRow()]);
  });

  it("validateDeprecationTable refuses prototype-polluting own keys without polluting Object.prototype", () => {
    // Cost bound: own keys only, at most the five field names. Descriptors are not invoked.
    const originalConstructor = Object.prototype.constructor;
    const parsed: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"method":"GET","path":"/v1/old","deprecatedAtMs":1500}',
    );
    expectRefused([parsed]);

    const computed = {
      ["__proto__"]: { polluted: true },
      method: "GET",
      path: "/v1/old",
      deprecatedAtMs: DEPRECATED_AT_MS,
    };
    expectRefused([computed]);

    for (const key of ["__proto__", "constructor", "prototype"]) {
      const entry = Object.create(null) as Record<string, unknown>;
      entry.method = "GET";
      entry.path = "/v1/old";
      entry.deprecatedAtMs = DEPRECATED_AT_MS;
      Object.defineProperty(entry, key, {
        value: { polluted: true },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expectRefused([entry]);
    }

    expect(Object.prototype.constructor).toBe(originalConstructor);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    const fresh: { polluted?: boolean } = {};
    expect(fresh.polluted).toBeUndefined();
  });

  it("validateDeprecationTable refuses unsupported or lowercase methods", () => {
    // Cost bound: O(1) exact string membership. No case folding.
    for (const method of ["get", "Get", "HEAD", "OPTIONS", "DELETE ", "", "TRACE", "post"]) {
      expectRefused([rawEntry({ method })]);
    }
    expectRefused([rawEntry({ method: 1 })]);
    expectRefused([rawEntry({ method: null })]);
    expectRefused([rawEntry({ method: undefined })]);
  });

  it("validateDeprecationTable refuses invalid route paths", () => {
    // Cost bound: length is O(1); an accepted path is then scanned once, at most 256 chars and 64 segments.
    const tooLong = "/" + "b".repeat(256);
    const tooManySegments = pathWithSegmentCount(65);
    expect(tooLong).toHaveLength(257);
    expect(tooManySegments.split("/").length).toBe(65);
    expect(tooManySegments.length).toBeLessThanOrEqual(256);
    const badPaths: unknown[] = [
      undefined,
      null,
      1,
      "",
      "v1/old",
      "relative",
      tooLong,
      tooManySegments,
      "/v1/../secret",
      "/v1/foo..bar",
      "/v1/a" + String.fromCharCode(0) + "b",
      "/v1/a" + String.fromCharCode(0x1f),
      "/v1/a" + String.fromCharCode(0x7f),
      "/v1/a?b=1",
      "/v1/a#b",
      "/v1/a" + String.fromCharCode(0x5c) + "b",
    ];
    for (const path of badPaths) {
      expectRefused([rawEntry({ path })]);
    }
  });

  it("validateDeprecationTable accepts a 256-character path, a 64-segment path, and a 256-character successorPath", () => {
    // Cost bound: one pass over a single entry whose path is at the segment cap.
    const path256 = "/" + "b".repeat(255);
    const path64 = pathWithSegmentCount(64);
    const successor256 = "/v1/" + "c".repeat(252);
    expect(path256).toHaveLength(256);
    expect(path64.split("/").length).toBe(64);
    expect(successor256).toHaveLength(256);
    expect(validateDeprecationTable([validEntry({ path: path256 })]).ok).toBe(true);
    expect(validateDeprecationTable([validEntry({ path: path64 })]).ok).toBe(true);
    expect(validateDeprecationTable([validEntry({ successorPath: successor256 })]).ok).toBe(true);
    expect(deprecationHeadersFor("GET", path64, [validEntry({ path: path64 })], 0)).toEqual({
      deprecation: "@1",
    });
  });

  it("validateDeprecationTable refuses invalid timestamps and non-increasing sunsetAtMs", () => {
    // Cost bound: O(1) numeric checks per entry. No clock is read.
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const badDeprecated: unknown[] = [
      undefined,
      null,
      "1500",
      true,
      1.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      unsafe,
    ];
    for (const deprecatedAtMs of badDeprecated) {
      expectRefused([rawEntry({ deprecatedAtMs })]);
    }
    expectRefused([rawEntry({ sunsetAtMs: DEPRECATED_AT_MS })]);
    expectRefused([rawEntry({ deprecatedAtMs: 1_000, sunsetAtMs: 1_000 })]);
    expectRefused([rawEntry({ deprecatedAtMs: 1_000, sunsetAtMs: 999 })]);
    expectRefused([rawEntry({ deprecatedAtMs: 0, sunsetAtMs: 0 })]);
    expectRefused([rawEntry({ sunsetAtMs: 1.5 })]);
    expectRefused([rawEntry({ sunsetAtMs: -1 })]);
    expectRefused([rawEntry({ sunsetAtMs: Number.NaN })]);
    expectRefused([rawEntry({ sunsetAtMs: Number.POSITIVE_INFINITY })]);
    expectRefused([rawEntry({ sunsetAtMs: unsafe })]);
    expectRefused([rawEntry({ sunsetAtMs: "5000" })]);
  });

  it("validateDeprecationTable accepts deprecatedAtMs 0, a strictly later sunsetAtMs, and a null-prototype entry", () => {
    // Cost bound: one entry, a constant number of own keys.
    const entry = Object.create(null) as Record<string, unknown>;
    entry.method = "PATCH";
    entry.path = "/v1/from-null";
    entry.deprecatedAtMs = 0;
    entry.sunsetAtMs = 1;
    entry.successorPath = SUCCESSOR;
    const result = validateDeprecationTable([entry]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(deprecationHeadersFor("PATCH", "/v1/from-null", result.table, 0)).toEqual({
        deprecation: "@0",
        sunset: new Date(1).toUTCString(),
        link: LINK_HEADER,
      });
    }
    expect(validateDeprecationTable([validEntry({ sunsetAtMs: DEPRECATED_AT_MS + 1 })]).ok).toBe(
      true,
    );
  });

  it("validateDeprecationTable refuses invalid successorPath values", () => {
    // Cost bound: O(1) length check, then one scan of at most 256 characters.
    const tooLong = "/v1/" + "c".repeat(253);
    expect(tooLong).toHaveLength(257);
    const badSuccessors: unknown[] = [
      "/v2/next",
      "/v1",
      "v1/next",
      "",
      "/V1/next",
      tooLong,
      "/v1/a>b",
      "/v1/a b",
      "/v1/a" + String.fromCharCode(0x09) + "b",
      "/v1/a" + String.fromCharCode(0x0a) + "b",
      "/v1/a" + String.fromCharCode(0x7f),
      1,
      null,
    ];
    for (const successorPath of badSuccessors) {
      expectRefused([rawEntry({ successorPath })]);
    }
  });

  it("validateDeprecationTable refuses duplicate method and path entries", () => {
    // Cost bound: one set insertion per entry, at most 256.
    expectRefused([
      validEntry({ path: "/v1/same", successorPath: "/v1/a" }),
      validEntry({ path: "/v1/same", successorPath: "/v1/b", sunsetAtMs: SUNSET_AT_MS }),
    ]);
  });
});
