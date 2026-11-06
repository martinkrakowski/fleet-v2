// Per-tool rate limiter tests (MX6a; plan §3.7, D13): a token bucket per tool
// name in this MCP process, reads 60 a minute and mutating tools 6 a minute,
// and a call over the limit answers isError with `rate-limited`.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import {
  createToolRateLimiter,
  MUTATING_RATE_PER_MINUTE,
  rateLimitedResult,
  READ_RATE_PER_MINUTE,
} from "./rate-limit.js";
import { buildRegistry, type FleetRegistry } from "./registry.js";

const OK_ENVELOPE: ApiClientResult = {
  operationId: "op-1",
  code: "OK",
  result: { outstanding: [{ id: "wo-1" }] },
};

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
}

function fakeClient(
  responses: Record<string, ApiClientResult>,
): FleetApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const respond = (path: string): ApiClientResult =>
    responses[path] ?? {
      ok: false,
      code: "unmocked-route",
      message: `no canned response for ${path}`,
    };
  return {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return respond(path);
    },
    post: async (path: string, _body: unknown) => {
      calls.push({ method: "POST", path });
      return respond(path);
    },
  };
}

function toolNamed(registry: FleetRegistry, name: string) {
  const tool = registry.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`registry is missing tool ${name}`);
  }
  return tool;
}

describe("per-tool rate limiter (D13)", () => {
  it("a read tool allows 60 calls a minute and refuses the 61st", () => {
    const now = 0;
    const limiter = createToolRateLimiter({ now: () => now });
    for (let i = 0; i < READ_RATE_PER_MINUTE; i += 1) {
      expect(limiter.allow("fleet_attempt", "read")).toBe(true);
    }
    expect(limiter.allow("fleet_attempt", "read")).toBe(false);
  });

  it("a read tool allows one more call after the clock advances a second", () => {
    let now = 0;
    const limiter = createToolRateLimiter({ now: () => now });
    for (let i = 0; i < READ_RATE_PER_MINUTE; i += 1) {
      limiter.allow("fleet_attempt", "read");
    }
    expect(limiter.allow("fleet_attempt", "read")).toBe(false);
    now += 1000;
    expect(limiter.allow("fleet_attempt", "read")).toBe(true);
  });

  it("a mutating tool allows 6 calls a minute and refuses the 7th", () => {
    let now = 0;
    const limiter = createToolRateLimiter({ now: () => now });
    for (let i = 0; i < MUTATING_RATE_PER_MINUTE; i += 1) {
      expect(limiter.allow("fleet_request", "mutating")).toBe(true);
    }
    expect(limiter.allow("fleet_request", "mutating")).toBe(false);
    now += 10_000;
    expect(limiter.allow("fleet_request", "mutating")).toBe(true);
  });

  it("budgets are per tool", () => {
    const now = 0;
    const limiter = createToolRateLimiter({ now: () => now });
    for (let i = 0; i < READ_RATE_PER_MINUTE; i += 1) {
      limiter.allow("fleet_attempt", "read");
    }
    expect(limiter.allow("fleet_attempt", "read")).toBe(false);
    expect(limiter.allow("fleet_other", "read")).toBe(true);
  });

  it("the refusal is an isError result carrying code rate-limited", () => {
    const result = rateLimitedResult("fleet_attempt");
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "rate-limited",
      message: "Tool fleet_attempt is over its rate limit.",
    });
  });

  it("the registry refuses the 61st call of one tool and does not call /v1 again", async () => {
    const client = fakeClient({ "/v1/coordination": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const handler = toolNamed(registry, "fleet_coordination").handler;
    for (let i = 0; i < READ_RATE_PER_MINUTE; i += 1) {
      const result = await handler({});
      expect(result.isError).toBeUndefined();
    }
    const refused = await handler({});
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]?.text ?? "")).toEqual({
      code: "rate-limited",
      message: "Tool fleet_coordination is over its rate limit.",
    });
    expect(client.calls.length).toBe(READ_RATE_PER_MINUTE);
  });

  it("a clock that steps backwards does not re-credit elapsed time", () => {
    let now = 60_000;
    const limiter = createToolRateLimiter({ now: () => now });
    for (let i = 0; i < 6; i += 1) {
      expect(limiter.allow("fleet_request", "mutating")).toBe(true);
    }
    expect(limiter.allow("fleet_request", "mutating")).toBe(false);
    now = 0;
    expect(limiter.allow("fleet_request", "mutating")).toBe(false);
    now = 60_000;
    expect(limiter.allow("fleet_request", "mutating")).toBe(false);
  });

  it("a partial refill is not enough for a call", () => {
    let now = 0;
    const limiter = createToolRateLimiter({ now: () => now });
    for (let i = 0; i < 60; i += 1) {
      limiter.allow("fleet_attempt", "read");
    }
    now = 999;
    expect(limiter.allow("fleet_attempt", "read")).toBe(false);
    now = 1000;
    expect(limiter.allow("fleet_attempt", "read")).toBe(true);
  });
});
