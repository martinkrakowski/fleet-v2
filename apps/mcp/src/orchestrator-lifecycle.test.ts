// Orchestrator lifecycle tests (O4-1): argv parsing, registration body,
// heartbeat cadence and overlap guard, and idempotent retirement. The client
// is a fake; no network and no environment variable is read anywhere here.
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_KINDS,
  HEARTBEAT_INTERVAL_MS,
  REQUEST_KINDS,
  attachProcessLifecycleHooks,
  createOrchestratorLifecycle,
  parseOrchestratorCliArgs,
  type OrchestratorLifecycle,
} from "./orchestrator-lifecycle.js";
import type { ApiClientResult, FleetApiClient } from "./client.js";

const REGISTER_PATH = "/v1/orchestrators";

function envelope(result: unknown): ApiClientResult {
  return { operationId: "op-1", code: "OK", result: result as object };
}

function errorEnvelope(code: string): ApiClientResult {
  return { ok: false, code, message: `api said ${code}` };
}

interface FakeCall {
  path: string;
  body: unknown;
}

/**
 * A FleetApiClient that records every call and answers from `routes`: the
 * first matching path predicate wins; a deferred lets a test hold a response
 * open to exercise the in-flight heartbeat guard.
 */
function fakeClient(
  routes: Array<{
    match: (path: string) => boolean;
    reply: (call: FakeCall) => Promise<ApiClientResult> | ApiClientResult;
  }>,
): { client: FleetApiClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    client: {
      get: () => Promise.resolve(errorEnvelope("unused")),
      post: (path: string, body: unknown) => {
        const call: FakeCall = { path, body };
        calls.push(call);
        const route = routes.find((entry: { match: (path: string) => boolean }) =>
          entry.match(path),
        );
        if (!route) {
          return Promise.resolve(errorEnvelope("UNROUTED"));
        }
        return Promise.resolve(route.reply(call));
      },
    },
  };
}

const baseConfig = {
  cliKind: "opencode" as const,
  model: "test-model",
  host: "test-host",
  projects: ["proj-a"],
  claims: ["request-review" as const],
};

describe("parseOrchestratorCliArgs", () => {
  it("parses every flag", () => {
    const parsed = parseOrchestratorCliArgs([
      "--kind",
      "agy",
      "--model",
      "m1",
      "--host",
      "h1",
      "--project",
      "p1",
      "--project",
      "p2",
      "--claim",
      "prepare-fix",
      "--claim",
      "request-review",
    ]);
    expect(parsed).toEqual({
      ok: true,
      config: {
        cliKind: "agy",
        model: "m1",
        host: "h1",
        projects: ["p1", "p2"],
        claims: ["prepare-fix", "request-review"],
      },
    });
  });

  it("defaults to other, null model, os.hostname(), empty arrays", () => {
    const parsed = parseOrchestratorCliArgs([]);
    expect(parsed).toEqual({
      ok: true,
      config: {
        cliKind: "other",
        model: null,
        host: hostname(),
        projects: [],
        claims: [],
      },
    });
  });

  it("refuses an unknown --kind", () => {
    const parsed = parseOrchestratorCliArgs(["--kind", "not-a-cli"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("--kind");
    }
  });

  it("accepts every listed CLI kind", () => {
    for (const kind of CLI_KINDS) {
      expect(parseOrchestratorCliArgs(["--kind", kind])).toEqual({
        ok: true,
        config: expect.objectContaining({ cliKind: kind }),
      });
    }
  });

  it("refuses an unknown --claim", () => {
    const parsed = parseOrchestratorCliArgs(["--claim", "not-a-kind"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("--claim");
    }
  });

  it("accepts every listed request kind as a claim", () => {
    const argv: string[] = [];
    for (const kind of REQUEST_KINDS) {
      argv.push("--claim", kind);
    }
    const parsed = parseOrchestratorCliArgs(argv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.claims).toEqual([...REQUEST_KINDS]);
    }
  });

  it("refuses an unknown flag", () => {
    const parsed = parseOrchestratorCliArgs(["--wat", "x"]);
    expect(parsed.ok).toBe(false);
  });

  it("refuses a trailing flag with no value", () => {
    const parsed = parseOrchestratorCliArgs(["--kind"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("missing value");
    }
  });

  it("refuses a flag followed by another flag instead of a value", () => {
    const parsed = parseOrchestratorCliArgs(["--kind", "--model"]);
    expect(parsed.ok).toBe(false);
  });

  it("refuses more than 64 --project entries", () => {
    const argv: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      argv.push("--project", `p${index}`);
    }
    const parsed = parseOrchestratorCliArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("64");
    }
  });

  it("accepts exactly 64 --project entries", () => {
    const argv: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      argv.push("--project", `p${index}`);
    }
    const parsed = parseOrchestratorCliArgs(argv);
    expect(parsed.ok).toBe(true);
  });
});

