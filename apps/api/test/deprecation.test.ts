import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPRECATIONS,
  deprecationHeadersFor,
  MAX_DEPRECATIONS,
  type DeprecationEntry,
} from "../server/deprecation.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTES_ROOT = join(TESTS_DIR, "..", "server", "routes", "v1");

interface RouteEntry {
  method: string;
  path: string;
}

const ROUTE_METHOD_RE = /^(.+)\.(get|post|patch)\.ts$/;
const UNKNOWN_METHOD_RE = /^.+\.([a-z]+)\.ts$/;
const KNOWN_METHODS = ["get", "post", "patch"];

// Copied locally from apps/api/test/route-scopes.test.ts (lines 10–54); not imported.
function walkRouteFiles(dir: string): { entries: RouteEntry[]; unknowns: string[] } {
  const entries: RouteEntry[] = [];
  const unknowns: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkRouteFiles(full);
      entries.push(...sub.entries);
      unknowns.push(...sub.unknowns);
      continue;
    }
    const match = ROUTE_METHOD_RE.exec(entry.name);
    if (!match) {
      const unknown = UNKNOWN_METHOD_RE.exec(entry.name);
      if (unknown && !KNOWN_METHODS.includes(unknown[1])) {
        unknowns.push(relative(ROUTES_ROOT, full));
      }
      continue;
    }
    const method = match[2].toUpperCase();
    const relPath = relative(ROUTES_ROOT, full);
    const segments = relPath.replace(/\.(get|post|patch)\.ts$/, "").split("/");
    const pathSegments = segments
      .filter((segment) => segment !== "index")
      .map((segment) =>
        segment.startsWith("[") && segment.endsWith("]")
          ? `:${segment.slice(1, -1)}`
          : segment,
      );
    entries.push({ method, path: `/v1/${pathSegments.join("/")}` });
  }
  return { entries, unknowns };
}

// Hostile characters built at runtime, never as literals in this file.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(0x85);
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const GT = String.fromCharCode(62);
const DQUOTE = String.fromCharCode(34);
const SEMI = String.fromCharCode(59);
const COMMA = String.fromCharCode(44);
const SPACE = String.fromCharCode(32);

const HTTP_METHOD = ["G", "E", "T"].join("");
const V1_PREFIX = ["", "v1", ""].join("/");

/** Build a route key (`METHOD /v1/...`) at runtime from parts. */
function routeKeyOf(path: string): string {
  return `${HTTP_METHOD} ${V1_PREFIX}${path}`;
}

const GOOD_NOW = ["2026-06-01", "T12", ":00", ":00", "Z"].join("");

/** A valid deprecation entry, assembled at runtime with every field explicit. */
function entry(overrides: Partial<DeprecationEntry> = {}): DeprecationEntry {
  return {
    routeKey: routeKeyOf("teams"),
    deprecatedAtIso: ["2026-01-01", "T00", ":00", ":00", "Z"].join(""),
    sunsetAtIso: null,
    successorPath: null,
    ...overrides,
  };
}

function entryOf(
  routeKey: string,
  deprecatedAtIso: string,
  sunsetAtIso: string | null,
  successorPath: string | null,
): DeprecationEntry {
  return { routeKey, deprecatedAtIso, sunsetAtIso, successorPath };
}

const ACTIVE_NOW = ["2026-06-01", "T00", ":00", ":00", "Z"].join("");
const FUTURE_DEPRECATION = ["2026-12-31", "T23", ":59", ":59", "Z"].join("");

