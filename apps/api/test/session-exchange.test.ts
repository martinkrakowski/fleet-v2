import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as h3 from "h3";
import { createApp, createRouter, eventHandler, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import securityMiddleware from "../server/middleware/security.js";
import { configureFleetApiRuntime } from "../server/wiring/runtime.js";
import { setActiveApiToken } from "../server/wiring/token.js";
import {
  configurePresentedTokenResolver,
  presentedToken,
} from "../server/wiring/presented-token.js";
import {
  ACTOR_REFUSAL_REASON,
  configureSessionExchange,
  dropInteractiveSession,
  getInteractiveSession,
  isValidActor,
  LIVE_SESSION_LIMIT,
  registerInteractiveSession,
  SESSION_EXCHANGE_HEADER,
  SESSION_EXCHANGE_PATH,
  TOKENS_PER_SESSION_LIMIT,
  validateActor,
} from "../server/wiring/session-exchange.js";

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

describe("T3b session exchange", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let stopHandlerInvoked: boolean;
  let exchangePostHandler: EventHandler;
  let healthGetHandler: EventHandler;

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

    exchangePostHandler = (await import("../server/routes/sessions/exchange.post.js")).default;
    healthGetHandler = (await import("../server/routes/health.get.js")).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-session-exchange-test-"));
    stopHandlerInvoked = false;
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configurePresentedTokenResolver(null);
    configureSessionExchange();
    delete process.env.FLEET_STATE_DIR;
    delete process.env.FLEET_API_TOKEN_FILE;
    delete process.env.FLEET_API_ALLOWED_ORIGINS;

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post(SESSION_EXCHANGE_PATH, exchangePostHandler);
    router.post("/v1/decisions", eventHandler((event) => ({ presented: presentedToken(event) })));
    router.get("/v1/questions", eventHandler((event) => ({ presented: presentedToken(event) })));
    router.post(
      "/v1/attempts/:id/stop",
      eventHandler(() => {
        stopHandlerInvoked = true;
        return { ok: true };
      }),
    );
    router.get("/unscoped", eventHandler(() => ({ ok: true })));
    app.use(router.handler);
    app.use("/health", healthGetHandler);

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
    configureSessionExchange();
    delete process.env.FLEET_STATE_DIR;
    delete process.env.FLEET_API_TOKEN_FILE;
    delete process.env.FLEET_API_ALLOWED_ORIGINS;
  });

  function configuredApi(): void {
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
  }

  function sessionSecret(scopes: string[], actor = "owner"): string {
    const session = registerInteractiveSession({
      actor,
      scopes,
    });
    expect(session).not.toBeNull();
    return (session as { secret: string }).secret;
  }

  function exchangeUrl(): string {
    return `${baseUrl}${SESSION_EXCHANGE_PATH}`;
  }

  async function mint(secret: string, scopes: string[]): Promise<{ token: string; tokenId: string }> {
    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({ scopes }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("mints a token bound to the session actor and keeps it in memory only", async () => {
    configuredApi();
    const before = readdirSync(tempDir).sort();
    const secret = sessionSecret(["verdict"]);

    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const data = await res.json();
    expect(typeof data.tokenId).toBe("string");
    expect(data.tokenId.length).toBeGreaterThan(0);
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThanOrEqual(32);
    expect(data.scopes).toEqual(["verdict"]);
    expect(data.actor).toBe("owner");

    // No new file appears in the temp state dir (in-memory only).
    expect(readdirSync(tempDir).sort()).toEqual(before);
  });

  it("refuses to mint orchestrate", async () => {
    configuredApi();
    const secret = sessionSecret(["verdict"]);

    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["orchestrate"] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: scope requested is not mintable" });
  });

  it("refuses dispatch, unknown and unpermitted scopes and echoes nothing", async () => {
    configuredApi();
    const secret = sessionSecret(["verdict"]);

    for (const scopes of [["dispatch"], ["not-a-scope"], ["read"]]) {
      const res = await fetch(exchangeUrl(), {
        method: "POST",
        headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
        body: JSON.stringify({ scopes }),
      });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain("dispatch");
      expect(text).not.toContain("not-a-scope");
      expect(text).not.toContain("read");
    }

    const noScopes = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noScopes.status).toBe(403);
    expect(await noScopes.json()).toEqual({ error: "Forbidden: scope requested is not mintable" });
  });

  it("refuses the on-disk bearer on the exchange", async () => {
    configuredApi();
    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a missing or wrong session credential without echoing it", async () => {
    configuredApi();
    const wrongSecret = "x".repeat(40);

    const missing = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(missing.status).toBe(403);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.text()).not.toContain("verdict");

    const wrong = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: wrongSecret, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("cache-control")).toBe("no-store");
    expect(await wrong.text()).not.toContain(wrongSecret);
  });

  it("lets a minted token authenticate /v1 by its scopes and carries the actor", async () => {
    configuredApi();
    const secret = sessionSecret(["verdict"]);
    const minted = await mint(secret, ["verdict"]);

    const res = await fetch(`${baseUrl}/v1/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presented.tokenId).toBe(minted.tokenId);
    expect(body.presented.scopes).toEqual(["verdict"]);
    expect(body.presented.actor).toBe("owner");
  });

  it("enforces scopes for session tokens", async () => {
    configuredApi();
    const secret = sessionSecret(["read"]);
    const minted = await mint(secret, ["read"]);

    const getRes = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(getRes.status).toBe(200);

    const stopRes = await fetch(`${baseUrl}/v1/attempts/a1/stop`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(stopRes.status).toBe(403);
    expect(await stopRes.json()).toEqual({ error: "Forbidden: scope required" });
    expect(stopHandlerInvoked).toBe(false);
  });

  it("keeps minted tokens in memory only and clears them with the registry", async () => {
    configuredApi();
    const before = readdirSync(tempDir).sort();
    const secret = sessionSecret(["read"]);
    const minted = await mint(secret, ["read"]);

    configureSessionExchange();

    const res = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(res.status).toBe(401);
    expect(readdirSync(tempDir).sort()).toEqual(before);
  });

  it("fails closed at the live token limit and keeps earlier tokens working", async () => {
    configuredApi();
    const secret = sessionSecret(["read"]);
    const minted: string[] = [];
    for (let i = 0; i < 16; i++) {
      minted.push((await mint(secret, ["read"])).token);
    }

    const over = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({ error: "Forbidden: scope requested is not mintable" });

    const res = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${minted[0]}` },
    });
    expect(res.status).toBe(200);
  });

  it("never treats the on-disk bearer as an interactive session", async () => {
    configuredApi();

    // The active API bearer is the reusable on-disk token. Presenting it as the
    // session-credential header must not mint: no session was ever established,
    // and possession of a file-backed bearer is never owner authentication.
    const asSessionCredential = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        [SESSION_EXCHANGE_HEADER]: VALID_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(asSessionCredential.status).toBe(403);
    expect(await asSessionCredential.text()).not.toContain(VALID_TOKEN);

    // Only a server-established interactive session (the login lane) can mint,
    // and the minted token binds to the actor the login recorded.
    const secret = sessionSecret(["verdict"], "verified-owner");
    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        [SESSION_EXCHANGE_HEADER]: secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.actor).toBe("verified-owner");
  });

  it("refuses registration of orchestrate, dispatch or unknown scopes and a blank actor", () => {
    configureFleetApiRuntime({ stateDir: tempDir });

    expect(
      registerInteractiveSession({ actor: "owner", scopes: ["orchestrate"] }),
    ).toBeNull();
    expect(
      registerInteractiveSession({ actor: "owner", scopes: ["dispatch"] }),
    ).toBeNull();
    expect(
      registerInteractiveSession({ actor: "owner", scopes: ["not-a-scope"] }),
    ).toBeNull();
    expect(
      registerInteractiveSession({ actor: "owner", scopes: [] }),
    ).toBeNull();
    expect(
      registerInteractiveSession({ actor: "   ", scopes: ["read"] }),
    ).toBeNull();

    // Only the mintable, registered scopes ever reach a session.
    const session = registerInteractiveSession({
      actor: "owner",
      scopes: ["read", "verdict"],
    });
    expect(session).not.toBeNull();
    expect(session?.scopes).toEqual(["read", "verdict"]);
    expect(getInteractiveSession(session!.sessionId)?.scopes).toEqual(["read", "verdict"]);
  });

  it("fails closed when the exchange has no established session", async () => {
    configuredApi();
    configureSessionExchange();

    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        [SESSION_EXCHANGE_HEADER]: "a".repeat(40),
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(res.status).toBe(403);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const v1 = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(v1.status).toBe(200);
  });

  it("returns Cache-Control: no-store when rejected by the origin check", async () => {
    configuredApi();
    process.env.FLEET_API_ALLOWED_ORIGINS = "http://localhost:3000";
    const secret = sessionSecret(["verdict"]);

    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        [SESSION_EXCHANGE_HEADER]: secret,
        "content-type": "application/json",
        origin: "http://evil.com",
      },
      body: JSON.stringify({ scopes: ["verdict"] }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden origin" });
  });

  it("sets Cache-Control: no-store before reading body so every response has it", async () => {
    configuredApi();
    const secret = sessionSecret(["verdict"]);

    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        [SESSION_EXCHANGE_HEADER]: secret,
        "content-type": "application/json",
      },
      body: "not-json{",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses GET requests on the exchange", async () => {
    configuredApi();
    const secret = sessionSecret(["verdict"]);

    const res = await fetch(exchangeUrl(), {
      method: "GET",
      headers: {
        [SESSION_EXCHANGE_HEADER]: secret,
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "Forbidden: session exchange requires the interactive session credential",
    });
  });

  it("limits an actor to at most 128 characters of [A-Za-z0-9._@-], refusing anything else with a fixed reason", () => {
    configureFleetApiRuntime({ stateDir: tempDir });

    // Valid actors
    expect(isValidActor("owner")).toBe(true);
    expect(isValidActor("user@domain.org")).toBe(true);
    expect(isValidActor("agent_1.0-alpha")).toBe(true);
    expect(isValidActor("a".repeat(128))).toBe(true);
    expect(validateActor("owner")).toEqual({ ok: true, actor: "owner" });

    // Invalid actors: length > 128
    expect(isValidActor("a".repeat(129))).toBe(false);
    expect(validateActor("a".repeat(129))).toEqual({ ok: false, reason: ACTOR_REFUSAL_REASON });

    // Invalid actors: empty or whitespace
    expect(isValidActor("")).toBe(false);
    expect(isValidActor("   ")).toBe(false);
    expect(validateActor("")).toEqual({ ok: false, reason: ACTOR_REFUSAL_REASON });

    // Invalid actors: forbidden characters
    expect(isValidActor("user name")).toBe(false);
    expect(isValidActor("user!name")).toBe(false);
    expect(isValidActor("user/admin")).toBe(false);
    expect(isValidActor("user#1")).toBe(false);
    expect(isValidActor("user$")).toBe(false);
    expect(validateActor("user!name")).toEqual({ ok: false, reason: ACTOR_REFUSAL_REASON });

    // Invalid actors: non-string
    expect(isValidActor(null)).toBe(false);
    expect(isValidActor(undefined)).toBe(false);
    expect(isValidActor(123)).toBe(false);
    expect(validateActor(null)).toEqual({ ok: false, reason: ACTOR_REFUSAL_REASON });

    // registerInteractiveSession refuses invalid actors
    expect(registerInteractiveSession({ actor: "a".repeat(129), scopes: ["read"] })).toBeNull();
    expect(registerInteractiveSession({ actor: "owner!", scopes: ["read"] })).toBeNull();
    expect(registerInteractiveSession({ actor: "owner/admin", scopes: ["read"] })).toBeNull();
    expect(registerInteractiveSession({ actor: "owner name", scopes: ["read"] })).toBeNull();
  });

  it("stores sessionId on each live token", async () => {
    configuredApi();
    const session = registerInteractiveSession({ actor: "owner", scopes: ["read"] });
    expect(session).not.toBeNull();
    const minted = await mint(session!.secret, ["read"]);

    const res = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presented.sessionId).toBe(session!.sessionId);
  });

  it("drops an interactive session and removes its tokens", async () => {
    configuredApi();
    const sessionA = registerInteractiveSession({ actor: "owner-a", scopes: ["read"] });
    const sessionB = registerInteractiveSession({ actor: "owner-b", scopes: ["read"] });
    expect(sessionA).not.toBeNull();
    expect(sessionB).not.toBeNull();

    const mintedA = await mint(sessionA!.secret, ["read"]);
    const mintedB = await mint(sessionB!.secret, ["read"]);

    // Both tokens work initially
    const resA1 = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${mintedA.token}` },
    });
    expect(resA1.status).toBe(200);
    const resB1 = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${mintedB.token}` },
    });
    expect(resB1.status).toBe(200);

    // Drop session A
    const dropped = dropInteractiveSession(sessionA!.sessionId);
    expect(dropped).toBe(true);

    // Session A is gone from getInteractiveSession
    expect(getInteractiveSession(sessionA!.sessionId)).toBeNull();

    // Token A is refused
    const resA2 = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${mintedA.token}` },
    });
    expect(resA2.status).toBe(401);

    // Session A secret is refused on exchange
    const exchangeA = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: sessionA!.secret, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(exchangeA.status).toBe(403);

    // Session B and its token are unaffected
    const resB2 = await fetch(`${baseUrl}/v1/questions`, {
      headers: { authorization: `Bearer ${mintedB.token}` },
    });
    expect(resB2.status).toBe(200);
    expect(getInteractiveSession(sessionB!.sessionId)).not.toBeNull();
  });

  it("enforces the 16-token limit per session so one session cannot lock out others", async () => {
    configuredApi();
    const secretA = sessionSecret(["read"], "owner-a");
    const secretB = sessionSecret(["read"], "owner-b");

    // Session A mints 16 tokens
    for (let i = 0; i < TOKENS_PER_SESSION_LIMIT; i++) {
      await mint(secretA, ["read"]);
    }

    // Session A cannot mint a 17th token
    const overA = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secretA, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(overA.status).toBe(403);
    expect(await overA.json()).toEqual({ error: "Forbidden: scope requested is not mintable" });

    // Session B is not locked out and can mint its tokens
    const mintedB = await mint(secretB, ["read"]);
    expect(typeof mintedB.token).toBe("string");
  });

  it("caps live sessions at a fixed limit and refuses registration beyond it", () => {
    configuredApi();
    const sessionIds: string[] = [];
    for (let i = 0; i < LIVE_SESSION_LIMIT; i++) {
      const s = registerInteractiveSession({
        actor: `owner-${i}`,
        scopes: ["read"],
      });
      expect(s).not.toBeNull();
      sessionIds.push(s!.sessionId);
    }

    // Beyond the cap is refused
    const over = registerInteractiveSession({
      actor: "owner-extra",
      scopes: ["read"],
    });
    expect(over).toBeNull();

    // Dropping a session allows a new session to be registered
    expect(dropInteractiveSession(sessionIds[0])).toBe(true);
    const replacement = registerInteractiveSession({
      actor: "owner-replacement",
      scopes: ["read"],
    });
    expect(replacement).not.toBeNull();
  });

  it("refuses a scoped read token on any path outside /v1 while allowing the shared bearer", async () => {
    configuredApi();
    const secret = sessionSecret(["read"]);
    const minted = await mint(secret, ["read"]);

    // Scoped token is refused on /unscoped
    const resScoped = await fetch(`${baseUrl}/unscoped`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(resScoped.status).toBe(401);
    expect(await resScoped.json()).toEqual({ error: "Unauthorized: invalid bearer token" });

    // Shared bearer is permitted on /unscoped
    const resShared = await fetch(`${baseUrl}/unscoped`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(resShared.status).toBe(200);
    expect(await resShared.json()).toEqual({ ok: true });
  });

  it("refuses a minted token as a bearer on the exchange", async () => {
    configuredApi();
    const secret = sessionSecret(["read"]);
    const minted = await mint(secret, ["read"]);

    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
