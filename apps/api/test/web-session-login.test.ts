import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as h3 from "h3";
import { createApp, createRouter, eventHandler, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import securityMiddleware from "../server/middleware/security.js";
import { bootstrapFleetApiFromEnv } from "../server/plugins/runtime.js";
import { configureFleetApiRuntime } from "../server/wiring/runtime.js";
import { setActiveApiToken } from "../server/wiring/token.js";
import {
  configurePresentedTokenResolver,
  presentedToken,
} from "../server/wiring/presented-token.js";
import {
  configureSessionExchange,
  dropInteractiveSession,
  getInteractiveSession,
  LIVE_SESSION_LIMIT,
  registerInteractiveSession,
  SESSION_EXCHANGE_HEADER,
  SESSION_EXCHANGE_PATH,
} from "../server/wiring/session-exchange.js";
import {
  consumeWebLoginCode,
  issueWebLoginCode,
  removeWebLoginCodeFile,
  resetWebLogin,
  WEB_LOGIN_CODE_FILE,
  WEB_LOGIN_CODE_MAX_LENGTH,
  WEB_LOGIN_HEADER,
  WEB_LOGIN_PATH,
} from "../server/wiring/web-login.js";

// The module seam for the temp-file suffix: `randomBytes(16)` (the suffix) can be
// pinned so a test can plant a file at the temp path; every other call is real.
const randomSeam = vi.hoisted(() => ({ pinnedSuffix: null as Buffer | null, sizes: [] as number[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = ((size: number) => {
    randomSeam.sizes.push(size);
    return size === 16 && randomSeam.pinnedSuffix !== null
      ? randomSeam.pinnedSuffix
      : actual.randomBytes(size);
  }) as typeof actual.randomBytes;
  return { ...actual, randomBytes };
});

// The module seam for chmod: every `chmodSync` call is recorded (path only) and
// then forwarded, so a test can assert that no chmod runs on the final code path.
const chmodSeam = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync = ((path: Parameters<typeof actual.chmodSync>[0], mode: Parameters<typeof actual.chmodSync>[1]) => {
    chmodSeam.paths.push(String(path));
    return actual.chmodSync(path, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync };
});

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

function syntheticEvent(headers: Record<string, unknown>): {
  node: { req: { headers: Record<string, unknown> }; res: { statusCode: number; setHeader(name: string, value: string): void } };
} {
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string): void {
      // captured by closure; only statusCode is asserted by the hostile test
      void name;
      void value;
    },
  };
  return { node: { req: { headers }, res } };
}

describe("T6a web session login", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let loginPostHandler: EventHandler;
  let exchangePostHandler: EventHandler;

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

    loginPostHandler = (await import("../server/routes/sessions/login.post.js")).default;
    exchangePostHandler = (await import("../server/routes/sessions/exchange.post.js")).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-web-session-login-test-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
    configurePresentedTokenResolver(null);
    configureSessionExchange();
    resetWebLogin();
    delete process.env.FLEET_API_ALLOWED_ORIGINS;

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post(WEB_LOGIN_PATH, loginPostHandler);
    router.post(SESSION_EXCHANGE_PATH, exchangePostHandler);
    const scopeStub = eventHandler((event) => ({
      scopes: presentedToken(event).scopes,
      sessionId: presentedToken(event).sessionId ?? null,
    }));
    router.post("/v1/questions", scopeStub);
    router.post("/v1/decisions", scopeStub);
    router.post("/v1/attempts/:id/stop", scopeStub);
    router.post("/v1/orchestrators", scopeStub);
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
    configureSessionExchange();
    resetWebLogin();
    randomSeam.pinnedSuffix = null;
    randomSeam.sizes.length = 0;
    chmodSeam.paths.length = 0;
    delete process.env.FLEET_API_ALLOWED_ORIGINS;
  });

  function loginUrl(): string {
    return `${baseUrl}${WEB_LOGIN_PATH}`;
  }

  function exchangeUrl(): string {
    return `${baseUrl}${SESSION_EXCHANGE_PATH}`;
  }

  async function loginWithCode(code: string): Promise<{ status: number; body: any; text: string }> {
    const res = await fetch(loginUrl(), {
      method: "POST",
      headers: { [WEB_LOGIN_HEADER]: code, "content-type": "application/json" },
      body: "{}",
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body stays null
    }
    return { status: res.status, body, text };
  }

  async function exchange(
    secret: string,
    scopes: string[],
  ): Promise<{ status: number; body: any; text: string }> {
    const res = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({ scopes }),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body stays null
    }
    return { status: res.status, body, text };
  }

  it("a login with the issued code establishes an interactive session that mints read and message only", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    expect(code).toBeTruthy();

    const login = await loginWithCode(code);
    expect(login.status).toBe(200);
    expect(login.body.actor).toBe("owner");
    expect(login.body.scopes).toEqual(["read", "message"]);
    expect(typeof login.body.sessionId).toBe("string");
    expect(typeof login.body.secret).toBe("string");

    const minted = await exchange(login.body.secret, ["read", "message"]);
    expect(minted.status).toBe(200);
    expect(minted.body.scopes).toEqual(["read", "message"]);
    expect(minted.body.scopes).not.toContain("verdict");
    expect(minted.body.scopes).not.toContain("hook");
    expect(minted.body.scopes).not.toContain("operate");
    expect(minted.body.scopes).not.toContain("orchestrate");
    expect(minted.body.scopes).not.toContain("tail");
  });

  it("a web session token reaches a message route and is refused on the verdict, operate and orchestrate routes", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    const login = await loginWithCode(code);
    const minted = await exchange(login.body.secret, ["read", "message"]);
    const token = minted.body.token;

    const questions = await fetch(`${baseUrl}/v1/questions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(questions.status).toBe(200);
    const questionsBody = await questions.json();
    expect(questionsBody.scopes).toEqual(["read", "message"]);
    expect(typeof questionsBody.sessionId).toBe("string");

    for (const path of ["/v1/decisions", "/v1/attempts/x/stop", "/v1/orchestrators"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    }
  });

  it("a web session cannot mint a verdict token", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    const login = await loginWithCode(code);
    const minted = await exchange(login.body.secret, ["verdict"]);
    expect(minted.status).toBe(403);
    expect(minted.body).toEqual({ error: "Forbidden: scope requested is not mintable" });
  });

  it("the login code is single use", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    const first = await loginWithCode(code);
    expect(first.status).toBe(200);

    const second = await loginWithCode(code);
    expect(second.status).toBe(403);
    expect(second.body).toEqual({ error: "Forbidden: the web login code was refused" });
    expect(second.text).not.toContain(code);

    // The first session survives, and the code is gone from the module state.
    expect(getInteractiveSession(first.body.sessionId)).not.toBeNull();
    expect(consumeWebLoginCode(code).ok).toBe(false);
  });

  it("a wrong or missing code is refused with a fixed body that never echoes the presented value", async () => {
    issueWebLoginCode(tempDir);
    const wrong = "wrong-code-value";
    const bad = await loginWithCode(wrong);
    expect(bad.status).toBe(403);
    expect(bad.body).toEqual({ error: "Forbidden: the web login code was refused" });
    expect(bad.text).not.toContain(wrong);
    expect(bad.text).not.toContain(WEB_LOGIN_CODE_FILE);
    expect(bad.text).not.toContain(tempDir);

    const missing = await fetch(loginUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(403);
    const missingText = await missing.text();
    expect(missingText).not.toContain(WEB_LOGIN_CODE_FILE);
    expect(missingText).not.toContain(tempDir);
  });

  it("the shared bearer never establishes an interactive session", async () => {
    const res = await fetch(loginUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: the web login code was refused" });

    // No interactive session exists afterwards: the bearer was never turned into one.
    expect(getInteractiveSession("bearer-session")).toBeNull();
    expect(getInteractiveSession(VALID_TOKEN)).toBeNull();

    const exchangeRes = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { [SESSION_EXCHANGE_HEADER]: VALID_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(exchangeRes.status).toBe(403);
  });

  it("a browser origin cannot reach the login route", async () => {
    const res = await fetch(loginUrl(), {
      method: "POST",
      headers: { origin: "http://example.com", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("a disallowed origin gets the login route's own refusal and no-store, other routes keep the generic refusal", async () => {
    process.env.FLEET_API_ALLOWED_ORIGINS = "http://allowed.example";
    const login = await fetch(loginUrl(), {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(login.status).toBe(403);
    expect(login.headers.get("cache-control")).toBe("no-store");
    expect(await login.json()).toEqual({ error: "Forbidden: the web login is a server-side call" });

    const allowedOriginLogin = await fetch(loginUrl(), {
      method: "POST",
      headers: { origin: "http://allowed.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(allowedOriginLogin.status).toBe(403);
    expect(await allowedOriginLogin.json()).toEqual({
      error: "Forbidden: the web login is a server-side call",
    });

    const other = await fetch(`${baseUrl}/v1/questions`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "Forbidden origin" });
  });

  it("a non-POST request and a request without the json content type are refused", async () => {
    const getRes = await fetch(loginUrl(), { method: "GET" });
    expect(getRes.status).toBe(403);
    expect(await getRes.json()).toEqual({ error: "Forbidden: the web login is a POST" });

    const noJson = await fetch(loginUrl(), {
      method: "POST",
      headers: {},
      body: "{}",
    });
    expect(noJson.status).toBe(415);
    expect(noJson.headers.get("cache-control")).toBe("no-store");
  });

  it("the login route answers a hostile request with a refusal and never throws", async () => {
    issueWebLoginCode(tempDir);

    // Real server: null body and non-object bodies never crash; without a valid
    // code they are refused.
    for (const body of ["null", "[]", '"x"', "7"]) {
      const res = await fetch(loginUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(403);
    }

    // Real server: an oversized header value is refused.
    const oversized = await fetch(loginUrl(), {
      method: "POST",
      headers: {
        [WEB_LOGIN_HEADER]: "x".repeat(WEB_LOGIN_CODE_MAX_LENGTH + 1),
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(oversized.status).toBe(403);

    // Direct handler invocation: a non-string header value is refused without throwing.
    const nonStringEvent = syntheticEvent({ [WEB_LOGIN_HEADER]: 123 });
    let nonStringThrew = false;
    let nonStringResult: unknown;
    try {
      nonStringResult = (loginPostHandler as (event: unknown) => unknown)(nonStringEvent);
    } catch {
      nonStringThrew = true;
    }
    expect(nonStringThrew).toBe(false);
    expect(nonStringEvent.node.res.statusCode).toBe(403);
    expect(nonStringResult).toEqual({ error: "Forbidden: the web login code was refused" });

    // A header whose getter throws is treated as missing and refused without throwing.
    const throwingHeaders = new Proxy<Record<string, unknown>>(
      { [WEB_LOGIN_HEADER]: "" },
      {
        get(target, prop) {
          if (String(prop).toLowerCase() === WEB_LOGIN_HEADER) {
            throw new Error("boom");
          }
          return Reflect.get(target, prop);
        },
      },
    );
    const throwingEvent = syntheticEvent(throwingHeaders);
    let throwingThrew = false;
    let throwingResult: unknown;
    try {
      throwingResult = (loginPostHandler as (event: unknown) => unknown)(throwingEvent);
    } catch {
      throwingThrew = true;
    }
    expect(throwingThrew).toBe(false);
    expect(throwingEvent.node.res.statusCode).toBe(403);
    expect(throwingResult).toEqual({ error: "Forbidden: the web login code was refused" });
  });

  it("the login code file holds only the code and its timestamp and is mode 0600", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    expect(code).toBeTruthy();
    const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["code", "issuedAtIso"]);
    expect(parsed.code).toBe(code);
    expect(typeof parsed.issuedAtIso).toBe("string");
    expect(statSync(filePath).mode & 0o077).toBe(0);
  });

  it("a consumed login code is removed from the state directory", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
    expect(existsSync(filePath)).toBe(true);
    const login = await loginWithCode(code);
    expect(login.status).toBe(200);
    expect(existsSync(filePath)).toBe(false);
  });

  it("a refused login leaves the code file in place", async () => {
    issueWebLoginCode(tempDir);
    const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
    const refused = await loginWithCode("a-wrong-code");
    expect(refused.status).toBe(403);
    expect(existsSync(filePath)).toBe(true);
  });

  it("a login refused by the live-session limit leaves the code usable", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);

    // Fill every live-session slot so a further registration is refused. The
    // code must not be spent by that refusal: it stays usable for a later
    // login once a slot frees up, with no API restart.
    const sessionIds: string[] = [];
    for (let i = 0; i < LIVE_SESSION_LIMIT; i += 1) {
      const session = registerInteractiveSession({ actor: "owner", scopes: ["read", "message"] });
      expect(session).not.toBeNull();
      if (session !== null) {
        sessionIds.push(session.sessionId);
      }
    }

    const refused = await loginWithCode(code);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "Forbidden: no interactive session could be established" });

    expect(existsSync(filePath)).toBe(true);
    expect(dropInteractiveSession(sessionIds[0])).toBe(true);

    const login = await loginWithCode(code);
    expect(login.status).toBe(200);
    expect(login.body.sessionId).not.toBe(sessionIds[0]);
  });

  it("the login code never appears in a response body", async () => {
    const code = issueWebLoginCode(tempDir) as string;
    const login = await loginWithCode(code);
    expect(login.status).toBe(200);
    expect(login.text).not.toContain(code);
    expect(login.text).not.toContain(code.slice(0, 20));
    expect(login.text).not.toContain(code.slice(20));
    expect(login.text).not.toContain(WEB_LOGIN_CODE_FILE);
  });

  it("with no runtime configured the login route refuses", async () => {
    configureFleetApiRuntime(null);
    const res = await fetch(loginUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(getInteractiveSession("probe")).toBeNull();

    const exchangeRes = await fetch(exchangeUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(exchangeRes.status).toBe(403);
  });

  it("a code file that cannot be written leaves the login closed", async () => {
    const blocker = join(tempDir, "blocker");
    writeFileSync(blocker, "");
    const issued = issueWebLoginCode(blocker);
    expect(issued).toBeNull();

    const res = await fetch(loginUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(getInteractiveSession("probe")).toBeNull();
  });

  describe("HD1 code file hardening", () => {
    const PINNED = Buffer.alloc(16, 7);

    function pinnedTempPath(): string {
      return join(tempDir, `${WEB_LOGIN_CODE_FILE}.${PINNED.toString("hex")}.tmp`);
    }

    it("the temp file name carries a random 16-byte suffix, not the pid and the clock", () => {
      const code = issueWebLoginCode(tempDir);
      expect(code).toBeTruthy();
      expect(randomSeam.sizes).toContain(16);
      expect(readdirSync(tempDir)).toEqual([WEB_LOGIN_CODE_FILE]);
    });

    it("a symlink planted at the temp path is not followed: the issue fails closed", () => {
      const victim = join(tempDir, "victim.txt");
      writeFileSync(victim, "untouched");
      symlinkSync(victim, pinnedTempPath());
      randomSeam.pinnedSuffix = PINNED;

      expect(issueWebLoginCode(tempDir)).toBeNull();
      expect(readFileSync(victim, "utf8")).toBe("untouched");
      expect(existsSync(join(tempDir, WEB_LOGIN_CODE_FILE))).toBe(false);
      expect(consumeWebLoginCode("anything").ok).toBe(false);
    });

    it("an existing file at the temp path makes the issue fail closed without a throw", () => {
      writeFileSync(pinnedTempPath(), "planted");
      randomSeam.pinnedSuffix = PINNED;

      let issued: string | null = "not-called";
      expect(() => {
        issued = issueWebLoginCode(tempDir);
      }).not.toThrow();
      expect(issued).toBeNull();
      expect(existsSync(join(tempDir, WEB_LOGIN_CODE_FILE))).toBe(false);
      expect(consumeWebLoginCode("anything").ok).toBe(false);
    });

    it("a failed issue removes a code file left by an earlier run", () => {
      const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
      writeFileSync(filePath, '{"code":"stale","issuedAtIso":"2026-01-01T00:00:00.000Z"}\n');
      writeFileSync(pinnedTempPath(), "planted");
      randomSeam.pinnedSuffix = PINNED;

      expect(issueWebLoginCode(tempDir)).toBeNull();
      expect(existsSync(filePath)).toBe(false);
    });

    it("a refused bootstrap removes a code file left by an earlier run", () => {
      const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
      for (const env of [
        { FLEET_STATE_DIR: tempDir },
        { FLEET_STATE_DIR: tempDir, FLEET_API_TOKEN_FILE: join(tempDir, "missing-token") },
        { FLEET_STATE_DIR: `  ${tempDir}  `, FLEET_API_TOKEN_FILE: "   " },
      ]) {
        writeFileSync(filePath, '{"code":"stale","issuedAtIso":"2026-01-01T00:00:00.000Z"}\n');
        expect(bootstrapFleetApiFromEnv(env)).toBe(false);
        expect(existsSync(filePath)).toBe(false);
      }
    });

    it("the issued code file is mode 0600 and no chmod runs on its final path", () => {
      const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
      expect(issueWebLoginCode(tempDir)).toBeTruthy();
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(chmodSeam.paths.includes(filePath)).toBe(false);
    });

    it("an invalid installation refuses the bootstrap and removes a code file left by an earlier run", () => {
      const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
      const tokenFile = join(tempDir, "api-token");
      writeFileSync(tokenFile, `${VALID_TOKEN}\n`, { mode: 0o600 });
      const installationFile = join(tempDir, "fleet.json");
      writeFileSync(installationFile, "{ not json");
      writeFileSync(filePath, '{"code":"stale","issuedAtIso":"2026-01-01T00:00:00.000Z"}\n');

      const bootstrapped = bootstrapFleetApiFromEnv({
        FLEET_STATE_DIR: tempDir,
        FLEET_API_TOKEN_FILE: tokenFile,
        FLEET_INSTALLATION_FILE: installationFile,
      });

      expect(bootstrapped).toBe(false);
      expect(existsSync(filePath)).toBe(false);
    });

    it("a bootstrap with no state directory touches no code file", () => {
      const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
      writeFileSync(filePath, "kept");
      expect(bootstrapFleetApiFromEnv({ FLEET_STATE_DIR: "   " })).toBe(false);
      expect(bootstrapFleetApiFromEnv({})).toBe(false);
      expect(readFileSync(filePath, "utf8")).toBe("kept");
    });

    it("removeWebLoginCodeFile removes the file and never throws", () => {
      const filePath = join(tempDir, WEB_LOGIN_CODE_FILE);
      writeFileSync(filePath, "x");
      removeWebLoginCodeFile(tempDir);
      expect(existsSync(filePath)).toBe(false);
      expect(() => removeWebLoginCodeFile(tempDir)).not.toThrow();
      expect(() => removeWebLoginCodeFile(join(tempDir, "no", "such", "dir"))).not.toThrow();
      expect(() => removeWebLoginCodeFile("\0bad")).not.toThrow();
    });
  });
});
