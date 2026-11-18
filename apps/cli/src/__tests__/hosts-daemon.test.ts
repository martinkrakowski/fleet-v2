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
  inputs: Array<Record<string, unknown>>;
} {
  const calls: string[] = [];
  const inputs: Array<Record<string, unknown>> = [];
  // OD7a1: the fake echoes the main-pair codes into the intake pair whenever
  // the rendered input carries it, so a shadow-on command reports 4 units.
  return {
    calls,
    inputs,
    scheduler: {
      async read(input) {
        calls.push('read');
        inputs.push({ ...input });
        const base = results.read ?? { service: "unchanged", timer: "unchanged" };
        return input.shadowIntake === undefined
          ? base
          : {
              ...base,
              shadowIntake: {
                service: base.service,
                timer: base.timer,
              },
            };
      },
      async write(input) {
        calls.push("write");
        inputs.push({ ...input });
        const base = results.write ?? { service: "written", timer: "written" };
        return input.shadowIntake === undefined
          ? base
          : {
              ...base,
              shadowIntake: {
                service: base.service,
                timer: base.timer,
              },
            };
      },
      async remove() {
        calls.push("remove");
        // OD7a1 fix round 2: a provided remove result passes through whole,
        // including its intake codes, so a test can drive an unreadable
        // intake removal; the default still reports the intake pair absent.
        return results.remove ?? {
          service: "absent",
          timer: "absent",
          shadowIntake: { service: "absent", timer: "absent" },
        };
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
  inputs: Array<Record<string, unknown>>;
}> {
  const { io, stdout, stderr } = mockIo();
  const { scheduler, calls, inputs } = fakeScheduler(results);
  const code = await hostsCommand(["daemon", ...argv], io, {
    installationFile,
    scheduler,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), calls, inputs };
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

  it("uninstall without --apply maps a present unit to would-remove and prints exactly two lines", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["uninstall", "--scheduler", "systemd"],
      file,
      { read: { service: "unchanged", timer: "absent" } },
    );
    expect(code).toBe(0);
    // Luna fix round 2: the dry-run stdout is exactly the two main lines.
    expect(stdout).toBe(
      "fleet-v2-daemon.service would-remove\nfleet-v2-daemon.timer absent\n",
    );
    expect(calls).toEqual(["read"]);
  });

  it("uninstall --apply calls remove and prints exactly two lines with no enable:", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, calls } = await runDaemon(
      ["uninstall", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(0);
    // Luna fix round 2: the applied uninstall stdout is exactly these two
    // lines — the intake pair's codes are never printed when shadow is off.
    expect(stdout).toBe(
      "fleet-v2-daemon.service absent\nfleet-v2-daemon.timer absent\n",
    );
    expect(calls).toEqual(["remove"]);
  });

  it("uninstall --apply with shadow off exits 1 and reports an unreadable intake removal", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, { ...validV2, daemon });
    const { code, stdout, stderr, calls } = await runDaemon(
      ["uninstall", "--scheduler", "systemd", "--apply"],
      file,
      {
        remove: {
          service: "absent",
          timer: "absent",
          shadowIntake: { service: "unreadable", timer: "absent" },
        },
      },
    );
    // Fable fix round 2: the two main lines stay exactly as they are, but an
    // intake unit that is a symlink or fails unlink is reported and exits 1.
    expect(code).toBe(1);
    expect(stdout).toBe(
      "fleet-v2-daemon.service absent\nfleet-v2-daemon.timer absent\n",
    );
    expect(stderr).toContain(
      "installation.daemon.shadow: shadow-intake-unreadable\n",
    );
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

  // ------------------------------------------------------------------
  // OD7a1: shadow intake units and the merge-policy shadow selection
  // ------------------------------------------------------------------

  const daemonWithShadow = {
    ...daemon,
    shadow: { legacyStateDir: "/srv/fleet/legacy-state" },
  };

  const policyWithShadowRepo = {
    merge: { repos: { "owner/repo": { projectId: "proj-1" } } },
  };

  it("an entry omitting shadow defaults to true and renders 4 units", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon: daemonWithShadow,
      policy: policyWithShadowRepo,
    });
    const { code, stdout, calls } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-daemon.service written\n");
    expect(stdout).toContain("fleet-v2-shadow-intake.service written\n");
    expect(stdout).toContain("fleet-v2-shadow-intake.timer written\n");
    expect(stdout).toContain(
      "enable: systemctl --user enable fleet-v2-shadow-intake.timer\n",
    );
    expect(calls).toEqual(["write"]);
  });

  it("shadow: false renders only the 2 main units", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon: daemonWithShadow,
      policy: {
        merge: {
          repos: { "owner/repo": { projectId: "proj-1", shadow: false } },
        },
      },
    });
    const { code, stdout } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain("shadow-intake");
    expect(stdout).toContain("fleet-v2-daemon.service written\n");
    expect(stdout).toContain("fleet-v2-daemon.timer written\n");
  });

  it("shadow: true renders 4 units with the exact ExecStart and no baked grant", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon: daemonWithShadow,
      policy: {
        merge: {
          repos: { "owner/repo": { projectId: "proj-1", shadow: true } },
        },
      },
    });
    const { code, stdout, inputs } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fleet-v2-shadow-intake.service written\n");
    const intake = inputs[0]?.shadowIntake as
      | { service: string; timer: string }
      | undefined;
    expect(intake).toBeDefined();
    if (intake === undefined) {
      return;
    }
    expect(intake.service).toContain(
      "ExecStart=/srv/fleet/node/bin/node /srv/fleet/cli/fleet-v2.mjs --state-dir /srv/fleet/state merge import --repository owner/repo --legacy-state-dir /srv/fleet/legacy-state --apply --project proj-1 --scheduled",
    );
    expect(intake.service).not.toContain("--grant");
    expect(intake.service).not.toContain("Restart=");
    expect(intake.service).toContain("Environment=FLEET_STATE_DIR=/srv/fleet/state");
    expect(intake.service).toContain(
      "Environment=FLEET_INSTALLATION_FILE=/srv/fleet/fleet.json",
    );
    expect(intake.timer).toContain("OnUnitActiveSec=180s");
    expect(intake.timer).toContain("Unit=fleet-v2-shadow-intake.service");
  });

  it("refuses multiple shadow repositories", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon: daemonWithShadow,
      policy: {
        merge: {
          repos: {
            "owner/repo": { projectId: "proj-1" },
            "other/repo": { projectId: "proj-2" },
          },
        },
      },
    });
    const { code, stderr, calls } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "installation.policy.merge.repos: at most one shadow repository is supported\n",
    );
    expect(calls).toEqual([]);
  });

  it("refuses when policy shadow is true without daemon.shadow", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon,
      policy: policyWithShadowRepo,
    });
    const { code, stderr, calls } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "installation.daemon.shadow: required when shadow is enabled\n",
    );
    expect(calls).toEqual([]);
  });

  it("refuses an invalid merge policy", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon,
      policy: { merge: { repos: { "bad key!": { projectId: "p" } } } },
    });
    const { code, stderr, calls } = await runDaemon(
      ["install", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(1);
    // The loader refuses the malformed written policy before the daemon
    // command's own policy resolution ever runs.
    expect(stderr).toContain("policy.merge.repos");
    expect(calls).toEqual([]);
  });

  it("the daemon command's own policy resolution invalid branch is unreachable through the CLI", async () => {
    // Fable fix round 2: the `resolvedPolicy.outcome === 'invalid'` branch in
    // `daemonCommand` has no loader-passing input. The installation loader
    // validates everything `resolveMergePolicy` re-reads — repo keys, entry
    // keys, projectId, booleans, integers, bounds, veto, prepare, and the
    // budgetSeconds < intervalSeconds order — so any input that would fail
    // `resolveMergePolicy` is refused by the loader first (exit 1 with the
    // loader's own error, before the daemon command resolves the policy).
    // These near-miss inputs each fail at the loader, never at the branch.
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    for (const policy of [
      { merge: { repos: { "bad key!": { projectId: "p" } } } },
      { merge: { repos: { "owner/repo": { projectId: "p", unknown: 1 } } } },
      {
        merge: { repos: { "owner/repo": { projectId: "p" } } },
        daemon: { intervalSeconds: 60, budgetSeconds: 60 },
      },
    ]) {
      writeJsonFile(file, { ...validV2, daemon, policy });
      const { code, stderr, calls } = await runDaemon(
        ["uninstall", "--scheduler", "systemd", "--apply"],
        file,
      );
      expect(code).toBe(1);
      expect(stderr).toContain("policy.");
      expect(calls).toEqual([]);
    }
  });

  it("uninstall with shadow off prints exactly 2 lines and removes 4 units", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...validV2,
      daemon,
      policy: {
        merge: {
          repos: { "owner/repo": { projectId: "proj-1", shadow: false } },
        },
      },
    });
    const { code, stdout, calls } = await runDaemon(
      ["uninstall", "--scheduler", "systemd", "--apply"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(
      expect.stringContaining("fleet-v2-daemon.service absent\n"),
    );
    expect(stdout).not.toContain("shadow-intake");
    expect(calls).toEqual(["remove"]);
  });
});
