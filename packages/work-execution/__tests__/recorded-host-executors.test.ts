// Lane H9b2: workspace and artifact reads, and the executor helper, act
// through the attempt's recorded host; legacy records keep today's single
// worktree executor.
import { describe, expect, it } from "vitest";

import type {
  AttemptRecord,
  AttemptRunnerRecord,
} from "../src/domain/execution-records.js";
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from "../src/application/ports/out/CommandExecutorPort.out-port.js";
import { ExecutorForHost } from "../src/infrastructure/adapters/ExecutorForHost.helper.js";
import { LocalExecutor } from "../src/infrastructure/adapters/LocalExecutor.adapter.js";
import { SshExecutor } from "../src/infrastructure/adapters/SshExecutor.adapter.js";
import { WorkspaceAdapter } from "../src/infrastructure/adapters/WorkspaceAdapter.adapter.js";
import { AttemptArtifactAdapter } from "../src/infrastructure/adapters/AttemptArtifactAdapter.adapter.js";
import { CollectAttemptArtifactsUseCase } from "../src/application/use-cases/CollectAttemptArtifactsUseCase.use-case.js";

function attemptRunner(
  hostName: string | null,
  host: string | null,
  remotePort: number | null,
): AttemptRunnerRecord {
  return {
    kind: "opencode",
    remotePort,
    host,
    ...(hostName !== null ? { hostName } : {}),
    agent: null,
    model: "m",
    variant: null,
  };
}

const hosts = {
  "host-a": {
    transport: "ssh" as const,
    sshAlias: "a.example",
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 4001 },
  },
  "host-b": {
    transport: "ssh" as const,
    sshAlias: "b.example",
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 4002 },
  },
  "local-b": {
    transport: "local" as const,
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 4003 },
  },
  "changed-host": {
    transport: "ssh" as const,
    sshAlias: "b.example",
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 9999 },
  },
  "re-aliased": {
    transport: "ssh" as const,
    sshAlias: "moved.example",
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 4002 },
  },
  "no-role": {
    transport: "ssh" as const,
    sshAlias: "b.example",
    roles: ["verifier"],
    runner: { kind: "opencode" as const, port: 4002 },
  },
};

/** An executor stub that records the argv it was asked to run. */
function recordingExecutor(alias: string | null): CommandExecutorPort & {
  readonly sshHost: string | null;
  calls: string[][];
} {
  return {
    sshHost: alias,
    calls: [],
    async run(
      argv: readonly string[],
      _options?: CommandRunOptions,
    ): Promise<CommandRunResult> {
      this.calls.push([...argv]);
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    },
  };
}

describe("ExecutorForHost", () => {
  const legacyExecutor = recordingExecutor(null);
  const helper = new ExecutorForHost({ hosts, legacyExecutor });

  it("returns the legacy executor for a legacy record", () => {
    for (const recorded of [
      null,
      undefined,
      attemptRunner(null, "a.example", 4001),
    ]) {
      const result = helper.executorForRecordedHost(recorded);
      expect(result).toEqual({ ok: true, executor: legacyExecutor });
    }
  });

  it("builds an SshExecutor with the recorded host's alias for an ssh host", () => {
    const result = helper.executorForRecordedHost(
      attemptRunner("host-a", "a.example", 4001),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executor).toBeInstanceOf(SshExecutor);
    expect((result.executor as SshExecutor).sshHost).toBe("a.example");
    // Same host resolves to the same cached executor.
    const again = helper.executorForRecordedHost(
      attemptRunner("host-a", "a.example", 4001),
    );
    expect(again.ok && again.executor === result.executor).toBe(true);
  });

  it("builds a LocalExecutor for a local recorded host", () => {
    const result = helper.executorForRecordedHost(
      attemptRunner("local-b", null, 4003),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executor).toBeInstanceOf(LocalExecutor);
  });

  it("refuses a changed port, a changed alias, a changed transport, a removed role and a removed host, naming the host", () => {
    const cases: Array<[AttemptRunnerRecord, string]> = [
      [attemptRunner("changed-host", "b.example", 4002), "changed-host"],
      [attemptRunner("re-aliased", "b.example", 4002), "re-aliased"],
      [attemptRunner("no-role", "b.example", 4002), "no-role"],
      [attemptRunner("gone", null, 4002), "gone"],
    ];
    for (const [recorded, name] of cases) {
      const result = helper.executorForRecordedHost(recorded);
      expect(result).toEqual({
        ok: false,
        reason: `recorded host ${name} changed or was removed`,
      });
    }
    // A recorded ssh alias over a host that is now local: the transport
    // changed (the recorded alias no longer matches a null current alias).
    const localNow = new ExecutorForHost({
      hosts: {
        "was-ssh": { transport: "local" as const, roles: ["lane-runner"] },
      },
      legacyExecutor,
    });
    expect(
      localNow.executorForRecordedHost(
        attemptRunner("was-ssh", "b.example", 4002),
      ),
    ).toEqual({
      ok: false,
      reason: "recorded host was-ssh changed or was removed",
    });
  });
});

