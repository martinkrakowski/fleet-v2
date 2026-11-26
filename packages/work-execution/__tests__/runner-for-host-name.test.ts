// MR1A: runnerForHostName resolves and caches the per-host runner for a
// current installation host by name alone, from that host's OWN declared
// port, auth file and capabilities, with every refusal naming the cause and
// never falling back to another host, port, auth file or capability profile.
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  RunnerIsolationCapabilities,
  RunnerSessionRef,
  RunnerSessionStatus,
  StartRunnerSessionRequest,
  StartRunnerSessionResult,
  StopRunnerSessionResult,
} from "../src/application/ports/out/ExecutionRunnerPort.out-port.js";
import type { SubprocessResult, SubprocessRunner } from "../src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.js";
import type { RunnerForHostNamePort } from "../src/application/ports/out/RunnerForAttemptPort.out-port.js";
import { RunnerForAttemptAdapter } from "../src/infrastructure/adapters/RunnerForAttemptAdapter.adapter.js";

/** A runner-b-shaped declared capability profile (distinct from runner-a's). */
const runnerBCapabilities = {
  filesystemScope: "inherited-directory",
  networkEgressRestricted: false,
  cpuAndMemoryLimited: false,
  processTreeTermination: true,
} as const;

/** runner-a's own declared profile. */
const runnerACapabilities = {
  filesystemScope: "scoped-worktree",
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
} as const;

/** The seven-key override runnerForHostName builds for runner-b. */
const expectedRunnerBOverride: RunnerIsolationCapabilities = {
  ...runnerBCapabilities,
  source: "declared",
  authoritativeCompletion: true,
  artifactPersistence: true,
};

interface RecordedSubprocessCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
}

/** A runSubprocess spy that records every call and reports a started session. */
function spyRunner(): {
  readonly runner: SubprocessRunner;
  readonly calls: RecordedSubprocessCall[];
} {
  const calls: RecordedSubprocessCall[] = [];
  const runner: SubprocessRunner = async (command, args, env) => {
    calls.push({ command, args: [...args], env });
    const result: SubprocessResult = {
      exitCode: 0,
      stdout: '{"sessionID":"ses_1"}',
      stderr: "",
    };
    return result;
  };
  return { runner, calls };
}

function hostSpec(overrides?: {
  readonly transport?: "local" | "ssh";
  readonly sshAlias?: string;
  readonly roles?: readonly string[];
  readonly kind?: string;
  readonly port?: number;
  readonly authFile?: string;
  readonly capabilities?: unknown;
}): Record<string, unknown> {
  return {
    transport: "ssh",
    sshAlias: "b.example",
    roles: ["lane-runner"],
    runner: {
      kind: "opencode",
      port: 4266,
      authFile: "/auth/b",
      capabilities: runnerBCapabilities,
      ...(overrides?.kind !== undefined ? { kind: overrides.kind } : {}),
      ...(overrides?.port !== undefined ? { port: overrides.port } : {}),
      ...(overrides?.authFile !== undefined
        ? { authFile: overrides.authFile }
        : {}),
      ...(overrides?.capabilities !== undefined
        ? { capabilities: overrides.capabilities }
        : {}),
    },
    ...overrides,
  };
}

/** The neutral installation hosts: two ssh lane-runner hosts, nothing real. */
function baseHosts(): Record<string, unknown> {
  return {
    "runner-a": {
      transport: "ssh",
      sshAlias: "a.example",
      roles: ["lane-runner"],
      runner: {
        kind: "opencode",
        port: 4166,
        authFile: "/auth/a",
        capabilities: runnerACapabilities,
      },
    },
    "runner-b": hostSpec(),
  };
}

/** All runner-a routing values that must never appear on a runner-b dispatch. */
function expectNoRunnerAValues(calls: readonly RecordedSubprocessCall[]): void {
  for (const call of calls) {
    const env = call.env ?? {};
    expect(env.OCM_REMOTE_PORT).not.toBe("4166");
    expect(env.OCM_HOST).not.toBe("a.example");
    expect(env.OPENCODE_AUTH_FILE).not.toBe("/auth/a");
  }
}

