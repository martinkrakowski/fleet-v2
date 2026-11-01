import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, eventHandler, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import securityMiddleware from "../server/middleware/security.js";
import { configureFleetApiRuntime } from "../server/wiring/runtime.js";
import { setActiveApiToken } from "../server/wiring/token.js";
import { configureWorkComposition } from "../server/wiring/work/composition.js";
import type { ConductorPassTraceRecord } from "@fleet/work-execution";

const VALID_TOKEN = "a".repeat(32);

// The two seeded traces, oldest first in conductor-passes.json (the ring's
// file order); the API lists them newest first.
const OLDER_PASS: ConductorPassTraceRecord = {
  schemaVersion: 1,
  passId: "pass-0001",
  nowIso: "2026-10-31T13:41:08.000Z",
  holderId: "holder-0001",
  halted: false,
  progressed: true,
  maxActiveRuns: 4,
  passConcurrency: 2,
  dispatchStaggerMs: 250,
  runs: [
    {
      runId: "run-0A1B2C3D4E5F6G7H8J9K0M1N2P",
      report: {
        outcome: "advanced",
        steps: [
          {
            outcome: "dispatched",
            step: "dispatch",
            result: "started",
          },
          { outcome: "prepared", step: "prepare", result: "ready" },
        ],
      },
    },
    {
      runId: "run-1V2T3Z4J5K6M7N8P9A0B1C2D3E",
      report: { outcome: "skipped", reason: "halted" },
    },
  ],
  attention: [{ runId: "run-1V2T3Z4J5K6M7N8P9A0B1C2D3E", kind: "skipped" }],
};

const NEWER_PASS: ConductorPassTraceRecord = {
  schemaVersion: 1,
  passId: "pass-0002",
  nowIso: "2026-10-31T13:52:04.000Z",
  holderId: "holder-0002",
  halted: true,
  progressed: false,
  maxActiveRuns: 4,
  passConcurrency: 2,
  dispatchStaggerMs: 250,
  runs: [
    {
      runId: "run-0A1B2C3D4E5F6G7H8J9K0M1N2P",
      report: { outcome: "resume-refused", reason: "halted" },
    },
    {
      runId: "run-1V2T3Z4J5K6M7N8P9A0B1C2D3E",
      report: { outcome: "skipped", reason: "halted" },
    },
  ],
  attention: [
    { runId: "run-0A1B2C3D4E5F6G7H8J9K0M1N2P", kind: "resume-refused" },
    { runId: "run-1V2T3Z4J5K6M7N8P9A0B1C2D3E", kind: "skipped" },
  ],
};

// The recorded fixture: the exact 200 OK envelope over the two seeded traces,
// with a deterministic operationId the test normalizes before comparing.
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "v1-runs-passes.json"), "utf8"),
) as { operationId: string; code: string; result: object };

/** The response with its fresh operationId replaced by the fixture's value. */
function withFixtureOperationId(body: { operationId: string }): object {
  return { ...body, operationId: FIXTURE.operationId };
}

describe("GET /v1/runs/passes", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let passesGetHandler: EventHandler;

  beforeAll(async () => {
    passesGetHandler = (await import("../server/routes/v1/runs/passes.get.js"))
      .default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-passes-test-"));
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configureWorkComposition(null);
    delete process.env.FLEET_STATE_DIR;

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.get("/v1/runs/passes", eventHandler((event) => passesGetHandler(event)));
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configureWorkComposition(null);
  });

  function configureApi(): void {
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
  }

  async function getPasses(query = "", headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/v1/runs/passes${query}`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}`, ...headers },
    });
  }

  it("answers 501 NOT_IMPLEMENTED when the work composition is unconfigured", async () => {
    const res = await fetch(`${baseUrl}/v1/runs/passes`);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe("NOT_IMPLEMENTED");
    expect(body.result).toBeNull();
  });

  it("refuses an unauthenticated request with 401 when configured", async () => {
    configureApi();
    const res = await fetch(`${baseUrl}/v1/runs/passes`);
    expect(res.status).toBe(401);
  });

  it("answers 200 OK with empty passes when conductor-passes.json is missing", async () => {
    configureApi();
    const res = await getPasses();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("OK");
    expect(body.result).toEqual({
      outcome: "listed",
      store: "readable",
      passes: [],
      total: 0,
      truncated: false,
    });
  });

  it("lists seeded traces newest first without holderId, matching the recorded fixture", async () => {
    configureApi();
    writeFileSync(
      join(tempDir, "conductor-passes.json"),
      JSON.stringify([OLDER_PASS, NEWER_PASS]),
    );

    const res = await getPasses();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operationId: string; code: string; result: object };
    expect(body.code).toBe("OK");
    // The stored holder id never crosses the port.
    expect(JSON.stringify(body)).not.toContain("holderId");
    expect(withFixtureOperationId(body)).toEqual(FIXTURE);
  });

  it("honours ?limit=1 and reports truncation", async () => {
    configureApi();
    writeFileSync(
      join(tempDir, "conductor-passes.json"),
      JSON.stringify([OLDER_PASS, NEWER_PASS]),
    );

    const res = await getPasses("?limit=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("OK");
    expect(body.result.passes).toHaveLength(1);
    expect(body.result.passes[0].passId).toBe("pass-0002");
    expect(body.result.total).toBe(2);
    expect(body.result.truncated).toBe(true);
  });

  it.each(["?limit=0", "?limit=-1", "?limit=33", "?limit=abc", "?limit=1&limit=2"])(
    "refuses an invalid limit %s with 400 INVALID_REQUEST",
    async (query) => {
      configureApi();
      const res = await getPasses(query);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_REQUEST");
      expect(body.result).toEqual({ outcome: "rejected", reason: "invalid-limit" });
    },
  );

  it("answers 200 OK unreadable for an unknown schemaVersion, never 500", async () => {
    configureApi();
    writeFileSync(join(tempDir, "conductor-passes.json"), '[{"schemaVersion":2}]');

    const res = await getPasses();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("OK");
    expect(body.result).toEqual({
      outcome: "listed",
      store: "unreadable",
      passes: [],
      total: 0,
      truncated: false,
    });
  });

  it("answers 200 OK unreadable for malformed JSON bytes, never 500", async () => {
    configureApi();
    writeFileSync(join(tempDir, "conductor-passes.json"), "not json at all");

    const res = await getPasses();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("OK");
    expect(body.result).toEqual({
      outcome: "listed",
      store: "unreadable",
      passes: [],
      total: 0,
      truncated: false,
    });
  });
});
