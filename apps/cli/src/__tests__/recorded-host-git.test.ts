// Lane H9b2: readGitHead and the forge push are built from the recorded
// host — the recorded transport decides local versus ssh, and the
// `existsSync(worktreePath)` heuristic is no longer part of that decision
// (it stays behind the legacy branch only).
import { describe, expect, it } from "vitest";

import {
  ExecutorForHost,
  LocalExecutor,
  type AttemptRunnerRecord,
} from "@fleet/work-execution";
import {
  headRouteForExecutor,
  readGitHead,
} from "../composition.js";

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
  "ssh-host": {
    transport: "ssh" as const,
    sshAlias: "lane.example",
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 4001 },
  },
  "local-host": {
    transport: "local" as const,
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 4002 },
  },
  "changed-host": {
    transport: "ssh" as const,
    sshAlias: "lane.example",
    roles: ["lane-runner"],
    runner: { kind: "opencode" as const, port: 9999 },
  },
};

describe("the recorded host decides the git route", () => {
  const helper = new ExecutorForHost({
    hosts,
    legacyExecutor: new LocalExecutor(),
  });

  it("an ssh recorded host routes HEAD reads through its alias", () => {
    const resolved = helper.executorForRecordedHost(
      attemptRunner("ssh-host", "lane.example", 4001),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(headRouteForExecutor(resolved.executor)).toEqual({
      route: "ssh",
      alias: "lane.example",
    });
  });

  it("a local recorded host routes HEAD reads locally and never uses ssh", () => {
    const resolved = helper.executorForRecordedHost(
      attemptRunner("local-host", null, 4002),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(headRouteForExecutor(resolved.executor)).toEqual({
      route: "local",
    });
  });

  it("a changed or removed host refuses, naming the recorded host", () => {
    expect(
      helper.executorForRecordedHost(
        attemptRunner("changed-host", "lane.example", 4001),
      ),
    ).toEqual({
      ok: false,
      reason: "recorded host changed-host changed or was removed",
    });
    expect(
      helper.executorForRecordedHost(attemptRunner("gone", null, 4001)),
    ).toEqual({
      ok: false,
      reason: "recorded host gone changed or was removed",
    });
  });
});

describe("the legacy readGitHead path keeps today's behaviour", () => {
  it("reads HEAD locally for an existing path even with a configured ssh host", async () => {
    // The heuristic stays behind the legacy branch: an existing path reads
    // locally, never through ssh.
    const head = await readGitHead(process.cwd(), "lane.example");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads HEAD locally without any ssh host", async () => {
    const head = await readGitHead(process.cwd());
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });
});
