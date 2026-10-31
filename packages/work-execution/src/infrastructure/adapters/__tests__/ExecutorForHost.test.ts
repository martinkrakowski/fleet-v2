// ExecutorForHost: the executor (and the confirmed hostSpec) the recorded
// host resolves to, built once per host and cached. The gate predicate reads
// `hostSpec.runner.gateSlot` off the result on every evaluation, so the spec
// must come back on the cached path too, not only the cold one.

import { describe, expect, it } from "vitest";

import type {
  CommandExecutorPort,
  CommandRunResult,
} from "../../../application/ports/out/CommandExecutorPort.out-port.js";
import type { AttemptRunnerRecord } from "../../../domain/execution-records.js";
import type { RunnerForAttemptHostSpec } from "../ConfirmRecordedHost.js";
import { ExecutorForHost } from "../ExecutorForHost.helper.js";

class RecordingExecutor implements CommandExecutorPort {
  async run(): Promise<CommandRunResult> {
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  }
}

const HOSTS: Record<string, RunnerForAttemptHostSpec> = {
  lanehost: {
    transport: "local",
    roles: ["lane-runner"],
    runner: {
      kind: "opencode",
      port: 46000,
      gateSlot: { path: "/usr/local/bin/gate-slot", slots: 8 },
    },
  },
};

const LEGACY_EXECUTOR = new RecordingExecutor();

function recordedRunner(): AttemptRunnerRecord {
  return {
    kind: "opencode",
    remotePort: 46000,
    host: null,
    hostName: "lanehost",
    agent: null,
    model: "example-provider/example-model",
    variant: null,
  };
}

describe("ExecutorForHost", () => {
  it("returns the confirmed hostSpec on the cold path", () => {
    const forHost = new ExecutorForHost({
      hosts: HOSTS,
      legacyExecutor: LEGACY_EXECUTOR,
    });
    const result = forHost.executorForRecordedHost(recordedRunner());
    expect(result).toMatchObject({
      ok: true,
      hostSpec: {
        transport: "local",
        roles: ["lane-runner"],
        runner: {
          kind: "opencode",
          port: 46000,
          gateSlot: { path: "/usr/local/bin/gate-slot", slots: 8 },
        },
      },
    });
  });

  it("returns the confirmed hostSpec on the cached path too", () => {
    const forHost = new ExecutorForHost({
      hosts: HOSTS,
      legacyExecutor: LEGACY_EXECUTOR,
    });
    const first = forHost.executorForRecordedHost(recordedRunner());
    expect(first.ok).toBe(true);
    const second = forHost.executorForRecordedHost(recordedRunner());
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    // The executor is the cached one; the spec comes back with it.
    expect(second.executor).toBe(first.executor);
    expect(second.hostSpec).toEqual(first.hostSpec);
    expect(second.hostSpec?.runner?.gateSlot).toEqual({
      path: "/usr/local/bin/gate-slot",
      slots: 8,
    });
  });

  it("carries no hostSpec for a legacy record", () => {
    const forHost = new ExecutorForHost({
      hosts: HOSTS,
      legacyExecutor: LEGACY_EXECUTOR,
    });
    const result = forHost.executorForRecordedHost(null);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.hostSpec).toBeUndefined();
    }
  });
});