interface Route {
  match: (path: string) => boolean;
  reply: (call: FakeCall) => ApiClientResult | Promise<ApiClientResult>;
}

function defaultRoutes(overrides?: {
  register?:
    | ApiClientResult
    | ((call: FakeCall) => ApiClientResult | Promise<ApiClientResult>);
  heartbeat?: ApiClientResult | (() => ApiClientResult);
  retire?: ApiClientResult | (() => ApiClientResult);
}): Route[] {
  return [
    {
      match: (path) => path === REGISTER_PATH,
      reply: (call) =>
        overrides?.register !== undefined
          ? typeof overrides.register === "function"
            ? (overrides.register as (c: FakeCall) => ApiClientResult | Promise<ApiClientResult>)(call)
            : overrides.register
          : envelope({
              outcome: "registered",
              session: { orchestratorId: (call.body as { orchestratorId: string }).orchestratorId },
            }),
    },
    {
      match: (path) => path.endsWith("/heartbeat"),
      reply: () =>
        overrides?.heartbeat !== undefined
          ? typeof overrides.heartbeat === "function"
            ? overrides.heartbeat()
            : overrides.heartbeat
          : envelope({ outcome: "renewed" }),
    },
    {
      match: (path) => path.endsWith("/retire"),
      reply: () =>
        overrides?.retire !== undefined
          ? typeof overrides.retire === "function"
            ? overrides.retire()
            : overrides.retire
          : envelope({ outcome: "retired" }),
    },
  ];
}

function makeLifecycle(
  routes: Parameters<typeof defaultRoutes>[0],
  options?: { orchestratorId?: string },
): {
  lifecycle: OrchestratorLifecycle;
  calls: FakeCall[];
  tick: () => Promise<void>;
} {
  const fake = fakeClient(defaultRoutes(routes));
  const lifecycle = createOrchestratorLifecycle({
    client: fake.client,
    config: baseConfig,
    ...(options?.orchestratorId ? { orchestratorId: options.orchestratorId } : {}),
  });
  return {
    lifecycle,
    calls: fake.calls,
    tick: () => lifecycle.heartbeatTick().then(() => undefined),
  };
}

