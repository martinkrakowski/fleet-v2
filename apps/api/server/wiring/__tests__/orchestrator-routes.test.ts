// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so install the shared shim before any route module evaluates.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toNodeListener, type EventHandler, type H3Event } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime, getChangeFeed } from "../runtime.js";
import {
  configurePresentedTokenResolver,
  presentedToken,
  SHARED_BEARER_TOKEN_ID,
} from "../presented-token.js";

const VALID_TOKEN = "a".repeat(32);

const BODY = {
  orchestratorId: "orch-example-1",
  cliKind: "claude-code",
  model: "example-provider/example-model",
  host: "example-host",
  projects: ["example-project"],
  claims: ["dispatch-attempt"],
};

const SCOPE_REASON = "the presenting token lacks the orchestrate scope";
const NOT_OWNER_REASON = "this session was registered by another token";

describe("orchestrator routes", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  let orchestratorsGetHandler: EventHandler;
  let orchestratorsPostHandler: EventHandler;
  let heartbeatPostHandler: EventHandler;
  let retirePostHandler: EventHandler;

  beforeAll(async () => {
    orchestratorsGetHandler = (await import("../../routes/v1/orchestrators/index.get.js"))
      .default;
    orchestratorsPostHandler = (await import("../../routes/v1/orchestrators/index.post.js"))
      .default;
    heartbeatPostHandler = (
      await import("../../routes/v1/orchestrators/[id]/heartbeat.post.js")
    ).default;
    retirePostHandler = (
      await import("../../routes/v1/orchestrators/[id]/retire.post.js")
    ).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-orchestrator-routes-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.get("/v1/orchestrators", orchestratorsGetHandler);
    router.post("/v1/orchestrators", orchestratorsPostHandler);
    router.post("/v1/orchestrators/:id/heartbeat", heartbeatPostHandler);
    router.post("/v1/orchestrators/:id/retire", retirePostHandler);
    app.use(router.handler);

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
    configurePresentedTokenResolver(null);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}` };
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: authHeaders() });
  }

  /** Present as a fixed non-shared token until the end of the test. */
  function presentAs(tokenId: string, scopes: readonly string[]): void {
    configurePresentedTokenResolver(() => ({ tokenId, scopes: [...scopes] }));
  }

  async function registerSession(): Promise<void> {
    const res = await post("/v1/orchestrators", BODY);
    expect(res.status).toBe(200);
  }

  interface StoredSession {
    revision: number;
    session: { status?: string; leaseUntilIso?: string } & Record<string, unknown>;
  }

  function storedSessions(): StoredSession[] {
    const parsed: unknown = JSON.parse(readFileSync(join(tempDir, "orchestrators.json"), "utf8"));
    if (Array.isArray(parsed)) {
      return parsed as StoredSession[];
    }
    const sessions = (parsed as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? (sessions as StoredSession[]) : [];
  }

  it("refuses requests without a bearer token with 401", async () => {
    const list = await fetch(`${baseUrl}/v1/orchestrators`);
    expect(list.status).toBe(401);

    const register = await fetch(`${baseUrl}/v1/orchestrators`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(register.status).toBe(401);
  });

  it("registers with the shared bearer: the session records its id and scopes, never the token", async () => {
    const res = await post("/v1/orchestrators", BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.outcome).toBe("registered");
    expect(body.result.session.registeredByTokenId).toBe(SHARED_BEARER_TOKEN_ID);
    expect(body.result.session.scopes).toEqual(["orchestrate"]);

    const stored = readFileSync(join(tempDir, "orchestrators.json"), "utf8");
    expect(stored).not.toContain(VALID_TOKEN);
  });

  it("the body never sets identity or scopes", async () => {
    for (const key of ["scopes", "registeredByTokenId", "presentedTokenId"]) {
      const res = await post("/v1/orchestrators", { ...BODY, [key]: ["orchestrate"] });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe("REFUSED");
      expect(body.result.reason).toContain("OrchestratorSession registration has an unknown key");
    }
    expect(existsSync(join(tempDir, "orchestrators.json"))).toBe(false);
  });

  it("orchestrate is required before anything is read or written", async () => {
    presentAs("token-example-msg", ["message"]);

    const refused = await post("/v1/orchestrators", BODY);
    expect(refused.status).toBe(403);
    const refusedBody = await refused.json();
    expect(refusedBody.code).toBe("FORBIDDEN");
    expect(refusedBody.result.reason).toBe(SCOPE_REASON);

    const listed = await get("/v1/orchestrators");
    expect(listed.status).toBe(200);
    expect((await listed.json()).result.sessions).toEqual([]);

    presentAs(SHARED_BEARER_TOKEN_ID, ["orchestrate"]);
    await registerSession();
    presentAs("token-example-msg", ["message"]);
    const heartbeat = await post("/v1/orchestrators/orch-example-1/heartbeat", {});
    expect(heartbeat.status).toBe(403);
    expect((await heartbeat.json()).result.reason).toBe(SCOPE_REASON);
    const retire = await post("/v1/orchestrators/orch-example-1/retire", {});
    expect(retire.status).toBe(403);
    expect((await retire.json()).result.reason).toBe(SCOPE_REASON);

    presentAs(SHARED_BEARER_TOKEN_ID, ["orchestrate"]);
    const unchanged = await get("/v1/orchestrators");
    const sessions = (await unchanged.json()).result.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session.status).toBe("active");
  });

  it("heartbeats renew the lease only for the registering token, whatever the body claims", async () => {
    await registerSession();

    const renewed = await post("/v1/orchestrators/orch-example-1/heartbeat", {});
    expect(renewed.status).toBe(200);
    expect((await renewed.json()).result.outcome).toBe("renewed");
    const leaseBefore = storedSessions()[0].session.leaseUntilIso;

    presentAs("token-example-2", ["orchestrate"]);
    const foreign = await post("/v1/orchestrators/orch-example-1/heartbeat", {
      presentedTokenId: SHARED_BEARER_TOKEN_ID,
      orchestratorId: "orch-example-1",
    });
    expect(foreign.status).toBe(403);
    const foreignBody = await foreign.json();
    expect(foreignBody.code).toBe("FORBIDDEN");
    expect(foreignBody.result.reason).toBe(NOT_OWNER_REASON);
    expect(storedSessions()[0].session.leaseUntilIso).toBe(leaseBefore);

    const missing = await post("/v1/orchestrators/orch-example-unknown/heartbeat", {});
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("NOT_FOUND");
  });

  it("retires idempotently, but only for the registering token", async () => {
    await registerSession();

    presentAs("token-example-2", ["orchestrate"]);
    const foreign = await post("/v1/orchestrators/orch-example-1/retire", {});
    expect(foreign.status).toBe(403);
    expect(storedSessions()[0].session.status).toBe("active");

    presentAs(SHARED_BEARER_TOKEN_ID, ["orchestrate"]);
    const retired = await post("/v1/orchestrators/orch-example-1/retire", {});
    expect(retired.status).toBe(200);
    expect((await retired.json()).result.outcome).toBe("retired");

    const again = await post("/v1/orchestrators/orch-example-1/retire", {});
    expect(again.status).toBe(200);
    expect((await again.json()).result.outcome).toBe("retired");
  });

  it("the feed records register and retire, never a heartbeat", async () => {
    const feed = getChangeFeed()!;
    const cursor = feed.read(null).cursor;

    await registerSession();
    await post("/v1/orchestrators/orch-example-1/heartbeat", {});
    await post("/v1/orchestrators/orch-example-1/retire", {});

    const read = feed.read(cursor);
    expect(read.kind).toBe("entries");
    if (read.kind === "entries") {
      expect(read.entries).toHaveLength(2);
      for (const entry of read.entries) {
        expect(entry.kind).toBe("orchestrator");
      }
    }
  });

  it("the token binding survives a restart", async () => {
    await registerSession();

    // A restarted process re-reads the same state dir; the binding lives in
    // the record, not in this process's memory.
    configureFleetApiRuntime({ stateDir: tempDir });
    presentAs("token-example-2", ["orchestrate"]);
    const foreign = await post("/v1/orchestrators/orch-example-1/heartbeat", {});
    expect(foreign.status).toBe(403);

    configurePresentedTokenResolver(null);
    const same = await post("/v1/orchestrators/orch-example-1/heartbeat", {});
    expect(same.status).toBe(200);
    expect((await same.json()).result.outcome).toBe("renewed");
  });

  it("lists sessions by status, and an unknown status lists nothing", async () => {
    await registerSession();

    const all = await get("/v1/orchestrators");
    expect(all.status).toBe(200);
    const sessions = (await all.json()).result.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].attached).toBe(true);

    const retired = await get("/v1/orchestrators?status=retired");
    expect((await retired.json()).result.sessions).toEqual([]);

    const bogus = await get("/v1/orchestrators?status=bogus");
    expect((await bogus.json()).result.sessions).toEqual([]);
  });

  it("an unconfigured runtime answers 501, and the middleware lets the request through", async () => {
    configureFleetApiRuntime(null);
    const res = await post("/v1/orchestrators", BODY);
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe("NOT_IMPLEMENTED");
  });

  it("presentedToken returns a fresh copy, and null restores the shared bearer", () => {
    const scopes = ["orchestrate"];
    configurePresentedTokenResolver(() => ({ tokenId: "token-example-2", scopes }));
    const event = {} as H3Event;

    const first = presentedToken(event);
    (first.scopes as string[]).push("read");
    const second = presentedToken(event);
    expect(second.tokenId).toBe("token-example-2");
    expect(second.scopes).toEqual(["orchestrate"]);
    expect(second.scopes).not.toBe(scopes);

    configurePresentedTokenResolver(null);
    const restored = presentedToken(event);
    expect(restored.tokenId).toBe(SHARED_BEARER_TOKEN_ID);
    expect(restored.scopes).toEqual(["orchestrate"]);
  });
});
