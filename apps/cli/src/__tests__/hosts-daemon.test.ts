/**
 * `fleet-v2 hosts daemon` (lane CO6): install/show/uninstall the daemon
 * tick's user-scope scheduler units. The scheduler port is faked (no
 * filesystem writes), so these tests assert the command's contract: exit
 * codes (0 ok, 1 missing/unreadable/invalid/v1/daemon-less file or an
 * unreadable unit, 2 usage), the stdout lines and the install-only operator
 * enable/linger hints, and that no path or rendered text crosses output.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type {
  DaemonSchedulerPort,
  DaemonSchedulerReadResult,
  DaemonSchedulerRemoveResult,
  DaemonSchedulerWriteResult,
} from "@fleet/work-execution";

import { hostsCommand } from "../hosts.js";
import { runCli, type CliIo } from "../index.js";

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-hosts-daemon-"));
  createdDirs.push(directory);
  return directory;
}

function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** A loader-valid v2 installation without a daemon section. */
const validV2 = {
  schemaVersion: 2,
  forge: { mode: "none" },
  hosts: {
    lane: {
      transport: "local",
      worktreeRoot: "/srv/fleet/worktrees",
      roles: ["orchestrator", "lane-runner"],
      runner: { kind: "opencode", port: 46000 },
    },
  },
};

const daemon = {
  nodePath: "/srv/fleet/node/bin/node",
  cliPath: "/srv/fleet/cli/fleet-v2.mjs",
  stateDir: "/srv/fleet/state",
  unitDir: "/srv/fleet/units",
  installationFile: "/srv/fleet/fleet.json",
};

interface FakeSchedulerResults {
  readonly read?: DaemonSchedulerReadResult;
  readonly write?: DaemonSchedulerWriteResult;
  readonly remove?: DaemonSchedulerRemoveResult;
}

function fakeScheduler(results: FakeSchedulerResults = {}): {
  scheduler: DaemonSchedulerPort;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    scheduler: {
      async read() {
        calls.push("read");
        return results.read ?? { service: "unchanged", timer: "unchanged" };
      },
      async write() {
        calls.push("write");
        return results.write ?? { service: "written", timer: "written" };
      },
      async remove() {
        calls.push("remove");
        return results.remove ?? { service: "absent", timer: "absent" };
      },
    },
  };
}

async function runDaemon(
  argv: readonly string[],
  installationFile: string,
  results: FakeSchedulerResults = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  calls: string[];
}> {
  const { io, stdout, stderr } = mockIo();
  const { scheduler, calls } = fakeScheduler(results);
  const code = await hostsCommand(["daemon", ...argv], io, {
    installationFile,
    scheduler,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), calls };
}

describe("fleet-v2 hosts daemon", () => {
  it("install without --apply exits 0, prints would-write and the operator lines, and never writes", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["install", "--scheduler", "systemd"],
      file,
      { read: { service: "absent", timer: "absent" } },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-daemon.service would-write\n");
    expect(stdout).toContain("fleet-v2-daemon.timer would-write\n");
    expect(stdout).toContain(
      "enable: systemctl --user enable fleet-v2-daemon.timer\n",
    );
    expect(stdout).toContain("linger: loginctl enable-linger\n");
    expect(calls).toEqual(["read"]);
  });

  it("install --apply calls write once and prints written lines", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["install", "--scheduler=systemd", "--apply"],
      file,
      { write: { service: "written", timer: "written" } },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-daemon.service written\n");
    expect(stdout).toContain("fleet-v2-daemon.timer written\n");
    expect(calls).toEqual(["write"]);
  });

  it("install exits 1 when any unit is unreadable", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
      { write: { service: "unreadable", timer: "written" } },
    );
    expect(code).toBe(1);
  });

  it("--scheduler launchd exits 2 and calls nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, calls } = await runDaemon(
      ["install", "--scheduler", "launchd"],
      file,
    );
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it("show exits 0, prints codes only and no operator lines or rendered text", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["show", "--scheduler", "systemd"],
      file,
      { read: { service: "unchanged", timer: "differs" } },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-daemon.service unchanged\n");
    expect(stdout).toContain("fleet-v2-daemon.timer differs\n");
    expect(stdout).not.toContain("enable:");
    expect(stdout).not.toContain("ExecStart");
    expect(stdout).not.toContain("/srv/fleet/node/bin/node");
    expect(stdout).not.toContain("/srv/fleet/state");
    expect(calls).toEqual(["read"]);
  });

  it("show --apply exits 2", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code } = await runDaemon(
      ["show", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(2);
  });

  it("uninstall without --apply maps a present unit to would-remove", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["uninstall", "--scheduler", "systemd"],
      file,
      { read: { service: "unchanged", timer: "absent" } },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-daemon.service would-remove\n");
    expect(stdout).toContain("fleet-v2-daemon.timer absent\n");
    expect(stdout).not.toContain("enable:");
    expect(calls).toEqual(["read"]);
  });

  it("uninstall --apply calls remove and does not print enable:", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["uninstall", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-daemon.service absent\n");
    expect(stdout).toContain("fleet-v2-daemon.timer absent\n");
    expect(stdout).not.toContain("enable:");
    expect(calls).toEqual(["remove"]);
  });

  it("a v2 file without daemon exits 1 with empty stdout", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, validV2);
    const { code, stdout, stderr } = await runDaemon(
      ["install", "--scheduler", "systemd"],
      file,
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("installation.daemon: absent\n");
  });

  it("a v1 file exits 1 with the schema version refusal", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { schemaVersion: 1, forge: { owner: "o", repo: "r" } });
    const { code, stderr } = await runDaemon(
      ["show", "--scheduler", "systemd"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "installation.daemon: schema version 1 has no daemon section\n",
    );
  });

  it("an absent installation file exits 1 with installation: absent", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const { code, stderr } = await runDaemon(
      ["show", "--scheduler", "systemd"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("installation: absent\n");
  });

  it("hosts --help mentions daemon and systemd", async () => {
    const dir = makeTempDir();
    const { io, stdout } = mockIo();
    const code = await hostsCommand(
      ["--help"],
      io,
      { installationFile: path.join(dir, "fleet.json") },
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("daemon");
    expect(stdout.join("")).toContain("systemd");
  });

  it("global --help lists daemon under hosts", async () => {
    const { io, stdout } = mockIo();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("hosts list|add|edit|remove|rename|daemon");
  });
});
