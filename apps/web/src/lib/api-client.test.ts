import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOT_IMPLEMENTED_STATUS,
  createFleetWebApiClient,
  type FleetWebApiClientOptions,
  type LiveEndpointResult,
} from "./api-client.js";

const BASE_URL = "http://localhost:3001";

/** The deterministic local fixture a view passes in as its fallback. */
const WORK_ORDER_FIXTURE = {
  wo: "wo-0142",
  lane: "api-routes-a",
  loadedAt: "2026-10-13T14:02:10Z",
};

type WorkOrderView = typeof WORK_ORDER_FIXTURE;

/** Every URL the stub transport was asked for, in call order. */
let requestedUrls: string[] = [];

/** A stub transport: the test supplies the reply, the stub records the call. */
function stubFetch(reply: () => Promise<Response>): typeof fetch {
  return async (input) => {
    requestedUrls.push(String(input));
    return reply();
  };
}

function clientWith(reply: () => Promise<Response>) {
  const options: FleetWebApiClientOptions = {
    baseUrl: BASE_URL,
    fetchImpl: stubFetch(reply),
  };
  return createFleetWebApiClient(options);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createFleetWebApiClient", () => {
  // The environment-backed baseUrl resolution must never leak ambient
  // variables into the deterministic tests below.
  beforeEach(() => {
    delete process.env.FLEET_API_URL;
    delete process.env.NEXT_PUBLIC_FLEET_API_URL;
    delete process.env.FLEET_API_TOKEN_FILE;
  });

  afterEach(() => {
    delete process.env.FLEET_API_URL;
    delete process.env.NEXT_PUBLIC_FLEET_API_URL;
    delete process.env.FLEET_API_TOKEN_FILE;
  });

  describe("200 OK", () => {
    it("returns the live payload with source 'api'", async () => {
      const live = {
        wo: "wo-9999",
        lane: "live-lane",
        loadedAt: "2026-10-15T09:00:00Z",
      };
      const client = clientWith(() =>
        Promise.resolve(jsonResponse(200, live)),
      );

      const result: LiveEndpointResult<WorkOrderView> =
        await client.fetchWorkOrderView("wo-9999", WORK_ORDER_FIXTURE);

      expect(result).toEqual({
        source: "api",
        status: 200,
        data: live,
        fallbackReason: null,
      });
    });

    it("addresses the documented /v1 path for each view", async () => {
      requestedUrls = [];
      const client = clientWith(() =>
        Promise.resolve(jsonResponse(200, { ok: true })),
      );

      await client.fetchWorkOrderView("wo 0142/../x", {});
      await client.fetchAttemptView("att_01J9ZM8R2C", {});
      await client.fetchHeadEvidenceView("7b2d0aa", {});
      await client.fetchCoordinationView({});
      await client.fetchAttentionView({});

      expect(requestedUrls).toEqual([
        `${BASE_URL}/v1/work-orders/wo%200142%2F..%2Fx`,
        `${BASE_URL}/v1/attempts/att_01J9ZM8R2C`,
        `${BASE_URL}/v1/heads/7b2d0aa/evidence`,
        `${BASE_URL}/v1/coordination`,
        `${BASE_URL}/v1/attention`,
      ]);
    });

    it("falls back when a 200 body is not parseable JSON", async () => {
      const client = clientWith(() =>
        Promise.resolve(
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      const result = await client.fetchAttentionView(WORK_ORDER_FIXTURE);

      expect(result.source).toBe("fixture-fallback");
      expect(result.status).toBe(200);
      expect(result.data).toBe(WORK_ORDER_FIXTURE);
      expect(result.fallbackReason).toContain("unparseable JSON");
    });
  });

  describe("501 Not Implemented", () => {
    it("returns the deterministic fixture with source 'fixture-fallback'", async () => {
      const client = clientWith(() =>
        Promise.resolve(
          jsonResponse(NOT_IMPLEMENTED_STATUS, {
            operationId: "op-1",
            code: "NOT_IMPLEMENTED",
            result: null,
          }),
        ),
      );

      const result = await client.fetchAttemptView(
        "att_01J9ZM8R2C",
        WORK_ORDER_FIXTURE,
      );

      expect(result.source).toBe("fixture-fallback");
      expect(result.status).toBe(NOT_IMPLEMENTED_STATUS);
      expect(result.status).toBe(501);
      expect(result.data).toBe(WORK_ORDER_FIXTURE);
      expect(result.fallbackReason).toContain("NOT_IMPLEMENTED");
      expect(result.fallbackReason).toContain("/v1/attempts/");
    });

    it("returns the same fixture for every 501 endpoint", async () => {
      const client = clientWith(() =>
        Promise.resolve(jsonResponse(501, null)),
      );

      const results = await Promise.all([
        client.fetchWorkOrderView("wo-0142", WORK_ORDER_FIXTURE),
        client.fetchAttemptView("att_01J9ZM8R2C", WORK_ORDER_FIXTURE),
        client.fetchHeadEvidenceView("7b2d0aa", WORK_ORDER_FIXTURE),
        client.fetchCoordinationView(WORK_ORDER_FIXTURE),
        client.fetchAttentionView(WORK_ORDER_FIXTURE),
      ]);

      for (const result of results) {
        expect(result.source).toBe("fixture-fallback");
        expect(result.status).toBe(501);
        expect(result.data).toBe(WORK_ORDER_FIXTURE);
      }
    });
  });

  describe("network rejection", () => {
    it("returns the fixture with status null and never throws", async () => {
      const client = clientWith(() =>
        Promise.reject(new TypeError("fetch failed")),
      );

      const result = await client.fetchCoordinationView(WORK_ORDER_FIXTURE);

      expect(result).toEqual({
        source: "fixture-fallback",
        status: null,
        data: WORK_ORDER_FIXTURE,
        fallbackReason: "api boundary is unreachable: fetch failed",
      });
    });

    it("falls back for a non-Error rejection without leaking it", async () => {
      const client = clientWith(() =>
        Promise.reject("connection refused"),
      );

      const result = await client.fetchHeadEvidenceView(
        "7b2d0aa",
        WORK_ORDER_FIXTURE,
      );

      expect(result.source).toBe("fixture-fallback");
      expect(result.status).toBeNull();
      expect(result.data).toBe(WORK_ORDER_FIXTURE);
      expect(result.fallbackReason).toBe(
        "api boundary is unreachable: unknown error",
      );
    });
  });

  describe("other unsuccessful statuses", () => {
    it("falls back on a 404 and keeps the status", async () => {
      const client = clientWith(() =>
        Promise.resolve(jsonResponse(404, { code: "NOT_FOUND" })),
      );

      const result = await client.fetchWorkOrderView(
        "wo-nope",
        WORK_ORDER_FIXTURE,
      );

      expect(result.source).toBe("fixture-fallback");
      expect(result.status).toBe(404);
      expect(result.data).toBe(WORK_ORDER_FIXTURE);
      expect(result.fallbackReason).toBe(
        "api boundary returned 404 for /v1/work-orders/wo-nope",
      );
    });

    it("falls back on a 500 error envelope", async () => {
      const client = clientWith(() =>
        Promise.resolve(
          jsonResponse(500, { code: "INTERNAL_ERROR", result: null }),
        ),
      );

      const result = await client.fetchAttentionView(WORK_ORDER_FIXTURE);

      expect(result.status).toBe(500);
      expect(result.data).toBe(WORK_ORDER_FIXTURE);
      expect(result.fallbackReason).toBe(
        "api boundary returned 500 for /v1/attention",
      );
    });
  });

  describe("unconfigured boundary", () => {
    it("uses the fixture without attempting a request", async () => {
      requestedUrls = [];
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() =>
          Promise.resolve(jsonResponse(200, { wo: "must-not-be-read" })),
        ),
      });

      const result = await client.fetchAttemptView(
        "att_01J9ZM8R2C",
        WORK_ORDER_FIXTURE,
      );

      expect(requestedUrls).toEqual([]);
      expect(result).toEqual({
        source: "fixture-fallback",
        status: null,
        data: WORK_ORDER_FIXTURE,
        fallbackReason: "api boundary is not configured",
      });
    });

    it("treats a blank baseUrl as unconfigured", async () => {
      const client = createFleetWebApiClient({ baseUrl: "   " });

      const result = await client.fetchCoordinationView(WORK_ORDER_FIXTURE);

      expect(result.source).toBe("fixture-fallback");
      expect(result.status).toBeNull();
    });
  });

  describe("baseUrl normalisation", () => {
    it("does not double the slash when the baseUrl has a trailing one", async () => {
      requestedUrls = [];
      const client = createFleetWebApiClient({
        baseUrl: `${BASE_URL}/`,
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      await client.fetchAttentionView({});

      expect(requestedUrls).toEqual([`${BASE_URL}/v1/attention`]);
    });
  });

  describe("environment baseUrl resolution", () => {
    it("uses FLEET_API_URL when baseUrl is omitted", async () => {
      requestedUrls = [];
      process.env.FLEET_API_URL = "http://env-api-1";
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, { ok: true }))),
      });

      const result = await client.fetchAttentionView(WORK_ORDER_FIXTURE);

      expect(result.source).toBe("api");
      expect(result.status).toBe(200);
      expect(result.fallbackReason).toBeNull();
      expect(requestedUrls).toEqual(["http://env-api-1/v1/attention"]);
    });

    it("prefers FLEET_API_URL over NEXT_PUBLIC_FLEET_API_URL", async () => {
      requestedUrls = [];
      process.env.FLEET_API_URL = "http://env-api-1";
      process.env.NEXT_PUBLIC_FLEET_API_URL = "http://env-api-2";
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      await client.fetchCoordinationView({});

      expect(requestedUrls).toEqual(["http://env-api-1/v1/coordination"]);
    });

    it("uses NEXT_PUBLIC_FLEET_API_URL when FLEET_API_URL is unset", async () => {
      requestedUrls = [];
      process.env.NEXT_PUBLIC_FLEET_API_URL = "http://env-api-2/";
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      await client.fetchHeadEvidenceView("7b2d0aa", {});

      expect(requestedUrls).toEqual(["http://env-api-2/v1/heads/7b2d0aa/evidence"]);
    });

    it("trims whitespace-padded environment origins", async () => {
      requestedUrls = [];
      process.env.FLEET_API_URL = "  http://env-api-1  ";
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      await client.fetchWorkOrderView("wo-0142", {});

      expect(requestedUrls).toEqual(["http://env-api-1/v1/work-orders/wo-0142"]);
    });

    it("still forces the fixture fallback for an explicit empty baseUrl", async () => {
      requestedUrls = [];
      process.env.FLEET_API_URL = "http://env-api-1";
      const client = createFleetWebApiClient({
        baseUrl: "",
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      const result = await client.fetchAttemptView("att_01J9ZM8R2C", WORK_ORDER_FIXTURE);

      expect(requestedUrls).toEqual([]);
      expect(result).toEqual({
        source: "fixture-fallback",
        status: null,
        data: WORK_ORDER_FIXTURE,
        fallbackReason: "api boundary is not configured",
      });
    });

    it("treats a blank environment origin as unconfigured", async () => {
      requestedUrls = [];
      process.env.FLEET_API_URL = "   ";
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      const result = await client.fetchCoordinationView(WORK_ORDER_FIXTURE);

      expect(requestedUrls).toEqual([]);
      expect(result.source).toBe("fixture-fallback");
      expect(result.fallbackReason).toBe("api boundary is not configured");
    });

    it("falls back to unconfigured when neither variable is set", async () => {
      requestedUrls = [];
      const client = createFleetWebApiClient({
        fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, {}))),
      });

      const result = await client.fetchWorkOrderView("wo-0142", WORK_ORDER_FIXTURE);

      expect(requestedUrls).toEqual([]);
      expect(result.source).toBe("fixture-fallback");
      expect(result.fallbackReason).toBe("api boundary is not configured");
    });
  });

  describe("bearer token authentication", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "fleet-web-test-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("attaches Authorization header when FLEET_API_TOKEN_FILE is valid mode 0600", async () => {
      const tokenPath = join(tempDir, "token");
      const validToken = "A".repeat(32);
      writeFileSync(tokenPath, validToken + "\n", { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      process.env.FLEET_API_TOKEN_FILE = tokenPath;

      let capturedHeaders: HeadersInit | undefined;
      const client = createFleetWebApiClient({
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(200, { ok: true });
        },
      });

      await client.fetchAttentionView({});

      expect((capturedHeaders as Record<string, string>)?.authorization).toBe(`Bearer ${validToken}`);
    });

    it("attaches Authorization header when tokenFile option is provided", async () => {
      const tokenPath = join(tempDir, "token-opt");
      const validToken = "B".repeat(40);
      writeFileSync(tokenPath, validToken, { mode: 0o600 });
      chmodSync(tokenPath, 0o600);

      let capturedHeaders: HeadersInit | undefined;
      const client = createFleetWebApiClient({
        baseUrl: BASE_URL,
        tokenFile: tokenPath,
        fetchImpl: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(200, { ok: true });
        },
      });

      await client.fetchAttentionView({});

      expect((capturedHeaders as Record<string, string>)?.authorization).toBe(`Bearer ${validToken}`);
    });

    it("omits Authorization header when token file has group/other permissions (mode 0644)", async () => {
      const tokenPath = join(tempDir, "token-insecure");
      writeFileSync(tokenPath, "C".repeat(32), { mode: 0o644 });
      chmodSync(tokenPath, 0o644);
      process.env.FLEET_API_TOKEN_FILE = tokenPath;

      let capturedHeaders: HeadersInit | undefined;
      const client = createFleetWebApiClient({
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(200, { ok: true });
        },
      });

      await client.fetchAttentionView({});

      expect((capturedHeaders as Record<string, string>)?.authorization).toBeUndefined();
    });

    it("omits Authorization header when token file is a symlink", async () => {
      const realPath = join(tempDir, "token-real");
      const linkPath = join(tempDir, "token-link");
      writeFileSync(realPath, "D".repeat(32), { mode: 0o600 });
      chmodSync(realPath, 0o600);
      symlinkSync(realPath, linkPath);
      process.env.FLEET_API_TOKEN_FILE = linkPath;

      let capturedHeaders: HeadersInit | undefined;
      const client = createFleetWebApiClient({
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(200, { ok: true });
        },
      });

      await client.fetchAttentionView({});

      expect((capturedHeaders as Record<string, string>)?.authorization).toBeUndefined();
    });

    it("omits Authorization header when token is shorter than 32 characters", async () => {
      const tokenPath = join(tempDir, "token-short");
      writeFileSync(tokenPath, "short-token", { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      process.env.FLEET_API_TOKEN_FILE = tokenPath;

      let capturedHeaders: HeadersInit | undefined;
      const client = createFleetWebApiClient({
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(200, { ok: true });
        },
      });

      await client.fetchAttentionView({});

      expect((capturedHeaders as Record<string, string>)?.authorization).toBeUndefined();
    });

    it("never reads NEXT_PUBLIC_* variables for token", async () => {
      (process.env as Record<string, string>).NEXT_PUBLIC_FLEET_API_TOKEN = "E".repeat(32);
      (process.env as Record<string, string>).NEXT_PUBLIC_TOKEN_FILE = join(tempDir, "token-public");

      let capturedHeaders: HeadersInit | undefined;
      const client = createFleetWebApiClient({
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(200, { ok: true });
        },
      });

      await client.fetchAttentionView({});

      expect((capturedHeaders as Record<string, string>)?.authorization).toBeUndefined();

      delete (process.env as Record<string, string>).NEXT_PUBLIC_FLEET_API_TOKEN;
      delete (process.env as Record<string, string>).NEXT_PUBLIC_TOKEN_FILE;
    });
  });
});