describe("H9b2 reads through the recorded host's executor", () => {
  const legacyExecutor = recordingExecutor(null);
  const helper = new ExecutorForHost({ hosts, legacyExecutor });
  const recordedB = attemptRunner("host-b", "b.example", 4002);

  function adapterOptions() {
    return {
      executor: legacyExecutor,
      executorForRecordedHost: (
        recorded: AttemptRunnerRecord | null | undefined,
      ) => helper.executorForRecordedHost(recorded),
    };
  }

  it("the workspace inspection of an attempt recorded on B goes to B's executor (alias b.example)", async () => {
    const resolved = helper.executorForRecordedHost(recordedB);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const hostExecutor = resolved.executor as SshExecutor;
    expect(hostExecutor.sshHost).toBe("b.example");
    const calls: string[][] = [];
    hostExecutor.run = async (argv: readonly string[]) => {
      calls.push([...argv]);
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    };

    const workspace = new WorkspaceAdapter(adapterOptions());
    const inspection = await workspace.inspectWorktree({
      worktreePath: "/wt-b",
      baseCommit: "b".repeat(40),
      expectedArtifactPaths: [".lane/notes.md"],
      recordedHost: recordedB,
    });
    expect(inspection.worktreePath).toBe("/wt-b");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].slice(0, 3)).toEqual(["git", "-C", "/wt-b"]);

    // A legacy record keeps the legacy executor: none of B's calls grow.
    const legacyCallsBefore = legacyExecutor.calls.length;
    await workspace.inspectWorktree({
      worktreePath: "/wt-legacy",
      baseCommit: "b".repeat(40),
      expectedArtifactPaths: [],
      recordedHost: attemptRunner(null, "old-alias", 4001),
    });
    expect(legacyExecutor.calls.length).toBeGreaterThan(legacyCallsBefore);
    expect(legacyExecutor.calls[legacyCallsBefore].slice(0, 3)).toEqual([
      "git",
      "-C",
      "/wt-legacy",
    ]);
  });

  it("the artifact read of an attempt recorded on B goes to B's executor (alias b.example)", async () => {
    const resolved = helper.executorForRecordedHost(recordedB);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const hostExecutor = resolved.executor as SshExecutor;
    const calls: string[][] = [];
    hostExecutor.run = async (argv: readonly string[]) => {
      calls.push([...argv]);
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    };

    const artifactPort = new AttemptArtifactAdapter(adapterOptions());
    const result = await artifactPort.collectCompletedAttemptArtifacts({
      attemptId: "a1",
      worktreePath: "/wt-b",
      baseCommit: "b".repeat(40),
      expectedArtifactPaths: [],
      completionReceipt: {
        attemptId: "a1",
        sessionId: "ses_x",
        endedAtIso: "2026-10-16T01:00:00Z",
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
      recordedHost: recordedB,
    });
    expect(result.outcome).toBe("collected");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].slice(0, 3)).toEqual(["git", "-C", "/wt-b"]);
  });

  it("collect passes the attempt's recorded host through to the artifact read", async () => {
    let seenRecordedHost: AttemptRunnerRecord | null | undefined;
    const seen: Array<{ key: string }> = [];
    const artifactPort = {
      async collectCompletedAttemptArtifacts(request: {
        recordedHost?: AttemptRunnerRecord | null;
      }) {
        seenRecordedHost = request.recordedHost;
        seen.push({ key: "collect" });
        return {
          outcome: "collected" as const,
          artifacts: {
            headCommit: "c".repeat(40),
            commitsSinceBase: [],
            collectedArtifactPaths: [],
            notes: "missing" as const,
          },
        };
      },
    };
    const attempt: AttemptRecord = {
      id: "a1",
      workOrderId: "w1",
      kind: "initial",
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: "/wt-b",
      baseCommit: "b".repeat(40),
      state: "ended",
      outcome: null,
      briefDigest: null,
      briefPackagePath: null,
      sessionId: "ses_x",
      completionReceipt: null,
      artifacts: null,
      runner: recordedB,
      createdAtIso: "2026-10-16T00:00:00Z",
      updatedAtIso: "2026-10-16T00:00:00Z",
    };
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: {
        async findAttemptById(id: string) {
          return id === attempt.id ? attempt : null;
        },
        async saveAttempt() {},
      } as never,
      journal: {
        async listJournalEntriesForAttempt() {
          return [];
        },
        async appendJournalEntry(entry: unknown) {
          return entry;
        },
        async releaseCapacityReservation() {
          return false;
        },
      } as never,
      artifactPort: artifactPort as never,
    });
    const result = await useCase.collectAttemptArtifacts({
      attemptId: "a1",
      completionReceipt: {
        attemptId: "a1",
        sessionId: "ses_x",
        endedAtIso: "2026-10-16T01:00:00Z",
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
    });
    expect(result.outcome).toBe("collected");
    expect(seen).toHaveLength(1);
    expect(seenRecordedHost).toEqual(recordedB);
  });

  it("a changed host refuses the read, naming the recorded host", async () => {
    const workspace = new WorkspaceAdapter(adapterOptions());
    await expect(
      workspace.inspectWorktree({
        worktreePath: "/wt",
        baseCommit: "b".repeat(40),
        expectedArtifactPaths: [],
        recordedHost: attemptRunner("changed-host", "b.example", 4002),
      }),
    ).rejects.toThrow("recorded host changed-host changed or was removed");
  });
});
