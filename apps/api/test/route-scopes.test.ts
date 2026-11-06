import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FROZEN_SCOPES,
  requiredScope,
} from "../server/wiring/route-scopes.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTES_ROOT = join(TESTS_DIR, "..", "server", "routes", "v1");

interface RouteEntry {
  method: string;
  path: string;
}

const ROUTE_METHOD_RE = /^(.+)\.(get|post|patch)\.ts$/;
const UNKNOWN_METHOD_RE = /^.+\.([a-z]+)\.ts$/;
const KNOWN_METHODS = ["get", "post", "patch"];

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

describe("requiredScope", () => {
  it("walks every route file under routes/v1 and finds a frozen scope", () => {
    const { entries, unknowns } = walkRouteFiles(ROUTES_ROOT);
    expect(unknowns, `route files without a mapped method: ${unknowns.join(", ")}`).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    for (const route of entries) {
      const scope = requiredScope(route.method, route.path);
      expect(scope, `${route.method} ${route.path}`).not.toBeNull();
      if (scope !== null) {
        expect([...FROZEN_SCOPES] as string[]).toContain(scope);
      }
    }
  });

  it("grants read only on explicit GET route patterns", () => {
    expect(requiredScope("GET", "/v1/questions")).toBe("read");
    expect(requiredScope("GET", "/v1/questions/")).toBe("read");
    expect(requiredScope("GET", "/v1/attempts/:id/journal")).toBe("read");
    expect(requiredScope("GET", "/v1/heads/:sha/evidence")).toBe("read");
    expect(requiredScope("GET", "/v1/not-a-route")).toBeNull();
  });

  it("maps the orchestrate family", () => {
    expect(requiredScope("POST", "/v1/orchestrators")).toBe("orchestrate");
    expect(requiredScope("POST", "/v1/orchestrators/:id/heartbeat")).toBe("orchestrate");
    expect(requiredScope("POST", "/v1/orchestrators/:id/retire")).toBe("orchestrate");
    expect(requiredScope("POST", "/v1/snapshots/:section")).toBe("orchestrate");
  });

  it("maps the message family", () => {
    expect(requiredScope("POST", "/v1/questions")).toBe("message");
    expect(requiredScope("POST", "/v1/questions/:id/answers")).toBe("message");
    expect(requiredScope("POST", "/v1/questions/:id/acknowledgement")).toBe("message");
    expect(requiredScope("POST", "/v1/questions/sync")).toBe("message");
    expect(requiredScope("POST", "/v1/questions/expire")).toBe("message");
    expect(requiredScope("POST", "/v1/relays")).toBe("message");
    expect(requiredScope("POST", "/v1/relays/:id/acknowledgement")).toBe("message");
  });

  it("maps the verdict family", () => {
    expect(requiredScope("POST", "/v1/reviews")).toBe("verdict");
    expect(requiredScope("POST", "/v1/reviews/:id/receipt")).toBe("verdict");
    expect(requiredScope("POST", "/v1/decisions")).toBe("verdict");
  });

  it("maps the hook family", () => {
    expect(requiredScope("POST", "/v1/authorizations/resolve")).toBe("hook");
    expect(requiredScope("POST", "/v1/authorizations/:id/consume")).toBe("hook");
    expect(requiredScope("POST", "/v1/forge")).toBe("hook");
  });

  it("maps the operate family", () => {
    expect(requiredScope("POST", "/v1/attempts/:id/stop")).toBe("operate");    expect(requiredScope("POST", "/v1/attempts/:id/reconcile")).toBe("operate");
    expect(requiredScope("POST", "/v1/attempts/:id/fix")).toBe("operate");
    expect(requiredScope("POST", "/v1/attempts/:id/acceptance")).toBe("operate");
    expect(requiredScope("POST", "/v1/attempts/:id/cancel-prepared")).toBe("operate");
    expect(requiredScope("POST", "/v1/attempts/:id/artifacts")).toBe("operate");
    expect(requiredScope("POST", "/v1/attempts/:id/notes")).toBe("operate");
    expect(requiredScope("POST", "/v1/owner-items/:id/resolution")).toBe("operate");
    expect(requiredScope("POST", "/v1/verifications")).toBe("operate");
    expect(requiredScope("POST", "/v1/verifications/:id/receipt")).toBe("operate");
    expect(requiredScope("POST", "/v1/observations")).toBe("operate");
    expect(requiredScope("POST", "/v1/findings/:id/disposition")).toBe("operate");
    expect(requiredScope("POST", "/v1/work-orders")).toBe("operate");
    expect(requiredScope("POST", "/v1/heads/:sha/assessment")).toBe("operate");
    expect(requiredScope("POST", "/v1/knowledge/checks")).toBe("operate");
    expect(requiredScope("POST", "/v1/projects")).toBe("operate");
    expect(requiredScope("POST", "/v1/projects/:id/retire")).toBe("operate");
    expect(requiredScope("POST", "/v1/projects/:id/probe")).toBe("operate");
    expect(requiredScope("PATCH", "/v1/projects/:id")).toBe("operate");
  });

  it("maps the run-control family to operate (A-C)", () => {
    expect(requiredScope("POST", "/v1/runs/halt")).toBe("operate");
    expect(requiredScope("POST", "/v1/runs/run-01J00000000000000000000000/stop")).toBe("operate");
    // The GETs stay null: /v1/runs reads are read-scoped, /v1/runs/:id does not exist yet.
    expect(requiredScope("GET", "/v1/runs/halt")).toBeNull();
    expect(requiredScope("GET", "/v1/runs/run-01J00000000000000000000000/stop")).toBeNull();
  });

  it("maps the brief preview dry run to read", () => {
    expect(requiredScope("POST", "/v1/briefs/preview")).toBe("read");
    expect(requiredScope("GET", "/v1/briefs/preview")).toBeNull();
  });

  it("freezes the seven scopes including tail", () => {
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

  it("fails closed on unmapped paths", () => {
    expect(requiredScope("POST", "/v1/something-new")).toBeNull();
    expect(requiredScope("POST", "/v1/not-a-route")).toBeNull();
    expect(requiredScope("POST", "/v1/attempts/not-a-route")).toBeNull();
    expect(requiredScope("POST", "/v1")).toBeNull();
    expect(requiredScope("POST", "/health")).toBeNull();
    expect(requiredScope("GET", "/")).toBeNull();
  });
});
