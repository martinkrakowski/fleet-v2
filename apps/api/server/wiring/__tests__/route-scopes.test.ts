import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FROZEN_SCOPES,
  normalizePath,
  requiredScope,
} from "../route-scopes.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTES_ROOT = join(TESTS_DIR, "..", "..", "routes", "v1");

interface RouteEntry {
  method: string;
  path: string;
}

const ROUTE_METHOD_RE = /^(.+)\.(get|post|patch)\.ts$/;
const UNKNOWN_METHOD_RE = /^.+\.([a-z]+)\.ts$/;
const KNOWN_METHODS = ["get", "post", "patch"];

// O(route files) linear walk of the routes/v1 directory tree; no regex
// backtracking (both regexes here are anchored and linear).
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

/** The one GET route whose scope is not "read". */
const GET_READ_EXCEPTION = "/v1/threads/:id/permissions";
/** The one non-GET route whose scope is "read". */
const POST_READ_EXCEPTION = "/v1/briefs/preview";

describe("normalizePath", () => {
  it("strips the query string at the first question mark and keeps the path", () => {
    expect(normalizePath("/v1/questions?foo=bar")).toBe("/v1/questions");
    expect(normalizePath("/v1/questions?")).toBe("/v1/questions");
    expect(normalizePath("/v1/questions?a=1?b=2")).toBe("/v1/questions");
    expect(normalizePath("/v1/questions")).toBe("/v1/questions");
  });

  it("strips a single trailing slash when the path is longer than root and keeps the root slash", () => {
    expect(normalizePath("/v1/questions/")).toBe("/v1/questions");
    expect(normalizePath("/v1/")).toBe("/v1");
    expect(normalizePath("/")).toBe("/");
    // Only one trailing slash is stripped: a doubled slash stays malformed.
    expect(normalizePath("/v1/questions//")).toBe("/v1/questions/");
  });

  it("decodes valid percent-encoded segments", () => {
    expect(normalizePath("/v%31/questions")).toBe("/v1/questions");
    expect(normalizePath("/%76%31/attempts/att%201")).toBe("/v1/attempts/att 1");
  });

  it("preserves malformed percent-encoded segments without throwing", () => {
    // Truncated UTF-8 sequence: decodeURI throws URIError, the raw segment is kept.
    expect(normalizePath("/v1/questions/%E0%A4%A")).toBe("/v1/questions/%E0%A4%A");
    // Invalid hex digits: decodeURI throws URIError, the raw segment is kept.
    expect(normalizePath("/v1/questions/%ZZ")).toBe("/v1/questions/%ZZ");
  });
});

