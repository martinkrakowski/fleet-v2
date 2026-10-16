import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as h3 from "h3";
import { createApp, createRouter, eventHandler, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import securityMiddleware from "../server/middleware/security.js";
import { bootstrapFleetApiFromEnv } from "../server/plugins/runtime.js";
import { readObjectBody, readQueryRecord } from "../server/wiring/http-input.js";
import {
  configureFleetApiRuntime,
  isFleetApiRuntimeConfigured,
} from "../server/wiring/runtime.js";
import {
  getActiveApiToken,
  readApiTokenFromFile,
  setActiveApiToken,
} from "../server/wiring/token.js";
import { configureWorkComposition } from "../server/wiring/work/composition.js";

// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so stub them globally before loading route modules.
for (const [key, value] of Object.entries(h3)) {
  if (typeof value === "function") {
    vi.stubGlobal(key, value);
  }
}
vi.stubGlobal("defineEventHandler", h3.defineEventHandler);
vi.stubGlobal("getRouterParam", h3.getRouterParam);
vi.stubGlobal("setResponseStatus", h3.setResponseStatus);
vi.stubGlobal("readBody", h3.readBody);
vi.stubGlobal("createError", h3.createError);
Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler,
  getRouterParam: h3.getRouterParam,
  setResponseStatus: h3.setResponseStatus,
  readBody: h3.readBody,
  createError: h3.createError,
});

const VALID_TOKEN = "a".repeat(32);
const ANOTHER_VALID_TOKEN = "b".repeat(48);