describe("createOrchestratorLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates an mcp- id when none is provided", () => {
    const { lifecycle } = makeLifecycle({});
    expect(lifecycle.orchestratorId).toMatch(/^mcp-/);
  });

  it("registers with the exact closed 6-key body and starts the 30 s timer", async () => {
    const { lifecycle, calls } = makeLifecycle({
      register: (call) => {
        expect(Object.keys(call.body as object).sort()).toEqual([
          "claims",
          "cliKind",
          "host",
          "model",
          "orchestratorId",
          "projects",
        ]);
        return envelope({ outcome: "registered" });
      },
    }, { orchestratorId: "mcp-fixed" });
    const result = await lifecycle.start();
    expect(result).toEqual({ status: "registered" });
    expect(calls).toEqual([
      {
        path: "/v1/orchestrators",
        body: {
          orchestratorId: "mcp-fixed",
          cliKind: "opencode",
          model: "test-model",
          host: "test-host",
          projects: ["proj-a"],
          claims: ["request-review"],
        },
      },
    ]);
    // The timer is running: one tick sends one heartbeat.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/orchestrators",
      "/v1/orchestrators/mcp-fixed/heartbeat",
    ]);
  });

  it("does not heartbeat before registration", async () => {
    const { lifecycle, calls } = makeLifecycle({});
    // Unregistered: a manual tick is skipped and sends nothing.
    const result = await lifecycle.heartbeatTick();
    expect(result).toEqual({ status: "skipped", reason: "session-not-active" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(calls).toEqual([]);
  });

  it("heartbeats on every 30 s tick and retires on stop", async () => {
    const { lifecycle, calls } = makeLifecycle({}, { orchestratorId: "mcp-x" });
    await lifecycle.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(
      calls.filter((call) => call.path.endsWith("/heartbeat")),
    ).toHaveLength(3);
    await lifecycle.stop();
    expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(1);
    // After stop the timer is cleared: no further heartbeats.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(
      calls.filter((call) => call.path.endsWith("/heartbeat")),
    ).toHaveLength(3);
  });

  it("skips an overlapping heartbeat while one is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeClient([
      {
        match: (path) => path === REGISTER_PATH,
        reply: () => envelope({ outcome: "registered" }),
      },
      {
        match: (path) => path.endsWith("/heartbeat"),
        reply: () => gate.then(() => envelope({ outcome: "renewed" })),
      },
      {
        match: (path) => path.endsWith("/retire"),
        reply: () => envelope({ outcome: "retired" }),
      },
    ]);
    const lifecycle = createOrchestratorLifecycle({
      client: fake.client,
      config: baseConfig,
      orchestratorId: "mcp-slow",
    });
    await lifecycle.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    // First heartbeat is pending (gated). Advance past two more ticks.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.calls.filter((call) => call.path.endsWith("/heartbeat")),
    ).toHaveLength(1);
  });

  it("marks the session inactive when heartbeat is not-found, not-owner or refused", async () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "REFUSED"]) {
      const { lifecycle, calls } = makeLifecycle(
        { heartbeat: errorEnvelope(code) },
        { orchestratorId: "mcp-gone" },
      );
      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      expect(calls.filter((call) => call.path.endsWith("/heartbeat"))).toHaveLength(1);
      // Timer cleared and inactive: no further heartbeats and no retire call.
      await lifecycle.stop();
      expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(0);
      expect(
        calls.filter((call) => call.path.endsWith("/heartbeat")),
      ).toHaveLength(1);
    }
  });

  it("keeps the timer on heartbeat transport-error and timeout", async () => {
    for (const code of ["transport-error", "timeout"]) {
      const { lifecycle, calls } = makeLifecycle(
        { heartbeat: errorEnvelope(code) },
        { orchestratorId: "mcp-flaky" },
      );
      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
      expect(
        calls.filter((call) => call.path.endsWith("/heartbeat")),
      ).toHaveLength(2);
      await lifecycle.stop();
      expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(1);
    }
  });

  it("retires at most once across repeated stop() calls", async () => {
    const { lifecycle, calls } = makeLifecycle({}, { orchestratorId: "mcp-once" });
    await lifecycle.start();
    await Promise.all([lifecycle.stop(), lifecycle.stop(), lifecycle.stop()]);
    await lifecycle.stop();
    expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(1);
  });

  it("retires a session whose registration settles after stop() was called", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { lifecycle, calls } = makeLifecycle({
      register: () => gate.then(() => envelope({ outcome: "registered" })),
    }, { orchestratorId: "mcp-late" });
    const started = lifecycle.start();
    // Shutdown fires while registration is still pending.
    const stopped = lifecycle.stop();
    release();
    await Promise.all([started, stopped]);
    const retireCalls = calls.filter((call) => call.path.endsWith("/retire"));
    expect(retireCalls).toHaveLength(1);
    // No heartbeat ever ran for a session retired at birth.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(calls.filter((call) => call.path.endsWith("/heartbeat"))).toHaveLength(0);
    await lifecycle.stop();
    expect(retireCalls).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(1);
  });

  it("retires when stop() precedes start() and registration later succeeds", async () => {
    const { lifecycle, calls } = makeLifecycle(
      {},
      { orchestratorId: "mcp-prestop" },
    );
    const stopped = lifecycle.stop();
    const started = lifecycle.start();
    await Promise.all([started, stopped]);
    expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls.filter((call) => call.path.endsWith("/heartbeat"))).toHaveLength(0);
  });

  it("never sends retire when registration was skipped (not-configured)", async () => {
    const { lifecycle, calls } = makeLifecycle(
      { register: errorEnvelope("not-configured") },
      { orchestratorId: "mcp-skip" },
    );
    const result = await lifecycle.start();
    expect(result).toEqual({ status: "skipped", reason: "not-configured" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(calls).toHaveLength(1);
    await lifecycle.stop();
    expect(calls).toHaveLength(1);
  });

  it("reports refused registration and never heartbeats or retires", async () => {
    for (const code of ["REFUSED", "FORBIDDEN"]) {
      const { lifecycle, calls } = makeLifecycle(
        { register: errorEnvelope(code) },
        { orchestratorId: "mcp-refused" },
      );
      const result = await lifecycle.start();
      expect(result.status).toBe("refused");
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
      expect(calls).toHaveLength(1);
      await lifecycle.stop();
      expect(calls).toHaveLength(1);
    }
  });

  it("reports failed registration on transport-error and timeout", async () => {
    for (const code of ["transport-error", "timeout"]) {
      const { lifecycle, calls } = makeLifecycle(
        { register: errorEnvelope(code) },
        { orchestratorId: "mcp-failed" },
      );
      const result = await lifecycle.start();
      expect(result.status).toBe("failed");
      await lifecycle.stop();
      expect(calls).toHaveLength(1);
    }
  });

  it("treats unexpected registration response shapes as failed", async () => {
    for (const register of [
      { operationId: "op", code: "OK", result: null },
      envelope({ something: "else" }),
      envelope({ outcome: "refused" }),
    ]) {
      const { lifecycle, calls } = makeLifecycle(
        { register: register as ApiClientResult },
        { orchestratorId: "mcp-shape" },
      );
      const result = await lifecycle.start();
      expect(result).toEqual({
        status: "failed",
        reason: "unexpected registration response",
      });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      expect(calls).toHaveLength(1);
      await lifecycle.stop();
      expect(calls).toHaveLength(1);
    }
  });

  it("never throws from stop() even when retire fails", async () => {
    const { lifecycle } = makeLifecycle(
      { retire: errorEnvelope("transport-error") },
      { orchestratorId: "mcp-throw" },
    );
    await lifecycle.start();
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });
});

