// Orchestrator session lifecycle for the MCP stdio server (O4-1): register at
// startup, heartbeat every 30 s, retire on shutdown. A `/v1` client only — the
// CLI kinds and request kinds are copied from
// packages/operator-coordination/src/domain/orchestrator-session-records.ts
// because apps/mcp never imports that package. Every failure path returns a
// typed result; the MCP server keeps serving tools and resources regardless.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ApiClientResult, FleetApiClient } from "./client.js";

/** The agent CLI the orchestrator runs in (ORCHESTRATOR_CLI_KINDS). */
export const CLI_KINDS = [
  "claude-code",
  "agy",
  "opencode",
  "codex",
  "conductor",
  "other",
] as const;
export type CliKind = (typeof CLI_KINDS)[number];

/** Web request kinds a session may claim (ORCHESTRATOR_REQUEST_KINDS). */
export const REQUEST_KINDS = [
  "dispatch-attempt",
  "start-lane-run",
  "prepare-fix",
  "request-review",
  "resume-run",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Heartbeat every 30 s; the API lease is 90 s. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

const MAX_PROJECTS = 64;

export interface OrchestratorLifecycleConfig {
  readonly cliKind: CliKind;
  readonly model: string | null;
  readonly host: string;
  readonly projects: readonly string[];
  readonly claims: readonly RequestKind[];
}

export type ParseOrchestratorCliArgsResult =
  | { readonly ok: true; readonly config: OrchestratorLifecycleConfig }
  | { readonly ok: false; readonly error: string };

const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--kind",
  "--model",
  "--host",
  "--project",
  "--claim",
]);

/**
 * Parse the orchestrator CLI identity flags. No `process.env` read here:
 * identity comes only from `argv`, so the strict env scanner never sees a new
 * variable. Unknown flags, missing values, an unknown `--kind` or `--claim`,
 * and more than 64 `--project` entries are refused as `{ ok: false, error }`.
 */
export function parseOrchestratorCliArgs(
  argv: readonly string[],
): ParseOrchestratorCliArgsResult {
  let cliKind: CliKind | null = null;
  let model: string | null = null;
  let host: string | null = null;
  const projects: string[] = [];
  const claims: RequestKind[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS_WITH_VALUE.has(flag)) {
      return { ok: false, error: `unknown flag: ${String(flag)}` };
    }
    const value = argv[index + 1];
    if (value === undefined || FLAGS_WITH_VALUE.has(value)) {
      return { ok: false, error: `missing value for ${flag}` };
    }
    index += 1;
    switch (flag) {
      case "--kind":
        if (!CLI_KINDS.includes(value as CliKind)) {
          return {
            ok: false,
            error: `unknown --kind: must be one of ${CLI_KINDS.join(", ")}`,
          };
        }
        cliKind = value as CliKind;
        break;
      case "--model":
        model = value;
        break;
      case "--host":
        host = value;
        break;
      case "--project":
        projects.push(value);
        if (projects.length > MAX_PROJECTS) {
          return {
            ok: false,
            error: `too many --project entries: at most ${MAX_PROJECTS} are allowed`,
          };
        }
        break;
      case "--claim":
        if (!REQUEST_KINDS.includes(value as RequestKind)) {
          return {
            ok: false,
            error: `unknown --claim: must be one of ${REQUEST_KINDS.join(", ")}`,
          };
        }
        claims.push(value as RequestKind);
        break;
    }
  }

  return {
    ok: true,
    config: {
      cliKind: cliKind ?? "other",
      model,
      host: host ?? hostname(),
      projects,
      claims,
    },
  };
}

export type StartLifecycleResult =
  | { readonly status: "registered" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export type HeartbeatTickResult =
  | { readonly status: "renewed" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "inactive"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export interface LifecycleTimer {
  readonly unref?: () => void;
}

export type SetIntervalFn = (
  handler: () => void,
  timeoutMs: number,
) => LifecycleTimer;
export type ClearIntervalFn = (timer: LifecycleTimer) => void;

export interface OrchestratorLifecycleDependencies {
  readonly client: FleetApiClient;
  readonly config: OrchestratorLifecycleConfig;
  readonly orchestratorId?: string;
  readonly setIntervalFn?: SetIntervalFn;
  readonly clearIntervalFn?: ClearIntervalFn;
}

export interface OrchestratorLifecycle {
  readonly orchestratorId: string;
  start(): Promise<StartLifecycleResult>;
  heartbeatTick(): Promise<HeartbeatTickResult>;
  stop(): Promise<void>;
}

const REGISTER_PATH = "/v1/orchestrators";

function envelopeOutcome(result: ApiClientResult): string | null {
  if (!("result" in result) || result.result === null) {
    return null;
  }
  const outcome = (result.result as { outcome?: unknown }).outcome;
  return typeof outcome === "string" ? outcome : null;
}

const INACTIVE_ENVELOPE_CODES: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "REFUSED",
]);

/**
 * Build the lifecycle carrier. `start()` registers the session with the exact
 * closed six-key body; a registered session heartbeats every 30 s with an
 * in-flight guard so slow responses never stack; `stop()` retires at most
 * once and never throws. Nothing here keeps the process alive: the timer is
 * unref'd when the runtime supports it.
 */