describe("deprecationHeadersFor — successes", () => {
  it("returns empty headers for a routeKey absent from the registry", () => {
    const registry = [entry()];
    const result = deprecationHeadersFor(registry, routeKeyOf("absent"), GOOD_NOW);
    expect(result).toEqual({ ok: true, headers: {} });
  });

  it("returns empty headers when deprecatedAtIso is after nowIso", () => {
    const registry = [entry({ deprecatedAtIso: FUTURE_DEPRECATION })];
    const result = deprecationHeadersFor(registry, routeKeyOf("teams"), ACTIVE_NOW);
    expect(result).toEqual({ ok: true, headers: {} });
  });

  it("returns only the Deprecation header for an active deprecation with null sunset and successor", () => {
    const registry = [entry()];
    const result = deprecationHeadersFor(registry, routeKeyOf("teams"), ACTIVE_NOW);
    expect(result).toEqual({
      ok: true,
      headers: { Deprecation: "@1767225600" },
    });
  });

  it("returns Deprecation and Sunset headers when sunsetAtIso is set", () => {
    const registry = [
      entry({
        sunsetAtIso: ["2026-09-01", "T12", ":34", ":56", "Z"].join(""),
      }),
    ];
    const result = deprecationHeadersFor(registry, routeKeyOf("teams"), ACTIVE_NOW);
    expect(result).toEqual({
      ok: true,
      headers: {
        Deprecation: "@1767225600",
        Sunset: "Tue, 01 Sep 2026 12:34:56 GMT",
      },
    });
  });

  it("returns Deprecation and Link headers when successorPath is set", () => {
    const registry = [
      entry({ successorPath: `${V1_PREFIX}teams-v2` }),
    ];
    const result = deprecationHeadersFor(registry, routeKeyOf("teams"), ACTIVE_NOW);
    expect(result).toEqual({
      ok: true,
      headers: {
        Deprecation: "@1767225600",
        Link: `<${V1_PREFIX}teams-v2>; rel="successor-version"`,
      },
    });
  });

  it("returns all three headers when sunset and successor are both set", () => {
    const registry = [
      entry({
        sunsetAtIso: ["2026-09-01", "T00", ":00", ":00", "Z"].join(""),
        successorPath: `${V1_PREFIX}teams-v2`,
      }),
    ];
    const result = deprecationHeadersFor(registry, routeKeyOf("teams"), ACTIVE_NOW);
    expect(result).toEqual({
      ok: true,
      headers: {
        Deprecation: "@1767225600",
        Sunset: "Tue, 01 Sep 2026 00:00:00 GMT",
        Link: `<${V1_PREFIX}teams-v2>; rel="successor-version"`,
      },
    });
  });

  it("accepts deprecatedAtIso both with and without explicit .000 milliseconds", () => {
    const withMs = [
      entry({ deprecatedAtIso: ["2026-01-01", "T00", ":00", ":00", ".000", "Z"].join("") }),
    ];
    const withoutMs = [entry()];
    const key = routeKeyOf("teams");
    expect(deprecationHeadersFor(withMs, key, ACTIVE_NOW)).toEqual({
      ok: true,
      headers: { Deprecation: "@1767225600" },
    });
    expect(deprecationHeadersFor(withoutMs, key, ACTIVE_NOW)).toEqual({
      ok: true,
      headers: { Deprecation: "@1767225600" },
    });
  });
});

describe("deprecationHeadersFor — the empty default registry", () => {
  it("walks every route file under routes/v1 and finds mapped method entries", () => {
    const { entries, unknowns } = walkRouteFiles(ROUTES_ROOT);
    expect(entries.length, "route walk found no entries").toBeGreaterThan(0);
    expect(unknowns, `route files without a mapped method: ${unknowns.join(", ")}`).toEqual([]);
  });

  it("emits no deprecation headers for any existing /v1 route under DEFAULT_DEPRECATIONS", () => {
    const { entries, unknowns } = walkRouteFiles(ROUTES_ROOT);
    expect(entries.length).toBeGreaterThan(0);
    expect(unknowns).toEqual([]);
    for (const route of entries) {
      const key = `${route.method} ${route.path}`;
      const result = deprecationHeadersFor(DEFAULT_DEPRECATIONS, key, GOOD_NOW);
      expect(result, key).toEqual({ ok: true, headers: {} });
    }
  });
});