describe("attachProcessLifecycleHooks", () => {
  function fakeProc() {
    const listeners = new Map<string, Set<() => void>>();
    const proc = {
      once: (event: string, listener: () => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return proc;
      },
      removeListener: (event: string, listener: () => void) => {
        listeners.get(event)?.delete(listener);
        return proc;
      },
      emit(event: string): void {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          listener();
        }
      },
      stdin: {
        once: (event: string, listener: () => void) => {
          const set = listeners.get(`stdin:${event}`) ?? new Set();
          set.add(listener);
          listeners.set(`stdin:${event}`, set);
        },
        removeListener: (event: string, listener: () => void) => {
          listeners.get(`stdin:${event}`)?.delete(listener);
        },
        emit(event: string): void {
          for (const listener of [...(listeners.get(`stdin:${event}`) ?? [])]) {
            listener();
          }
        },
      },
    };
    return proc;
  }

  it("retires exactly once when SIGTERM, SIGINT and stdin close all fire", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, calls } = makeLifecycle({}, { orchestratorId: "mcp-hooks" });
      await lifecycle.start();
      const proc = fakeProc();
      const hooks = attachProcessLifecycleHooks(lifecycle, proc);
      proc.emit("SIGTERM");
      proc.emit("SIGINT");
      proc.stdin.emit("close");
      proc.stdin.emit("end");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(1);
      hooks.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detach() removes every hook so nothing fires afterwards", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, calls } = makeLifecycle({}, { orchestratorId: "mcp-detach" });
      await lifecycle.start();
      const proc = fakeProc();
      const hooks = attachProcessLifecycleHooks(lifecycle, proc);
      hooks.detach();
      proc.emit("SIGTERM");
      proc.stdin.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter((call) => call.path.endsWith("/retire"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