describe("requiredScope route-table invariants", () => {
  it("walks every route file under routes/v1 and maps it to a single frozen scope", () => {
    const { entries, unknowns } = walkRouteFiles(ROUTES_ROOT);
    expect(unknowns, `route files without a mapped method: ${unknowns.join(", ")}`).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    for (const route of entries) {
      const scope = requiredScope(route.method, route.path);
      expect(scope, `${route.method} ${route.path}`).not.toBeNull();
      if (scope !== null) {
        expect([...FROZEN_SCOPES] as string[], `${route.method} ${route.path}`).toContain(scope);
      }
    }
  });

  it("defaults every GET route in the table to read except the permissions list route", () => {
    const { entries } = walkRouteFiles(ROUTES_ROOT);
    const getRoutes = entries.filter((route) => route.method === "GET");
    expect(getRoutes.length).toBeGreaterThan(0);
    for (const route of getRoutes) {
      const scope = requiredScope("GET", route.path);
      expect(scope, `GET ${route.path}`).not.toBeNull();
      if (route.path === GET_READ_EXCEPTION) {
        expect(scope, `GET ${route.path}`).toBe("verdict");
      } else {
        expect(scope, `GET ${route.path}`).toBe("read");
      }
    }
  });

  it("never grants read on non-GET routes except the briefs preview dry run", () => {
    const { entries } = walkRouteFiles(ROUTES_ROOT);
    const mutationRoutes = entries.filter((route) => route.method !== "GET");
    expect(mutationRoutes.length).toBeGreaterThan(0);
    for (const route of mutationRoutes) {
      const scope = requiredScope(route.method, route.path);
      expect(scope, `${route.method} ${route.path}`).not.toBeNull();
      if (route.method === "POST" && route.path === POST_READ_EXCEPTION) {
        expect(scope, `POST ${route.path}`).toBe("read");
      } else {
        expect(scope, `${route.method} ${route.path}`).not.toBe("read");
      }
    }
  });

  it("handles method names case-insensitively", () => {
    expect(requiredScope("get", "/v1/questions")).toBe("read");
    expect(requiredScope("GeT", "/v1/questions")).toBe("read");
    expect(requiredScope("post", "/v1/questions")).toBe("message");
    expect(requiredScope("PoSt", "/v1/questions/sync")).toBe("message");
    expect(requiredScope("patch", "/v1/projects/proj-1")).toBe("operate");
    expect(requiredScope("PATCH", "/v1/projects/proj-1")).toBe("operate");
    // Case-insensitivity never widens coverage: an unknown casing of an
    // unsupported method still fails closed.
    expect(requiredScope("put", "/v1/questions")).toBeNull();
  });

  it("maps the six knowledge mutation routes to operate", () => {
    expect(requiredScope("POST", "/v1/knowledge/k-1/disposition")).toBe("operate");
    expect(requiredScope("POST", "/v1/knowledge/k-1/publish")).toBe("operate");
    expect(requiredScope("POST", "/v1/knowledge/k-1/reuse")).toBe("operate");
    expect(requiredScope("POST", "/v1/knowledge/k-1/supersede")).toBe("operate");
    expect(requiredScope("POST", "/v1/knowledge/proposals")).toBe("operate");
    expect(requiredScope("POST", "/v1/knowledge/selections")).toBe("operate");
    // A three-segment knowledge path that is not a mapped literal stays closed.
    expect(requiredScope("POST", "/v1/knowledge/k-1/unknown")).toBeNull();
  });

  it("refuses empty and unsupported HTTP methods by returning null", () => {
    expect(requiredScope("", "/v1/questions")).toBeNull();
    expect(requiredScope("PUT", "/v1/questions")).toBeNull();
    expect(requiredScope("DELETE", "/v1/questions")).toBeNull();
    expect(requiredScope("HEAD", "/v1/questions")).toBeNull();
    expect(requiredScope("OPTIONS", "/v1/questions")).toBeNull();
  });

  it("refuses non-v1 and unmapped paths by returning null", () => {
    expect(requiredScope("GET", "")).toBeNull();
    expect(requiredScope("GET", "/")).toBeNull();
    expect(requiredScope("GET", "/health")).toBeNull();
    expect(requiredScope("GET", "//v1/questions")).toBeNull();
    expect(requiredScope("GET", "/v1")).toBeNull();
    expect(requiredScope("GET", "/v2/questions")).toBeNull();
    expect(requiredScope("GET", "/v1/unknown")).toBeNull();
  });

  it("refuses empty param segments and mismatched segment counts by returning null", () => {
    // Empty :id segment under a GET list route.
    expect(requiredScope("GET", "/v1/questions//")).toBeNull();
    // Empty :id segment inside a mutation path.
    expect(requiredScope("POST", "/v1/questions//answers")).toBeNull();
    expect(requiredScope("POST", "/v1/threads//permissions")).toBeNull();
    // Extra segment beyond a mapped pattern.
    expect(requiredScope("GET", "/v1/questions/id/extra")).toBeNull();
    // Missing segment below a mapped pattern.
    expect(requiredScope("POST", "/v1/questions/sync/extra")).toBeNull();
  });

  it("keeps the frozen seven scopes intact", () => {
    expect(FROZEN_SCOPES).toEqual([
      "read",
      "message",
      "hook",
      "verdict",
      "operate",
      "orchestrate",
      "tail",
    ]);
  });
});

