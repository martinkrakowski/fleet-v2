// Tests for the @fleet/api Nitro error handler (server/error.ts). Unit cases
// prove the pure errorBody mapping; a loopback h3 app proves the default
// handler on the wire: the response carries only statusCode and statusMessage
// and never echoes the request or the thrown error.
import { createServer, type Server } from "node:http";
import { createApp, createError, createRouter, defineEventHandler, toNodeListener } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The real `nitropack/runtime` entry statically pulls in Nitro build-time
// virtual modules (#nitro-internal-virtual/*) that only exist inside the
// Nitro build, not under plain vitest. The handler's production import stays
// as `nitropack/runtime`; here we substitute the identity wrapper so the unit
// test exercises the real handler without loading the Nitro runtime graph.
vi.mock("nitropack/runtime", () => ({
  defineNitroErrorHandler: (handler: (error: unknown, event: unknown) => unknown) => handler,
}));

import handler, { errorBody } from "../../error.js";

describe("errorBody", () => {
  it("keeps an acceptable 4xx statusMessage verbatim", () => {
    expect(errorBody({ statusCode: 400, statusMessage: "Invalid route parameter" })).toEqual({
      statusCode: 400,
      statusMessage: "Invalid route parameter",
    });
  });

  it("never leaks a plain error's message into a 5xx body", () => {
    const error = new Error("secret path /x?token=abc") as unknown as {
      statusCode?: unknown;
      statusMessage?: unknown;
    };
    const body = errorBody(error);
    expect(body).toEqual({ statusCode: 500, statusMessage: "Internal Server Error" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
  });

  it("answers the fixed 5xx message even when a 5xx carries a custom statusMessage", () => {
    expect(errorBody({ statusCode: 503, statusMessage: "temporarily down" })).toEqual({
      statusCode: 503,
      statusMessage: "Internal Server Error",
    });
  });

  it("falls back to the fixed reason phrase table for 4xx", () => {
    expect(errorBody({ statusCode: 404 })).toEqual({
      statusCode: 404,
      statusMessage: "Not Found",
    });
    expect(errorBody({ statusCode: 418 })).toEqual({
      statusCode: 418,
      statusMessage: "Request Error",
    });
  });

  it("refuses an unsafe statusMessage with the fixed phrase", () => {
    expect(errorBody({ statusCode: 400, statusMessage: "bad\nnewline" })).toEqual({
      statusCode: 400,
      statusMessage: "Bad Request",
    });
    expect(errorBody({ statusCode: 400, statusMessage: "bad\u2028separator" })).toEqual({
      statusCode: 400,
      statusMessage: "Bad Request",
    });
    expect(errorBody({ statusCode: 400, statusMessage: "x".repeat(201) })).toEqual({
      statusCode: 400,
      statusMessage: "Bad Request",
    });
  });

  it("maps non-integer, out-of-range and string status codes to 500", () => {
    expect(errorBody({ statusCode: "400" }).statusCode).toBe(500);
    expect(errorBody({ statusCode: 399 }).statusCode).toBe(500);
    expect(errorBody({ statusCode: 600 }).statusCode).toBe(500);
    expect(errorBody({ statusCode: 400.5 }).statusCode).toBe(500);
    expect(errorBody({ statusCode: undefined }).statusCode).toBe(500);
  });

  it("carries exactly the two allowed keys", () => {
    for (const input of [
      { statusCode: 400, statusMessage: "Invalid route parameter" },
      { statusCode: 500, statusMessage: "Internal Server Error" },
      {},
    ]) {
      expect(Object.keys(errorBody(input)).sort()).toEqual(["statusCode", "statusMessage"]);
    }
  });
});

describe("default handler on a loopback h3 app", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const router = createRouter();
    router.get(
      "/bad-request",
      defineEventHandler(() => {
        throw createError({ statusCode: 400, statusMessage: "Invalid route parameter" });
      }),
    );
    router.get(
      "/echo/:any",
      defineEventHandler(() => {
        throw new Error("secret path /echo/abc?token=xyz");
      }),
    );
    // The third argument is Nitro's fallback default handler; our handler never uses it.
    const app = createApp({ onError: (error, event) => handler(error, event, undefined as never) });
    app.use(router);
    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("answers a thrown 400 with exactly the two fields", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/bad-request`);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.text()).toBe('{"statusCode":400,"statusMessage":"Invalid route parameter"}');
  });

  it("answers a thrown plain Error with 500 and never echoes the request", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/echo/abc?token=xyz`);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("echo");
    expect(text).not.toContain("abc");
    expect(text).not.toContain("token");
  });
});
