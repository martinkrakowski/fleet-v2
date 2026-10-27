import { beforeEach, describe, expect, it } from "vitest";
import {
  createEndpointReader,
  type EndpointReaderSettings,
} from "./transport";

const BASE_URL = "http://localhost:3001";

let requestedUrls: string[];
let requestedInits: RequestInit[];

function stubFetch(reply: () => Promise<Response>): typeof fetch {
  return async (input, init) => {
    requestedUrls.push(String(input));
    requestedInits.push(init ?? {});
    return reply();
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readerWith(overrides: Partial<EndpointReaderSettings> = {}) {
  const settings: EndpointReaderSettings = {
    baseUrl: BASE_URL,
    fetchImpl: stubFetch(() =>
      Promise.resolve(jsonResponse(200, { ok: true })),
    ),
    timeoutMs: 5000,
    token: "x".repeat(40),
    ...overrides,
  };
  return createEndpointReader(settings);
}

describe("createEndpointReader", () => {
  beforeEach(() => {
    requestedUrls = [];
    requestedInits = [];
  });

  it("falls back without requesting when baseUrl is empty", async () => {
    const read = readerWith({ baseUrl: "" });

    const result = await read("/v1/projects", { id: "fixture" });

    expect(result).toEqual({
      source: "fixture-fallback",
      status: null,
      data: { id: "fixture" },
      fallbackReason: "api boundary is not configured",
    });
    expect(requestedUrls).toEqual([]);
  });

  it("sends the bearer token when one is configured", async () => {
    const token = "x".repeat(40);
    const read = readerWith({ token });

    await read("/v1/projects", {});

    expect(requestedInits[0]?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
    });
  });

  it("omits the authorization header when no token is configured", async () => {
    const read = readerWith({ token: null });

    await read("/v1/projects", {});

    expect(requestedInits[0]?.headers).not.toHaveProperty("authorization");
  });

  it("resolves a 200 JSON body as the live result", async () => {
    const body = { count: 2, items: [{ id: "p1" }] };
    const read = createEndpointReader({
      baseUrl: BASE_URL,
      fetchImpl: stubFetch(() => Promise.resolve(jsonResponse(200, body))),
      timeoutMs: 5000,
      token: null,
    });

    const result = await read("/v1/projects", []);

    expect(result).toEqual({
      source: "api",
      status: 200,
      data: body,
      fallbackReason: null,
    });
  });

  it("requests every read with cache 'no-store'", async () => {
    const read = readerWith();

    await read("/v1/projects", {});

    expect(requestedInits[0]?.cache).toBe("no-store");
  });
});