describe("requiredScope and normalizePath hostile-input refusals", () => {
  it("refuses null, undefined, wrong primitives, array holes, and array-likes by throwing TypeError", () => {
    const hostilePaths: unknown[] = [
      null,
      undefined,
      17,
      true,
      Symbol("nope"),
      { length: 1 },
      [],
      // Array with a hole: `indexOf` exists on arrays but `split` does not.
      (() => {
        const holey: unknown[] = new Array(2);
        holey[1] = "v1";
        return holey;
      })(),
    ];
    for (const path of hostilePaths) {
      // O(1): the failure happens on the first property access or first method
      // call; nothing scans and nothing returns a scope.
      expect(() => normalizePath(path as string), `normalizePath(${String(path)})`).toThrow(TypeError);
      expect(() => requiredScope("GET", path as string), `requiredScope path ${String(path)}`).toThrow(TypeError);
      expect(() => requiredScope(path as string, "/v1/questions"), `requiredScope method ${String(path)}`).toThrow(TypeError);
      expect(() => requiredScope(path as string, path as string), `requiredScope both ${String(path)}`).toThrow(TypeError);
    }
    // A real array still fails: it has no `split`, and `toUpperCase` is absent
    // on arrays, so both parameters reject arrays by TypeError.
    expect(() => normalizePath(["/v1/questions"] as unknown as string)).toThrow(TypeError);
    expect(() => requiredScope(["GET"] as unknown as string, "/v1/questions")).toThrow(TypeError);
  });

  it("refuses objects with throwing getters without running them and hostile Proxies without returning a scope", () => {
    // A throwing getter is never invoked: refusal happens on the first
    // missing property access (`indexOf` for a path, `toUpperCase` for a
    // method), so the failure is a TypeError and the getter body below never
    // executes. If the implementation ever ran the getter, the counter would
    // move and the RangeError would surface instead of the TypeError.
    let pathGetterRuns = 0;
    const hostilePath = {
      get split(): string[] {
        pathGetterRuns += 1;
        throw new RangeError("getter must never be run");
      },
    };
    // O(1): the failure happens on the first property access; nothing scans
    // and no getter is read.
    expect(() => normalizePath(hostilePath as unknown as string)).toThrow(TypeError);
    expect(() => requiredScope("GET", hostilePath as unknown as string)).toThrow(TypeError);
    expect(pathGetterRuns).toBe(0);

    let methodGetterRuns = 0;
    const hostileMethod = {
      get length(): number {
        methodGetterRuns += 1;
        throw new RangeError("getter must never be run");
      },
    };
    expect(() => requiredScope(hostileMethod as unknown as string, "/v1/questions")).toThrow(
      TypeError,
    );
    expect(methodGetterRuns).toBe(0);
    // A Proxy that lies consistently in every trap: it advertises an indexOf
    // that succeeds but no split, so the lie is still refused by TypeError.
    const lyingProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "indexOf") {
            return () => -1;
          }
          return undefined;
        },
      },
    );
    expect(() => normalizePath(lyingProxy as unknown as string)).toThrow(TypeError);
    expect(() => requiredScope("GET", lyingProxy as unknown as string)).toThrow(TypeError);
    // A Proxy whose get trap itself throws propagates the trap error.
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new RangeError("trap refused");
        },
      },
    );
    expect(() => requiredScope("GET", throwingProxy as unknown as string)).toThrow("trap refused");
  });

  it("handles prototype-polluting segment names without mutating Object.prototype", () => {
    const before = Object.keys(Object.prototype).length;
    // O(n) linear scan in path length; no writes occur anywhere in the module.
    expect(requiredScope("GET", "/v1/__proto__")).toBeNull();
    expect(requiredScope("GET", "/v1/questions/__proto__")).toBe("read");
    expect(requiredScope("GET", "/v1/questions/constructor")).toBe("read");
    expect(requiredScope("GET", "/v1/questions/toString")).toBe("read");
    expect(requiredScope("POST", "/v1/knowledge/__proto__/publish")).toBe("operate");
    expect(Object.keys(Object.prototype).length).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect("polluted" in ({} as Record<string, unknown>)).toBe(false);
  });

  it("processes enormous path lengths in linear time without timeout", () => {
    const huge = `/v1/questions/${"a".repeat(100_000)}`;
    const start = performance.now();
    // O(n) per matched pattern over O(patterns) patterns: linear scans, no
    // regexes, no backtracking; 100k characters complete far under a second.
    const scope = requiredScope("GET", huge);
    const elapsedMs = performance.now() - start;
    expect(scope).toBe("read");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("normalizes hostile string shapes without widening the route table", () => {
    // Query strings and percent encoding combine with the null refusals: a
    // malformed decode never bypasses the mapping and never returns a scope
    // for an unmapped route.
    expect(requiredScope("GET", "/v1/questions/%ZZ?x=1")).toBe("read");
    expect(requiredScope("GET", "/v1/unknown/%ZZ")).toBeNull();
    expect(requiredScope("POST", "/v1/questions/%ZZ/answers")).toBe("message");
    expect(requiredScope("GET", "/v1/questions/%ZZ/extra")).toBeNull();
  });
});
