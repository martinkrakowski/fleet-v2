/**
 * Unit tests for the `/live/changes` GET route (VB03).
 *
 * The route's only collaborators — the web client token reader and the
 * change relay — are mocked; every test drives `GET()` against a fixed
 * environment and asserts the exact response contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateChangeRelay, mockReadWebClientApiToken } = vi.hoisted(() => ({
  mockCreateChangeRelay: vi.fn(),
  mockReadWebClientApiToken: vi.fn(),
}));

vi.mock("../../../lib/live/changes-relay", () => ({
  createChangeRelay: mockCreateChangeRelay,
}));

vi.mock("../../../lib/api-client", () => ({
  readWebClientApiToken: mockReadWebClientApiToken,
}));

const { GET } = await import("./route");

const UNCONFIGURED_REASON = { reason: "api boundary is not configured" };

describe("GET /live/changes", () => {
  let originalFleetApiUrl: string | undefined;
  let originalNextPublicFleetApiUrl: string | undefined;

  beforeEach(() => {
    originalFleetApiUrl = process.env.FLEET_API_URL;
    originalNextPublicFleetApiUrl = process.env.NEXT_PUBLIC_FLEET_API_URL;
    delete process.env.FLEET_API_URL;
    delete process.env.NEXT_PUBLIC_FLEET_API_URL;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalFleetApiUrl === undefined) {
      delete process.env.FLEET_API_URL;
    } else {
      process.env.FLEET_API_URL = originalFleetApiUrl;
    }
    if (originalNextPublicFleetApiUrl === undefined) {
      delete process.env.NEXT_PUBLIC_FLEET_API_URL;
    } else {
      process.env.NEXT_PUBLIC_FLEET_API_URL = originalNextPublicFleetApiUrl;
    }
    vi.clearAllMocks();
  });

  it("returns 503 with unconfigured reason and does not call createChangeRelay when neither env var is set", async () => {
    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual(UNCONFIGURED_REASON);
    expect(mockCreateChangeRelay).not.toHaveBeenCalled();
  });

  it("returns 503 with unconfigured reason when FLEET_API_URL is whitespace-only", async () => {
    process.env.FLEET_API_URL = "   ";

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual(UNCONFIGURED_REASON);
    expect(mockCreateChangeRelay).not.toHaveBeenCalled();
  });

  it("prefers FLEET_API_URL over NEXT_PUBLIC_FLEET_API_URL, trims it, and passes null token through", async () => {
    process.env.FLEET_API_URL = "  http://env-api-1  ";
    process.env.NEXT_PUBLIC_FLEET_API_URL = "http://env-api-2";
    mockReadWebClientApiToken.mockReturnValue(null);
    mockCreateChangeRelay.mockResolvedValue({ status: "unavailable", reason: "down" });

    await GET();

    expect(mockCreateChangeRelay).toHaveBeenCalledTimes(1);
    expect(mockCreateChangeRelay).toHaveBeenCalledWith({
      url: "http://env-api-1",
      token: null,
    });
  });

  it("falls back to trimmed NEXT_PUBLIC_FLEET_API_URL and passes string token through", async () => {
    process.env.NEXT_PUBLIC_FLEET_API_URL = "  http://env-api-2  ";
    mockReadWebClientApiToken.mockReturnValue("test-token-value");
    mockCreateChangeRelay.mockResolvedValue({ status: "unavailable", reason: "down" });

    await GET();

    expect(mockCreateChangeRelay).toHaveBeenCalledTimes(1);
    expect(mockCreateChangeRelay).toHaveBeenCalledWith({
      url: "http://env-api-2",
      token: "test-token-value",
    });
  });

  it("returns 503 with verbatim relay reason and no-store json headers when relay is unavailable", async () => {
    process.env.FLEET_API_URL = "http://env-api-1";
    mockReadWebClientApiToken.mockReturnValue("test-token-value");
    mockCreateChangeRelay.mockResolvedValue({
      status: "unavailable",
      reason: "the api boundary answered 502 for /v1/changes",
    });

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      reason: "the api boundary answered 502 for /v1/changes",
    });
  });

  it("returns 200 SSE stream with required headers and forwards relay body when streaming", async () => {
    process.env.FLEET_API_URL = "http://env-api-1";
    mockReadWebClientApiToken.mockReturnValue("test-token-value");
    const frame = 'event: change\ndata: {"seq":1,"kind":"attempt","id":null}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    mockCreateChangeRelay.mockResolvedValue({ status: "streaming", body: stream });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.body).not.toBeNull();
    const chunk = await res.body!.getReader().read();
    expect(chunk.done).toBe(false);
    expect(new TextDecoder().decode(chunk.value)).toBe(frame);
  });
});
