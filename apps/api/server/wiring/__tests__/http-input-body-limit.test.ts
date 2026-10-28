// Tests for the JSON request-body byte cap in wiring/http-input.ts. A real
// loopback h3 server proves the wire behaviour; unit cases prove the
// before-read refusal and the drained-but-never-buffered refusal.
import "./nitro-globals.js";
import { createServer, ServerResponse, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { createApp, createEvent, createRouter, eventHandler, readBody, toNodeListener } from "h3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_JSON_BODY_BYTES,
  readBoundedRawBody,
  readObjectBody,
} from "../http-input.js";
import { configureFleetApiRuntime } from "../runtime.js";

function exactBody(n: number): string {
  return '{"k":"' + "x".repeat(n - 8) + '"}';
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; port: number }> {
  const server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

function fakeRequest(headers: Record<string, string>, chunks: Buffer[]): IncomingMessage {
  const stream = Readable.from(chunks);
  return Object.assign(stream, {
    method: "POST",
    url: "/x",
    headers,
  }) as unknown as IncomingMessage;
}

async function chunkedPost(
  port: number,
  path: string,
  chunks: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end('"}');
  });
}

describe("readObjectBody JSON body byte cap", () => {
  let server: Server;
  let port: number;
  let reached: boolean;

  beforeEach(async () => {
    configureFleetApiRuntime(null);
    reached = false;
    const app = createApp();
    app.use(
      "/echo",
      eventHandler(async (event) => {
        const body = await readObjectBody(event);
        reached = true;
        return { body };
      }),
    );
    app.use(
      "/twice",
      eventHandler(async (event) => {
        const body = await readObjectBody(event);
        const again = await readBody(event);
        return { body, again };
      }),
    );
    const router = createRouter();
    router.post("/v1/knowledge/checks", (await import("../../routes/v1/knowledge/checks.post.js")).default);
    app.use(router.handler);
    ({ server, port } = await listen(app));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configureFleetApiRuntime(null);
  });

  it("accepts a body exactly at the cap", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: exactBody(MAX_JSON_BODY_BYTES),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { body: { k: string } };
    expect(payload.body.k.length).toBe(MAX_JSON_BODY_BYTES - 8);
  });

  it("refuses one byte over the cap with a fixed 413 and never reaches the handler", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: exactBody(MAX_JSON_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      statusCode: 413,
      statusMessage: "Request body too large",
      stack: [],
    });
    expect(reached).toBe(false);
  });

  it("refuses a chunked body over the cap with no content-length", async () => {
    const prefix = '{"k":"';
    const filler = "x".repeat(MAX_JSON_BODY_BYTES + 1 - prefix.length - 2);
    const status = await chunkedPost(port, "/echo", [
      prefix + filler.slice(0, 16 * 1024 - prefix.length),
      filler.slice(16 * 1024 - prefix.length),
    ]);
    expect(status).toBe(413);
    expect(reached).toBe(false);
  });

  it("accepts a chunked body within the cap", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: "/echo", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write('{"k":"');
      req.end('v"}');
    });
    expect(status).toBe(200);
  });

  it("refuses a declared content-length over the cap before reading a byte", async () => {
    const fake = fakeRequest(
      { "content-type": "application/json", "content-length": String(MAX_JSON_BODY_BYTES + 1) },
      [Buffer.from("{}")],
    );
    const event = createEvent(fake, new ServerResponse(fake));
    await expect(readObjectBody(event)).rejects.toMatchObject({ statusCode: 413 });
    expect(fake.readableFlowing).toBeNull();
  });

  it("refuses an understated content-length once the received bytes pass the cap", async () => {
    const big = Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x78);
    const fake = fakeRequest(
      { "content-type": "application/json", "content-length": "2" },
      [big.subarray(0, 32 * 1024), big.subarray(32 * 1024)],
    );
    const event = createEvent(fake, new ServerResponse(fake));
    await expect(readObjectBody(event)).rejects.toMatchObject({ statusCode: 413 });
  });

  it("readBoundedRawBody honours a smaller limit exactly", async () => {
    const over = fakeRequest(
      { "content-type": "application/json", "content-length": "20" },
      [Buffer.alloc(20, 0x78)],
    );
    await expect(readBoundedRawBody(createEvent(over, new ServerResponse(over)), 16)).rejects.toMatchObject({
      statusCode: 413,
    });
    const exact = fakeRequest(
      { "content-type": "application/json", "content-length": "16" },
      [Buffer.alloc(16, 0x78)],
    );
    const bytes = await readBoundedRawBody(createEvent(exact, new ServerResponse(exact)), 16);
    expect(bytes?.byteLength).toBe(16);
  });

  it("keeps every existing behaviour unchanged", async () => {
    const post = async (body?: string) =>
      fetch(`http://127.0.0.1:${port}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });
    const payloadOf = async (response: Response) => (await response.json()) as { body: unknown };

    const absent = await post();
    expect(absent.status).toBe(200);
    expect((await payloadOf(absent)).body).toEqual({});

    const array = await post("[1,2]");
    expect(array.status).toBe(400);
    expect(await array.text()).toContain("Invalid JSON object body");

    const text = await post('"text"');
    expect(text.status).toBe(400);

    const invalid = await post("{");
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toContain("Invalid JSON body");
    expect(invalidText).not.toContain("Invalid JSON object body");

    const nowIso = await post('{"nowIso":"2026-01-01T00:00:00Z","key":"value"}');
    expect(nowIso.status).toBe(200);
    expect((await payloadOf(nowIso)).body).toEqual({ key: "value" });

    const get = await fetch(`http://127.0.0.1:${port}/echo`);
    expect(get.status).toBe(200);
    expect((await payloadOf(get)).body).toEqual({});
  });

  it("hands the bounded bytes to h3's cache so a second read parses the same body", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/twice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"k":"v"}',
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { body: { k: string }; again: { k: string } };
    expect(payload.body).toEqual({ k: "v" });
    expect(payload.again).toEqual({ k: "v" });
  });

  it("caps a real /v1 route: unconfigured runtime 501 on an empty body, 413 over the cap", async () => {
    const empty = await fetch(`http://127.0.0.1:${port}/v1/knowledge/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(empty.status).toBe(501);

    const over = await fetch(`http://127.0.0.1:${port}/v1/knowledge/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: exactBody(MAX_JSON_BODY_BYTES + 1),
    });
    expect(over.status).toBe(413);
  });
});