describe("deprecationHeadersFor — argument refusals", () => {
  it("refuses invalid, empty, or over-length routeKey arguments", () => {
    const tooLong = "a".repeat(257);
    for (const bad of [null, undefined, 42, true, [], {}, "", tooLong]) {
      const result = deprecationHeadersFor([], bad, GOOD_NOW);
      expect(result, String(typeof bad)).toEqual({
        ok: false,
        reason: "invalid-route-key",
      });
    }
  });

  it("refuses non-ISO, rolled-over, over-length, and unparseable timestamps", () => {
    const key = routeKeyOf("teams");
    const tooLong = `${["2026-01-01", "T00", ":00", ":00", "Z"].join("")}x`.slice(0, 65);
    for (const bad of [
      null,
      undefined,
      42,
      "",
      "2026",
      "March 7",
      "2026-02-30T00:00:00Z",
      "2026-01-01 00:00:00Z",
      "2026-01-01T00:00:00.00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T25:00:00Z",
      tooLong,
    ]) {
      const result = deprecationHeadersFor([], key, bad);
      expect(result, String(typeof bad)).toEqual({
        ok: false,
        reason: "invalid-timestamp",
      });
    }
  });
});

describe("deprecationHeadersFor — registry shape refusals", () => {
  it("refuses non-array, null, undefined, primitive, and array-like registries", () => {
    const key = routeKeyOf("teams");
    const arrayLike = { length: 1, 0: entry() };
    for (const bad of [null, undefined, 42, "str", true, {}, arrayLike]) {
      const result = deprecationHeadersFor(bad, key, GOOD_NOW);
      expect(result, String(typeof bad)).toEqual({
        ok: false,
        reason: "invalid-registry",
      });
    }
  });

  it("refuses sparse registry arrays", () => {
    const holey: unknown[] = [entry()];
    delete holey[0];
    const result = deprecationHeadersFor(holey, routeKeyOf("teams"), GOOD_NOW);
    expect(result).toEqual({ ok: false, reason: "sparse-registry" });
  });

  it("refuses registries exceeding 500 entries", () => {
    expect(MAX_DEPRECATIONS).toBe(500);
    const tooMany: DeprecationEntry[] = [];
    for (let index = 0; index <= 500; index += 1) {
      tooMany.push(entry({ routeKey: routeKeyOf(`route-${index}`) }));
    }
    const result = deprecationHeadersFor(tooMany, routeKeyOf("route-0"), GOOD_NOW);
    expect(result).toEqual({ ok: false, reason: "registry-too-large" });
  });

  it("refuses an accessor or non-number length without reading beyond it", () => {
    const accessorLengthProxy = new Proxy([] as unknown[], {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "length") {
          return {
            get: () => 1,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const nonNumberLengthProxy = new Proxy([] as unknown[], {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "length") {
          return { value: "1", writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(deprecationHeadersFor(accessorLengthProxy, routeKeyOf("teams"), GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });
    expect(deprecationHeadersFor(nonNumberLengthProxy, routeKeyOf("teams"), GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });
  });
});

describe("deprecationHeadersFor — entry refusals", () => {
  it("refuses non-plain entries, unknown keys, and missing or wrong-type fields", () => {
    const key = routeKeyOf("teams");
    const classLike = new (class Field {
      routeKey = key;
      deprecatedAtIso = GOOD_NOW;
      sunsetAtIso = null;
      successorPath = null;
    })();
    const cases: unknown[] = [
      null,
      42,
      "str",
      [entry()],
      classLike,
      { routeKey: key, deprecatedAtIso: GOOD_NOW, sunsetAtIso: null },
      {
        routeKey: key,
        deprecatedAtIso: GOOD_NOW,
        sunsetAtIso: null,
        successorPath: null,
        extra: 1,
      },
      { routeKey: 42, deprecatedAtIso: GOOD_NOW, sunsetAtIso: null, successorPath: null },
      { routeKey: "", deprecatedAtIso: GOOD_NOW, sunsetAtIso: null, successorPath: null },
    ];
    for (const bad of cases) {
      const label =
        bad === null || typeof bad !== "object"
          ? typeof bad
          : JSON.stringify(Object.keys(bad));
      const result = deprecationHeadersFor([bad], key, GOOD_NOW);
      expect(result, label).toEqual({
        ok: false,
        reason: "invalid-entry",
      });
    }
  });

  it("refuses entries carrying prototype-polluting own keys", () => {
    const key = routeKeyOf("teams");
    for (const polluter of ["__proto__", "constructor", "prototype"]) {
      const bad: Record<string, unknown> = {
        routeKey: key,
        deprecatedAtIso: GOOD_NOW,
        sunsetAtIso: null,
        successorPath: null,
      };
      Object.defineProperty(bad, polluter, {
        value: 1,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      const result = deprecationHeadersFor([bad], key, GOOD_NOW);
      expect(result, polluter).toEqual({ ok: false, reason: "polluting-key" });
    }
  });

  it("refuses duplicate routeKey entries", () => {
    const duplicate = entry();
    const result = deprecationHeadersFor(
      [duplicate, { ...duplicate }],
      routeKeyOf("teams"),
      GOOD_NOW,
    );
    expect(result).toEqual({ ok: false, reason: "duplicate-route-key" });
  });

  it("refuses getters on registry elements or entry properties without invoking them", () => {
    const key = routeKeyOf("teams");
    let getterRan = false;
    const flag = (): boolean => {
      getterRan = true;
      return false;
    };

    // Getter on a registry element: a Proxy whose descriptor trap reports an
    // accessor instead of a data property for element 0.
    const accessorElementProxy = new Proxy([entry()], {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "0") {
          return {
            get: () => {
              flag();
              return entry();
            },
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(deprecationHeadersFor(accessorElementProxy, key, GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });

    // Getter on an entry field.
    const getterField: Record<string, unknown> = {
      routeKey: key,
      deprecatedAtIso: GOOD_NOW,
      sunsetAtIso: null,
      successorPath: null,
    };
    Object.defineProperty(getterField, "sunsetAtIso", {
      get: () => {
        flag();
        return null;
      },
      enumerable: true,
      configurable: true,
    });
    expect(deprecationHeadersFor([getterField], key, GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });

    // Non-data (getter-only) element descriptor on a real array.
    const accessorArray: unknown[] = [entry()];
    Object.defineProperty(accessorArray, 0, {
      get: () => {
        flag();
        return entry();
      },
      enumerable: true,
      configurable: true,
    });
    expect(deprecationHeadersFor(accessorArray, key, GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });

    expect(getterRan).toBe(false);
  });

  it("refuses throwing Proxy inputs without throwing", () => {
    const key = routeKeyOf("teams");
    const throwingTarget = Object.freeze([entry()]);
    const throwingProxy = new Proxy(throwingTarget, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor");
      },
    });
    expect(() => deprecationHeadersFor(throwingProxy, key, GOOD_NOW)).not.toThrow();
    expect(deprecationHeadersFor(throwingProxy, key, GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });

    const entryProxy = new Proxy(
      { ...entry() },
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor");
        },
      },
    );
    expect(() => deprecationHeadersFor([entryProxy], key, GOOD_NOW)).not.toThrow();
    expect(deprecationHeadersFor([entryProxy], key, GOOD_NOW)).toEqual({
      ok: false,
      reason: "hostile-input",
    });
  });
});

describe("deprecationHeadersFor — field value refusals", () => {
  it("refuses CR, LF, and control characters in any string without echoing values", () => {
    const key = routeKeyOf("teams");
    const controlChar = (value: string): string => value;

    const registryControl = [
      entry({ routeKey: controlChar(`${HTTP_METHOD} ${LF}${V1_PREFIX}teams`) }),
    ];
    expect(deprecationHeadersFor(registryControl, routeKeyOf("teams"), GOOD_NOW)).toEqual({
      ok: false,
      reason: "control-character",
    });

    for (const hostile of [CR, LF, TAB, NUL, DEL, C1, LINE_SEP, PARA_SEP]) {
      expect(
        deprecationHeadersFor([], controlChar(`${HTTP_METHOD} ${hostile}`), GOOD_NOW),
        "routeKey argument",
      ).toEqual({ ok: false, reason: "control-character" });
      expect(
        deprecationHeadersFor([], routeKeyOf("teams"), controlChar(`${GOOD_NOW.slice(0, -1)}${hostile}`)),
        "nowIso argument",
      ).toEqual({ ok: false, reason: "control-character" });
    }

    const deprecatedControl = [
      entry({ deprecatedAtIso: controlChar(`2026-01-01${LF}T00:00:00Z`) }),
    ];
    expect(deprecationHeadersFor(deprecatedControl, routeKeyOf("teams"), GOOD_NOW)).toEqual({
      ok: false,
      reason: "control-character",
    });

    const sunsetControl = [
      entry({ sunsetAtIso: controlChar(`2026-09-01${CR}T00:00:00Z`) }),
    ];
    expect(deprecationHeadersFor(sunsetControl, routeKeyOf("teams"), GOOD_NOW)).toEqual({
      ok: false,
      reason: "control-character",
    });

    const successorControl = [
      entry({ successorPath: controlChar(`${V1_PREFIX}te${CR}ams`) }),
    ];
    expect(deprecationHeadersFor(successorControl, routeKeyOf("teams"), GOOD_NOW)).toEqual({
      ok: false,
      reason: "control-character",
    });
  });

  it("refuses non-ISO, rolled-over, over-length, and unparseable timestamps", () => {
    const key = routeKeyOf("teams");
    const badStamps = [
      "2026",
      "March 7",
      "2026-02-30T00:00:00Z",
      "2026-01-01 00:00:00Z",
      "2026-01-01T00:00:00.00Z",
      "x".repeat(65),
    ];
    for (const bad of badStamps) {
      expect(
        deprecationHeadersFor([entry({ deprecatedAtIso: bad })], key, GOOD_NOW),
        "deprecatedAtIso",
      ).toEqual({ ok: false, reason: "invalid-timestamp" });
      expect(
        deprecationHeadersFor([entry({ sunsetAtIso: bad })], key, GOOD_NOW),
        "sunsetAtIso",
      ).toEqual({ ok: false, reason: "invalid-timestamp" });
    }
    for (const wrongType of [42, true, {}, [], undefined]) {
      expect(
        deprecationHeadersFor([entry({ sunsetAtIso: wrongType as string })], key, GOOD_NOW),
        "sunsetAtIso wrong type",
      ).toEqual({ ok: false, reason: "invalid-entry" });
    }
  });

  it("refuses sunsetAtIso earlier than deprecatedAtIso", () => {
    const registry = [
      entry({
        sunsetAtIso: ["2025-12-31", "T23", ":59", ":59", "Z"].join(""),
      }),
    ];
    const result = deprecationHeadersFor(registry, routeKeyOf("teams"), GOOD_NOW);
    expect(result).toEqual({ ok: false, reason: "sunset-before-deprecation" });
  });

  it("refuses successorPath outside /v1/, over 512 chars, with parent traversal, or with delimiter characters", () => {
    const key = routeKeyOf("teams");
    const over512 = `${V1_PREFIX}${"a".repeat(512)}`;
    const delimiters = [GT, DQUOTE, SEMI, COMMA, SPACE];
    const cases: Array<[string, string]> = [
      ["outside /v1/", `${["", "v2", ""].join("/")}teams`],
      ["traversal", `${V1_PREFIX}..${["", "teams"].join("")}`],
      ["over 512 chars", over512],
    ];
    for (const [name, bad] of cases) {
      const result = deprecationHeadersFor([entry({ successorPath: bad })], key, GOOD_NOW);
      expect(result, name).toEqual({ ok: false, reason: "invalid-successor-path" });
    }
    for (const delimiter of delimiters) {
      const result = deprecationHeadersFor(
        [entry({ successorPath: `${V1_PREFIX}a${delimiter}b` })],
        key,
        GOOD_NOW,
      );
      expect(result, delimiter === SPACE ? "space" : "delimiter").toEqual({
        ok: false,
        reason: "invalid-successor-path",
      });
    }
    expect(
      deprecationHeadersFor([entry({ successorPath: 42 as unknown as string })], key, GOOD_NOW),
    ).toEqual({ ok: false, reason: "invalid-entry" });
  });
});