export function createOrchestratorLifecycle(
  deps: OrchestratorLifecycleDependencies,
): OrchestratorLifecycle {
  const orchestratorId = deps.orchestratorId ?? `mcp-${randomUUID()}`;
  const setIntervalFn: SetIntervalFn =
    deps.setIntervalFn ??
    ((handler, timeoutMs) => {
      const timer = setInterval(handler, timeoutMs);
      return timer;
    });
  const clearIntervalFn: ClearIntervalFn =
    deps.clearIntervalFn ??
    ((timer) => {
      clearInterval(timer as ReturnType<typeof setInterval>);
    });

  let registered = false;
  let retired = false;
  let stopRequested = false;
  let timer: LifecycleTimer | null = null;
  let inFlight = false;
  let registerPromise: Promise<StartLifecycleResult> | null = null;
  let stopPromise: Promise<void> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function retireOnce(): Promise<void> {
    if (retired || !registered) {
      // Not registered (yet): nothing to retire. If registration is still
      // pending, the `stopRequested` branch in register() retires it when it
      // settles, so no session is left unretired.
      return Promise.resolve();
    }
    retired = true;
    return deps.client
      .post(`/v1/orchestrators/${encodeURIComponent(orchestratorId)}/retire`, {})
      .then(
        () => undefined,
        () => undefined,
      );
  }

  async function register(): Promise<StartLifecycleResult> {
    // The registration body is closed: exactly these six keys, never scopes,
    // status or times.
    let response: ApiClientResult;
    try {
      response = await deps.client.post(REGISTER_PATH, {
        orchestratorId,
        cliKind: deps.config.cliKind,
        model: deps.config.model,
        host: deps.config.host,
        projects: [...deps.config.projects],
        claims: [...deps.config.claims],
      });
    } catch (error) {
      // A thrown or rejected client.post() must never reject start(): the
      // stdio server stays up and serving regardless of registration.
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : "registration threw",
      };
    }
    if (!("result" in response)) {
      const code = response.code;
      if (code === "not-configured") {
        return { status: "skipped", reason: "not-configured" };
      }
      if (code === "REFUSED" || code === "FORBIDDEN") {
        return { status: "refused", reason: response.message };
      }
      return { status: "failed", reason: response.message };
    }
    if (response.result !== null && envelopeOutcome(response) === "registered") {
      registered = true;
      if (stopRequested) {
        // Shutdown fired while registration was still pending: the session
        // exists server-side, so retire it instead of starting a heartbeat.
        void retireOnce();
        return { status: "registered" };
      }
      timer = setIntervalFn(() => {
        void heartbeatTick();
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
      return { status: "registered" };
    }
    return { status: "failed", reason: "unexpected registration response" };
  }

  async function heartbeatTick(): Promise<HeartbeatTickResult> {
    if (inFlight) {
      return { status: "skipped", reason: "heartbeat-already-in-flight" };
    }
    if (!registered || retired) {
      return { status: "skipped", reason: "session-not-active" };
    }
    inFlight = true;
    try {
      const response = await deps.client.post(
        `/v1/orchestrators/${encodeURIComponent(orchestratorId)}/heartbeat`,
        {},
      );
      const outcome = envelopeOutcome(response);
      if ("result" in response && outcome === "renewed") {
        return { status: "renewed" };
      }
      if (!("result" in response)) {
        if (INACTIVE_ENVELOPE_CODES.has(response.code)) {
          clearTimer();
          registered = false;
          return { status: "inactive", reason: response.code };
        }
        // transport-error, timeout: keep the timer for the next 30 s tick.
        return { status: "failed", reason: response.message };
      }
      // Unexpected shape: not renewed. Treat like a refusal so a retired or
      // foreign session never keeps beating.
      clearTimer();
      registered = false;
      return { status: "inactive", reason: "unexpected-heartbeat-response" };
    } catch {
      // Never let the timer produce an unhandled rejection.
      return { status: "failed", reason: "heartbeat-threw" };
    } finally {
      inFlight = false;
    }
  }

  function doStop(): Promise<void> {
    stopRequested = true;
    clearTimer();
    if (registerPromise === null) {
      return retireOnce();
    }
    // Registration is still pending: wait for it to settle so a session that
    // registers after shutdown began is still retired exactly once.
    return registerPromise.then(
      () => retireOnce(),
      () => retireOnce(),
    );
  }

  return {
    orchestratorId,
    start(): Promise<StartLifecycleResult> {
      if (registerPromise === null) {
        registerPromise = register();
      }
      return registerPromise;
    },
    heartbeatTick,
    stop(): Promise<void> {
      if (stopPromise === null) {
        stopPromise = doStop().catch(() => undefined);
      }
      return stopPromise;
    },
  };
}

/**
 * Wire SIGTERM, SIGINT and stdin close/end to `lifecycle.stop()`. Idempotent:
 * several signals firing together still retire at most once. Returns a
 * `detach()` so tests can unhook everything cleanly.
 */
export function attachProcessLifecycleHooks(
  lifecycle: OrchestratorLifecycle,
  proc: {
    once: (event: string, listener: () => void) => unknown;
    removeListener: (event: string, listener: () => void) => unknown;
    stdin?: { once: (event: string, listener: () => void) => unknown; removeListener: (event: string, listener: () => void) => unknown };
  } = process,
): { detach: () => void } {
  const listeners: Array<[string, () => void]> = [];
  const stop = (): void => {
    void lifecycle.stop();
  };
  for (const event of ["SIGTERM", "SIGINT"]) {
    proc.once(event, stop);
    listeners.push([event, stop]);
  }
  const stdin = proc.stdin;
  if (stdin) {
    for (const event of ["close", "end"]) {
      stdin.once(event, stop);
      listeners.push([event, stop]);
    }
  }
  return {
    detach(): void {
      for (const [event, listener] of listeners) {
        if (event === "close" || event === "end") {
          stdin?.removeListener(event, listener);
        } else {
          proc.removeListener(event, listener);
        }
      }
    },
  };
}