describe("API Security and Hardening", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let stopHandlerInvoked: boolean;
  let attemptGetHandler: EventHandler;
  let reconcilePostHandler: EventHandler;
  let attemptsPostHandler: EventHandler;
  let stopPostHandler: EventHandler;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(h3)) {
      if (typeof value === "function") {
        vi.stubGlobal(key, value);
      }
    }
    vi.stubGlobal("defineEventHandler", h3.defineEventHandler);
    vi.stubGlobal("getRouterParam", h3.getRouterParam);
    vi.stubGlobal("setResponseStatus", h3.setResponseStatus);
    vi.stubGlobal("readBody", h3.readBody);
    vi.stubGlobal("createError", h3.createError);
    Object.assign(globalThis, {
      defineEventHandler: h3.defineEventHandler,
      getRouterParam: h3.getRouterParam,
      setResponseStatus: h3.setResponseStatus,
      readBody: h3.readBody,
      createError: h3.createError,
    });

    attemptGetHandler = (await import("../server/routes/v1/attempts/[id].get.js")).default;
    reconcilePostHandler = (await import("../server/routes/v1/attempts/[id]/reconcile.post.js")).default;
    attemptsPostHandler = (await import("../server/routes/v1/attempts/index.post.js")).default;
    stopPostHandler = (await import("../server/routes/v1/attempts/[id]/stop.post.js")).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-test-"));
    stopHandlerInvoked = false;
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configureWorkComposition(null);
    delete process.env.FLEET_STATE_DIR;
    delete process.env.FLEET_API_TOKEN_FILE;
    delete process.env.FLEET_API_ALLOWED_ORIGINS;

    const app = createApp();
    app.use(securityMiddleware);
    app.use(
      "/v1/test",
      eventHandler(async (event) => {
        const body = await readObjectBody(event);
        const query = readQueryRecord(event);
        return { ok: true, body, query };
      }),
    );
    const router = createRouter();
    router.post("/v1/attempts/:id/reconcile", reconcilePostHandler);
    router.get("/v1/attempts/:id", attemptGetHandler);
    router.post("/v1/attempts", attemptsPostHandler);
    router.post(
      "/v1/attempts/:id/stop",
      eventHandler(async (event) => {
        stopHandlerInvoked = true;
        return stopPostHandler(event);
      }),
    );
    router.get(
      "/",
      eventHandler(() => ({ status: "ok", app: "api" })),
    );
    app.use(router.handler);
    app.use(
      "/health",
      eventHandler(() => ({ status: "up" })),
    );

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configureWorkComposition(null);
    delete process.env.FLEET_STATE_DIR;
    delete process.env.FLEET_API_TOKEN_FILE;
    delete process.env.FLEET_API_ALLOWED_ORIGINS;
  });

  describe("readApiTokenFromFile", () => {
    it("returns null for non-existent file", () => {
      expect(readApiTokenFromFile(join(tempDir, "missing"))).toBeNull();
    });

    it("returns null for symlink file", () => {
      const realPath = join(tempDir, "token-real");
      const linkPath = join(tempDir, "token-link");
      writeFileSync(realPath, VALID_TOKEN + "\n", { mode: 0o600 });
      chmodSync(realPath, 0o600);
      symlinkSync(realPath, linkPath);
      expect(readApiTokenFromFile(linkPath)).toBeNull();
    });

    it("returns null for file with group/other permissions", () => {
      const path = join(tempDir, "token-insecure");
      writeFileSync(path, VALID_TOKEN + "\n", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(readApiTokenFromFile(path)).toBeNull();
    });

    it("returns null if token length is less than 32 characters", () => {
      const path = join(tempDir, "token-short");
      writeFileSync(path, "short-secret\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      expect(readApiTokenFromFile(path)).toBeNull();
    });

    it("returns null if token contains invalid characters", () => {
      const path = join(tempDir, "token-invalid");
      writeFileSync(path, "a".repeat(31) + "!\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      expect(readApiTokenFromFile(path)).toBeNull();
    });

    it("returns valid token when file is regular mode 0600 with 32+ characters", () => {
      const path = join(tempDir, "token-ok");
      writeFileSync(path, `  ${ANOTHER_VALID_TOKEN}  \nsecond-line\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      expect(readApiTokenFromFile(path)).toBe(ANOTHER_VALID_TOKEN);
    });
  });

  describe("bootstrapFleetApiFromEnv", () => {
    it("leaves runtime unconfigured when FLEET_STATE_DIR is not set", () => {
      const result = bootstrapFleetApiFromEnv({});
      expect(result).toBe(false);
      expect(isFleetApiRuntimeConfigured()).toBe(false);
      expect(getActiveApiToken()).toBeNull();
    });

    it("leaves runtime unconfigured when FLEET_STATE_DIR is set but FLEET_API_TOKEN_FILE is missing", () => {
      const result = bootstrapFleetApiFromEnv({ FLEET_STATE_DIR: tempDir });
      expect(result).toBe(false);
      expect(isFleetApiRuntimeConfigured()).toBe(false);
      expect(getActiveApiToken()).toBeNull();
    });

    it("configures runtime and token when both are valid", () => {
      const tokenPath = join(tempDir, "token");
      writeFileSync(tokenPath, VALID_TOKEN + "\n", { mode: 0o600 });
      chmodSync(tokenPath, 0o600);

      const result = bootstrapFleetApiFromEnv({
        FLEET_STATE_DIR: tempDir,
        FLEET_API_TOKEN_FILE: tokenPath,
      });
      expect(result).toBe(true);
      expect(isFleetApiRuntimeConfigured()).toBe(true);
      expect(getActiveApiToken()).toBe(VALID_TOKEN);
    });
  });

  describe("Security Middleware", () => {
    it("allows allowlisted routes (/ and /health) without token", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "up" });

      const rootRes = await fetch(`${baseUrl}/`);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.json()).toEqual({ status: "ok", app: "api" });
    });

    it("allows allowlisted routes without token even when configured", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "up" });

      const rootRes = await fetch(`${baseUrl}/`);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.json()).toEqual({ status: "ok", app: "api" });
    });

    it("passes through /v1 routes when runtime is unconfigured", async () => {
      const res = await fetch(`${baseUrl}/v1/test`);
      expect(res.status).toBe(200);
    });

    it("refuses unauthenticated /v1 requests with 401 when configured", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/test`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(JSON.stringify(data)).not.toContain(VALID_TOKEN);
    });

    it("refuses invalid bearer token with 401", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/test`, {
        headers: {
          authorization: "Bearer wrong-token-that-is-different-length",
        },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(JSON.stringify(data)).not.toContain(VALID_TOKEN);
    });

    it("refuses wrong token of exact same length with 401", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/test`, {
        headers: {
          authorization: `Bearer ${"c".repeat(VALID_TOKEN.length)}`,
        },
      });
      expect(res.status).toBe(401);
    });

    it("accepts valid bearer token with 200", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/test`, {
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });

    it("refuses non-whitelisted Origin with 403", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });
      process.env.FLEET_API_ALLOWED_ORIGINS = "http://localhost:3000,http://fleet-v2.midnight.lan";

      const res = await fetch(`${baseUrl}/v1/test`, {
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          origin: "http://evil.com",
        },
      });
      expect(res.status).toBe(403);
    });

    it("allows whitelisted Origin with 200", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });
      process.env.FLEET_API_ALLOWED_ORIGINS = "http://localhost:3000,http://fleet-v2.midnight.lan";

      const res = await fetch(`${baseUrl}/v1/test`, {
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          origin: "http://localhost:3000",
        },
      });
      expect(res.status).toBe(200);
    });

    it("requires Content-Type: application/json on non-GET requests", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const formRes = await fetch(`${baseUrl}/v1/test`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "foo=bar",
      });
      expect(formRes.status).toBe(415);

      const jsonRes = await fetch(`${baseUrl}/v1/test`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "hello" }),
      });
      expect(jsonRes.status).toBe(200);
    });

    it("refuses /v%31/attempts/a1/stop without a token with 401 and the handler never runs", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v%31/attempts/a1/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
      expect(stopHandlerInvoked).toBe(false);
    });

    it("refuses /%76%31/... without a token with 401 and the handler never runs", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/%76%31/attempts/a1/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
      expect(stopHandlerInvoked).toBe(false);
    });

    it("refuses //v1/... without a token with 401", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const resStop = await fetch(`${baseUrl}//v1/attempts/a1/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resStop.status).toBe(401);
      expect(stopHandlerInvoked).toBe(false);

      const resTest = await fetch(`${baseUrl}//v1/test`);
      expect(resTest.status).toBe(401);
    });

    it("allows a valid token with an encoded prefix to pass checks", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const resGet = await fetch(`${baseUrl}/v%31/test`, {
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      expect(resGet.status).toBe(200);
      expect((await resGet.json()).ok).toBe(true);

      const resFullyEncoded = await fetch(`${baseUrl}/%76%31/test`, {
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      expect(resFullyEncoded.status).toBe(200);
      expect((await resFullyEncoded.json()).ok).toBe(true);

      const resStop = await fetch(`${baseUrl}/v%31/attempts/a1/stop`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(resStop.status).toBe(200);
      expect(stopHandlerInvoked).toBe(true);
    });

    it("refuses unauthenticated form-encoded POST with 401 (not 415)", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/test`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "foo=bar",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("nowIso stripping", () => {
    it("strips nowIso from parsed body and query in readObjectBody and readQueryRecord", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/test?nowIso=2026-01-01T00:00:00Z&tag=fleet`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ nowIso: "2026-01-01T00:00:00Z", key: "value" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.body).toEqual({ key: "value" });
      expect(data.query).toEqual({ tag: "fleet" });
      expect(data.body.nowIso).toBeUndefined();
      expect(data.query.nowIso).toBeUndefined();
    });
  });

  describe("M9 and M11 routes", () => {
    it("POST /v1/attempts returns 501 when unconfigured", async () => {
      const res = await fetch(`${baseUrl}/v1/attempts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
    });

    it("POST /v1/attempts returns 404 when configured", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/attempts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("GET /v1/attempts/:id routes to inspectAttempt (safe, not-found without runner mutation)", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/attempts/att-missing`, {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toEqual({ outcome: "not-found", attemptId: "att-missing" });
    });

    it("POST /v1/attempts/:id/reconcile routes to reconcileAttempt", async () => {
      setActiveApiToken(VALID_TOKEN);
      configureFleetApiRuntime({ stateDir: tempDir });

      const res = await fetch(`${baseUrl}/v1/attempts/att-missing/reconcile`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toEqual({ outcome: "not-found", attemptId: "att-missing" });
    });
  });
});