async function startOnB(runnerB: {
  startSession(request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult>;
}): Promise<StartRunnerSessionResult> {
  return runnerB.startSession({
    attemptId: "a1",
    worktreePath: "/tmp/wt-a1",
    briefPackagePath: "/tmp/brief-a1",
    baseCommit: "b".repeat(40),
    stepLimit: 10,
    timeLimitSeconds: 60,
    model: "m",
    requiredCapabilities: expectedRunnerBOverride,
  });
}

describe("RunnerForAttemptAdapter.runnerForHostName", () => {
  it("resolves runner-b and dispatches on its own port, host and auth file", async () => {
    const { runner: runSubprocess, calls } = spyRunner();
    const adapter = new RunnerForAttemptAdapter({
      hosts: baseHosts() as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
      runSubprocess,
    });

    const result = adapter.runnerForHostName("runner-b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const started = await startOnB(result.runner);
    expect(started.outcome).toBe("started");
    expect(calls.length).toBe(1);
    expect(calls[0]!.env).toMatchObject({
      OCM_REMOTE_PORT: "4266",
      OCM_HOST: "b.example",
      OPENCODE_AUTH_FILE: "/auth/b",
    });
    expectNoRunnerAValues(calls);
  });

  it("stopSession on the resolved runner-b runner uses runner-b's routing", async () => {
    const { runner: runSubprocess, calls } = spyRunner();
    const adapter = new RunnerForAttemptAdapter({
      hosts: baseHosts() as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
      runSubprocess,
    });

    const result = adapter.runnerForHostName("runner-b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stopped = await result.runner.stopSession({
      attemptId: "a1",
      sessionId: "ses_1",
      gracePeriodSeconds: 0,
      worktreePath: "/tmp/wt-a1",
      runner: {
        kind: "opencode",
        remotePort: 4266,
        host: "b.example",
        hostName: "runner-b",
        agent: null,
        model: "m",
        variant: null,
      },
    });
    expect(stopped.outcome).toBe("terminated");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual(["--abort", "--dir", "/tmp/wt-a1"]);
    expect(calls[0]!.env).toEqual({
      OCM_REMOTE_PORT: "4266",
      OCM_HOST: "b.example",
      OPENCODE_AUTH_FILE: "/auth/b",
    });
    expectNoRunnerAValues(calls);
  });

  it("caches runner-b in its own map: two calls return the identical runner", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: baseHosts() as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    const first = adapter.runnerForHostName("runner-b");
    const second = adapter.runnerForHostName("runner-b");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.runner).toBe(first.runner);
  });

  it("does not share the cache with runnerForAttempt and uses the host's own capabilities", () => {
    const runnerACaps: RunnerIsolationCapabilities = {
      ...runnerACapabilities,
      source: "declared",
      authoritativeCompletion: true,
      artifactPersistence: true,
    };
    const hosts = baseHosts() as never;
    const adapter = new RunnerForAttemptAdapter({
      hosts,
      legacyRunner: {
        describeCapabilities: () => runnerACaps,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
      // The shared options carry runner-a's capabilities; runner-b must
      // never inherit them.
      capabilities: runnerACaps,
    });
    // Build runnerForAttempt's runner for the same host name first.
    const viaAttempt = adapter.runnerForAttempt({
      runner: {
        kind: "opencode",
        remotePort: 4266,
        host: "b.example",
        hostName: "runner-b",
        agent: null,
        model: "m",
        variant: null,
      },
    });
    expect(viaAttempt.ok).toBe(true);

    const viaName = adapter.runnerForHostName("runner-b");
    expect(viaName.ok).toBe(true);
    if (!viaName.ok || !viaAttempt.ok) return;
    expect(viaName.runner).not.toBe(viaAttempt.runner);
    expect(viaName.runner.describeCapabilities()).toEqual(
      expectedRunnerBOverride,
    );
  });

  it("leaves runner-a's routing unchanged before and after resolving runner-b", async () => {
    const { runner: runSubprocess, calls } = spyRunner();
    const hosts = baseHosts() as never;
    const adapter = new RunnerForAttemptAdapter({
      hosts,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
      runSubprocess,
    });

    // Dispatch on runner-a through the recorded-host path first.
    const runnerA = adapter.runnerForAttempt({
      runner: {
        kind: "opencode",
        remotePort: 4166,
        host: "a.example",
        hostName: "runner-a",
        agent: null,
        model: "m",
        variant: null,
      },
    });
    expect(runnerA.ok).toBe(true);
    if (!runnerA.ok) return;
    const startedA = await runnerA.runner.startSession({
      attemptId: "a2",
      worktreePath: "/tmp/wt-a2",
      briefPackagePath: "/tmp/brief-a2",
      baseCommit: "b".repeat(40),
      stepLimit: 10,
      timeLimitSeconds: 60,
      model: "m",
      requiredCapabilities: runnerACapsForRequired(),
    });
    expect(startedA.outcome).toBe("started");
    const callsBefore = calls.map((call) => call.env);
    expect(callsBefore).toEqual([
      {
        OCM_REMOTE_PORT: "4166",
        OCM_HOST: "a.example",
        OPENCODE_AUTH_FILE: "/auth/a",
        OCM_START_MAX: "60",
      },
    ]);

    // Resolve and dispatch runner-b by name.
    const runnerB = adapter.runnerForHostName("runner-b");
    expect(runnerB.ok).toBe(true);
    if (!runnerB.ok) return;
    await startOnB(runnerB.runner);

    // runner-a's single recorded call is unchanged, and no later call reused it.
    expect(calls[0]!.env).toEqual({
      OCM_REMOTE_PORT: "4166",
      OCM_HOST: "a.example",
      OPENCODE_AUTH_FILE: "/auth/a",
      OCM_START_MAX: "60",
    });
    expect(calls.length).toBe(2);
    expectNoRunnerAValues([calls[1]!]);
  });

  it("refuses invalid, non-string, null, and prototype-polluting host names", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: baseHosts() as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    const bad: unknown[] = [
      null,
      undefined,
      4166,
      true,
      {},
      "",
      "   ",
      "-bad",
      "../bad",
      "a..b",
      "x".repeat(129),
      "__proto__",
      "constructor",
      "prototype",
      "hasOwnProperty",
    ];
    for (const name of bad) {
      const result = adapter.runnerForHostName(name as string);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/invalid host name/i);
      }
    }
    // Nothing was built and nothing leaked from the hosts record.
    expect(adapter.runnerForHostName("runner-b").ok).toBe(true);
  });

  it("refuses a host name not present in installation hosts", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: baseHosts() as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(adapter.runnerForHostName("runner-zzz")).toEqual({
      ok: false,
      reason: "host runner-zzz is not present in installation hosts",
    });
    // No hosts option at all.
    const bare = new RunnerForAttemptAdapter({
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(bare.runnerForHostName("runner-b").ok).toBe(false);
    // Non-record hosts values.
    for (const hosts of [null, "nope", [{}]]) {
      const odd = new RunnerForAttemptAdapter({
        ...(hosts !== null ? { hosts: hosts as never } : {}),
        legacyRunner: {
          describeCapabilities: () => expectedRunnerBOverride,
          async startSession() {
            return { outcome: "refused", reason: "legacy stub" };
          },
          async inspectSession(): Promise<RunnerSessionStatus> {
            throw new Error("legacy stub");
          },
          async stopSession(): Promise<StopRunnerSessionResult> {
            return { outcome: "refused", reason: "legacy stub" };
          },
        },
      });
      expect(odd.runnerForHostName("runner-b").ok).toBe(false);
    }
  });

  it("refuses a hosts map, host spec, or runner block with a throwing getter or Proxy without invoking it", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: baseHosts() as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });

    let invoked = false;
    const throwingGetter = (): never => {
      invoked = true;
      throw new Error("getter must never run");
    };

    // A throwing getter on roles.
    const specWithThrowingRoles = {
      get roles(): string[] {
        return throwingGetter();
      },
      runner: { kind: "opencode", port: 4266, authFile: "/auth/b" },
    };
    const withRoles = new RunnerForAttemptAdapter({
      hosts: { "runner-b": specWithThrowingRoles } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(withRoles.runnerForHostName("runner-b").ok).toBe(false);
    expect(invoked).toBe(false);

    // A Proxy as the host spec.
    const proxySpec = new Proxy(
      { roles: ["lane-runner"], runner: { kind: "opencode", port: 4266, authFile: "/auth/b", capabilities: runnerBCapabilities } },
      {},
    );
    const withProxySpec = new RunnerForAttemptAdapter({
      hosts: { "runner-b": proxySpec } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(withProxySpec.runnerForHostName("runner-b").ok).toBe(false);

    // A Proxy as the runner block.
    const proxyRunner = new Proxy(
      { kind: "opencode", port: 4266, authFile: "/auth/b", capabilities: runnerBCapabilities },
      {},
    );
    const withProxyRunner = new RunnerForAttemptAdapter({
      hosts: { "runner-b": { roles: ["lane-runner"], runner: proxyRunner } } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(withProxyRunner.runnerForHostName("runner-b").ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it("refuses a host without the lane-runner role (including non-array, sparse array, and array-like roles)", () => {
    const make = (roles: unknown): RunnerForAttemptAdapter =>
      new RunnerForAttemptAdapter({
        hosts: { "runner-b": { ...hostSpec(), roles } } as never,
        legacyRunner: {
          describeCapabilities: () => expectedRunnerBOverride,
          async startSession() {
            return { outcome: "refused", reason: "legacy stub" };
          },
          async inspectSession(): Promise<RunnerSessionStatus> {
            throw new Error("legacy stub");
          },
          async stopSession(): Promise<StopRunnerSessionResult> {
            return { outcome: "refused", reason: "legacy stub" };
          },
        },
      });
    for (const roles of [
      undefined,
      null,
      "lane-runner",
      { length: 1, 0: "lane-runner" },
      ["verifier"],
      (() => {
        const sparse: string[] = new Array(2);
        sparse[0] = "lane-runner"; // index 1 is a real hole
        return sparse;
      })(),
    ]) {
      const result = make(roles).runnerForHostName("runner-b");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/lane-runner/);
      }
    }
  });

  it("refuses a host of kind agy", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: { "runner-b": hostSpec({ kind: "agy" }) } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    const result = adapter.runnerForHostName("runner-b");
    expect(result).toEqual({
      ok: false,
      reason: "host runner-b runner kind agy has no adapter",
    });
    // Any other non-opencode kind too.
    const other = new RunnerForAttemptAdapter({
      hosts: { "runner-b": hostSpec({ kind: "future-kind" }) } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(other.runnerForHostName("runner-b").ok).toBe(false);
  });

  it("refuses a host whose runner.port is absent without falling back", () => {
    for (const port of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, 65536, 4266.5, "4266"]) {
      const spec = hostSpec();
      (spec.runner as Record<string, unknown>).port = port;
      const adapter = new RunnerForAttemptAdapter({
        hosts: { "runner-b": spec } as never,
        legacyRunner: {
          describeCapabilities: () => expectedRunnerBOverride,
          async startSession() {
            return { outcome: "refused", reason: "legacy stub" };
          },
          async inspectSession(): Promise<RunnerSessionStatus> {
            throw new Error("legacy stub");
          },
          async stopSession(): Promise<StopRunnerSessionResult> {
            return { outcome: "refused", reason: "legacy stub" };
          },
        },
      });
      const result = adapter.runnerForHostName("runner-b");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("runner.port");
      }
    }
  });

  it("refuses a host without its own authFile", () => {
    for (const authFile of [undefined, null, 4266, {}, "   "]) {
      const spec = hostSpec();
      (spec.runner as Record<string, unknown>).authFile = authFile;
      const adapter = new RunnerForAttemptAdapter({
        hosts: { "runner-b": spec } as never,
        legacyRunner: {
          describeCapabilities: () => expectedRunnerBOverride,
          async startSession() {
            return { outcome: "refused", reason: "legacy stub" };
          },
          async inspectSession(): Promise<RunnerSessionStatus> {
            throw new Error("legacy stub");
          },
          async stopSession(): Promise<StopRunnerSessionResult> {
            return { outcome: "refused", reason: "legacy stub" };
          },
        },
      });
      const result = adapter.runnerForHostName("runner-b");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("authFile");
      }
    }
  });

  it("refuses a host without its own capabilities declaration", () => {
    for (const capabilities of [
      undefined,
      null,
      "scoped-worktree",
      [runnerBCapabilities],
      { ...runnerBCapabilities, filesystemScope: "unknown" },
      { ...runnerBCapabilities, filesystemScope: 1 },
      { ...runnerBCapabilities, networkEgressRestricted: "no" },
      { ...runnerBCapabilities, source: "undeclared" },
      { ...runnerBCapabilities, source: "legacy-asserted" },
    ]) {
      // Even with options.capabilities set, no inheritance happens.
      const spec = hostSpec();
      const runnerBlock = spec.runner as Record<string, unknown>;
      if (capabilities === undefined) delete runnerBlock.capabilities;
      else runnerBlock.capabilities = capabilities;
      const adapter = new RunnerForAttemptAdapter({
        hosts: { "runner-b": spec } as never,
        legacyRunner: {
          describeCapabilities: () => expectedRunnerBOverride,
          async startSession() {
            return { outcome: "refused", reason: "legacy stub" };
          },
          async inspectSession(): Promise<RunnerSessionStatus> {
            throw new Error("legacy stub");
          },
          async stopSession(): Promise<StopRunnerSessionResult> {
            return { outcome: "refused", reason: "legacy stub" };
          },
        },
        capabilities: {
          ...runnerACapabilities,
          source: "declared",
          authoritativeCompletion: true,
          artifactPersistence: true,
        },
      });
      const result = adapter.runnerForHostName("runner-b");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("capabilities");
      }
    }
  });

  it("refuses an ssh host without an sshAlias", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: {
        "runner-b": { ...hostSpec(), sshAlias: undefined },
      } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    const result = adapter.runnerForHostName("runner-b");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sshAlias");
    }
    // A blank alias is equally refused.
    const blank = new RunnerForAttemptAdapter({
      hosts: { "runner-b": { ...hostSpec(), sshAlias: "  " } } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(blank.runnerForHostName("runner-b").ok).toBe(false);
  });

  it("refuses an invalid transport value", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: { "runner-b": { ...hostSpec(), transport: "carrier-pigeon" } } as never,
      legacyRunner: {
        describeCapabilities: () => expectedRunnerBOverride,
        async startSession() {
          return { outcome: "refused", reason: "legacy stub" };
        },
        async inspectSession(): Promise<RunnerSessionStatus> {
          throw new Error("legacy stub");
        },
        async stopSession(): Promise<StopRunnerSessionResult> {
          return { outcome: "refused", reason: "legacy stub" };
        },
      },
    });
    expect(adapter.runnerForHostName("runner-b").ok).toBe(false);
  });
});

describe("RunnerForHostNamePort", () => {
  it("is an application port the adapter satisfies, so callers need not import the adapter", () => {
    expectTypeOf<RunnerForAttemptAdapter>().toMatchTypeOf<RunnerForHostNamePort>();
    const port: RunnerForHostNamePort = new RunnerForAttemptAdapter({ hosts: {} });
    expect(port.runnerForHostName("runner-b").ok).toBe(false);
  });
});

/** runner-a's capability profile as a dispatch requirement. */
function runnerACapsForRequired(): RunnerIsolationCapabilities {
  return {
    ...runnerACapabilities,
    source: "declared",
    authoritativeCompletion: true,
    artifactPersistence: true,
  };
}

// A type-only reference so the RunnerSessionRef import stays used if the
// suite grows session-inspection cases.
export type { RunnerSessionRef };
