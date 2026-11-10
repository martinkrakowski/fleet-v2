/**
 * `fleet-v2 hosts` (lane H4): list, add, edit and remove on a real
 * installation file in a temp directory, with the host probe executor faked
 * (no ssh, no subprocess). The engine owns every rule, so these tests assert
 * the command's contract: exit codes (0 written, 1 refused, 2 usage), the
 * loader's own refusals, the v1→v2 conversion on the first write, the
 * lane-runner role (several hosts may hold it; add and edit leave it in
 * place), live-work refusals on remove, the compare-and-swap
 * conflict and the help text.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type {
  DoctorCommandRunResult,
  HostProbeExecutor,
} from "@fleet/onboarding";
import { sanitizeToken } from "@fleet/onboarding";
import {
  HOST_KEY_WITHHELD,
  HOST_NAME_SECRET_REFUSAL,
  isValidHostName,
  parseInstallation,
} from "@fleet/installation";
import {
  AttemptRepositoryAdapter,
  ExecutionJournalAdapter,
  nextAttemptRevision,
  type AttemptRecord,
  type CapacityReservationRecord,
} from "@fleet/work-execution";

import { runCli, type CliIo } from "../index.js";
import {
  hostsCommand,
  formatRoleAmbiguousRefusal,
  moveLaneRunnerRole,
} from "../hosts.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-hosts-command-"));
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

/** Read the installation file back through the real loader. */
function readInstallationFile(file: string): Record<string, unknown> {
  const result = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
  if (!result.ok) {
    throw new Error(
      `fixture failed to reload: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.installation as unknown as Record<string, unknown>;
}

/** The forced isolation floor a converted runner is written with. */
const CONVERSION_FLOOR = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: "scoped-worktree",
};

/** A loader-valid two-host v2 installation: mac orchestrates, lanehost runs lanes. */
function v2Installation(worktreeRoot: string): unknown {
  return {
    schemaVersion: 2,
    forge: { mode: "none" },
    hosts: {
      mac: {
        transport: "local",
        worktreeRoot,
        roles: ["orchestrator", "verifier"],
      },
      lanehost: {
        transport: "ssh",
        sshAlias: "m",
        worktreeRoot: `${worktreeRoot}/lanehost`,
        roles: ["lane-runner"],
        runner: { kind: "opencode", port: 4166 },
      },
    },
  };
}

/** A single-machine v2 installation whose lane-runner role can move away. */
function singleMachineInstallation(worktreeRoot: string): unknown {
  return {
    schemaVersion: 2,
    forge: { mode: "none" },
    hosts: {
      mac: {
        transport: "local",
        worktreeRoot,
        roles: ["orchestrator", "lane-runner"],
        runner: { kind: "opencode", port: 46000 },
      },
    },
  };
}

interface FakeExecutorBehaviour {
  /** Probes whose argv this predicate accepts report a non-zero exit. */
  readonly failWhen?: (argv: readonly string[]) => boolean;
  /** Runs before the first probe answer; used to race the installation file. */
  readonly onFirstRun?: () => void;
}

/**
 * The faked probe executor: every argv is recorded, `mktemp` answers with a
 * path inside the worktree root it was given (so the engine removes exactly
 * that one path), and everything else succeeds.
 */
function fakeExecutor(behaviour: FakeExecutorBehaviour = {}): {
  executor: HostProbeExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  let ranOnce = false;
  return {
    calls,
    executor: {
      async run(argv): Promise<DoctorCommandRunResult> {
        calls.push([...argv]);
        if (!ranOnce) {
          ranOnce = true;
          behaviour.onFirstRun?.();
        }
        if (behaviour.failWhen?.(argv) === true) {
          return {
            exitCode: 255,
            signal: null,
            stdout: "",
            stderr: "probe failure",
          };
        }
        const template = argv.find((token) =>
          token.includes(".fleet-probe.XXXXXX"),
        );
        if (template !== undefined) {
          return {
            exitCode: 0,
            signal: null,
            stdout: template.replace("XXXXXX", "probe1"),
            stderr: "",
          };
        }
        return { exitCode: 0, signal: null, stdout: "tool 1.0.0", stderr: "" };
      },
    },
  };
}

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: "att-1",
    workOrderId: "wo-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/srv/fleet/worktrees/att-1",
    baseCommit: "0".repeat(40),
    state: "running",
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: "opencode",
      remotePort: 4166,
      host: "m",
      hostName: "lanehost",
      agent: "lane",
      model: "provider/glm-5.3",
      variant: null,
    },
    createdAtIso: "2026-10-17T08:00:00.000Z",
    updatedAtIso: "2026-10-17T08:00:00.000Z",
    ...overrides,
  };
}

function heldReservation(
  overrides: Partial<CapacityReservationRecord> = {},
): CapacityReservationRecord {
  return {
    id: "res-1",
    attemptId: "att-1",
    hostId: "lanehost",
    slotIndex: 0,
    held: true,
    seatTool: "opencode",
    reservedAtIso: "2026-10-17T08:00:00.000Z",
    releasedAtIso: null,
    ...overrides,
  };
}

/** One hosts invocation against a real file; the probe executor is always faked. */
async function runHosts(
  argv: readonly string[],
  installationFile: string,
  behaviour: FakeExecutorBehaviour = {},
  confirm?: (question: string) => Promise<boolean>,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  calls: string[][];
}> {
  const { io, stdout, stderr } = mockIo();
  const { executor, calls } = fakeExecutor(behaviour);
  const code = await runCli(["hosts", ...argv], io, undefined, undefined, {
    installationFile,
    probeExecutor: executor,
    ...(confirm !== undefined ? { confirm } : {}),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), calls };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts list", () => {
  it("prints one line per configured host", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stdout } = await runHosts(["list"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("mac  local  roles: orchestrator, verifier");
    expect(stdout).toContain(
      "lanehost  ssh  alias m  roles: lane-runner  worktree-root:",
    );
    expect(stdout).toContain("runner: opencode, port 4166");
  });

  it("says so when the file is schema version 1 and exits 0", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 1,
      forge: { owner: "example-owner", repo: "example-repo" },
    });
    const { code, stdout } = await runHosts(["list"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("schema version 1");
  });

  it("refuses to list an installation the loader refuses", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      hosts: {},
      forge: { mode: "wat" },
    });
    const { code, stderr } = await runHosts(["list"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("the installation file is invalid");
  });
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts add", () => {
  /** HN1 fix round 2, finding 1: no 20+ character window of a token-run key. */
  const tokenRunKey = `Ab1${"xY9".repeat(11)}`;

  function expectNoKeyWindow(printed: string): void {
    for (let start = 0; start + 20 <= tokenRunKey.length; start++) {
      expect(printed).not.toContain(tokenRunKey.slice(start, start + 20));
    }
  }

  it("withholds a 36-character token-run key from an add draft error", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stdout, stderr } = await runHosts(
      ["add", tokenRunKey, "--worktree-root", "relative/path", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("worktreeRoot: must be an absolute path");
    expectNoKeyWindow(stdout + stderr);
  });

  it("writes a new host after the probe, diff and --yes", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = v2Installation(path.join(dir, "worktrees"));
    writeJsonFile(file, installation);
    const { code, stdout, calls } = await runHosts(
      [
        "add",
        "verifyhost",
        "--ssh",
        "verifyhost.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--role",
        "verifier",
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    // The probe ran through ssh with BatchMode and the alias after `--`.
    const reachability = calls.find((argv) => argv.includes("true"));
    expect(reachability?.slice(0, 5)).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
    ]);
    expect(reachability?.[5]).toBe("verifyhost.example");
    expect(reachability?.[6]).toBe("--");
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[]; runner?: { port: number } }>;
    };
    expect(parsed.hosts.verifyhost?.roles).toEqual(["verifier"]);
    expect(parsed.hosts.verifyhost?.runner?.port).toBe(47000);
    // The existing hosts are untouched.
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator", "verifier"]);
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner"]);
  });

  it("refuses with exit 1 and writes nothing when a probe FAILs", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const before = readFileSync(file, "utf8");
    const { code, stdout, stderr } = await runHosts(
      [
        "add",
        "verifyhost",
        "--ssh",
        "verifyhost.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--role",
        "verifier",
        "--yes",
      ],
      file,
      { failWhen: (argv) => argv.includes("true") },
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "refused: a probe reported FAIL; nothing was written",
    );
    expect(stdout).toContain("FAIL host verifyhost reachable —");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("treats an unsafe ssh alias as a usage error (exit 2) and probes nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr, calls } = await runHosts(
      [
        "add",
        "verifyhost",
        "--ssh",
        "-oProxyCommand=evil",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('must not start with "-"');
    expect(stderr).toContain("can never be read as an ssh option");
    expect(calls).toEqual([]);
  });

  it("converts a v1 file to v2 on the first write and forces the isolation floor", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const worktreeRoot = path.join(dir, "worktrees");
    writeJsonFile(file, {
      schemaVersion: 1,
      runner: {
        agent: "example-agent",
        model: "example-provider/glm-5.3",
        remotePort: 46000,
        host: "m",
      },
      worktree: { sshHost: "m" },
      verification: {
        sshHost: "verify.example",
        procedures: {
          gate: { command: "fleet-verify-example", args: ["--gate"] },
        },
      },
      forge: { owner: "example-owner", repo: "example-repo" },
      reviewer: { agent: "example-agent", model: "example-provider/grok-4.7" },
      waves: {
        baseUrl: "https://waves.example",
        tokenFile: "/home/operator/.config/fleet/waves-token",
      },
    });
    const { code, stdout } = await runHosts(
      [
        "add",
        "here",
        "--worktree-root",
        worktreeRoot,
        "--role",
        "orchestrator,lane-runner,verifier",
        "--port",
        "46000",
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "converting the schema version 1 file to version 2",
    );
    const parsed = readInstallationFile(file) as {
      schemaVersion: number;
      hosts: Record<string, Record<string, unknown>>;
      forge: Record<string, unknown>;
      verification: Record<string, unknown>;
      waves: Record<string, unknown>;
      runner?: unknown;
      worktree?: unknown;
      reviewer?: unknown;
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.forge).toEqual({
      mode: "github",
      owner: "example-owner",
      repo: "example-repo",
    });
    expect(parsed.verification).toEqual({
      procedures: {
        gate: { command: "fleet-verify-example", args: ["--gate"] },
      },
    });
    expect(parsed.waves).toEqual({
      baseUrl: "https://waves.example",
      tokenFile: "/home/operator/.config/fleet/waves-token",
    });
    expect(parsed.runner).toBeUndefined();
    expect(parsed.worktree).toBeUndefined();
    expect(parsed.reviewer).toBeUndefined();
    const here = parsed.hosts.here as {
      transport: string;
      worktreeRoot: string;
      roles: string[];
      runner: {
        kind: string;
        port: number;
        capabilities: Record<string, unknown>;
      };
    };
    expect(here.transport).toBe("local");
    expect(here.worktreeRoot).toBe(worktreeRoot);
    expect(here.roles).toEqual(["orchestrator", "lane-runner", "verifier"]);
    expect(here.runner.port).toBe(46000);
    // The isolation step is forced: the converted runner is declared at the
    // floor today's v1 runner asserts, never silently undeclared.
    expect(here.runner.capabilities).toEqual(CONVERSION_FLOOR);
  });

  it("adds a second lane-runner when the existing host holds only that role, and the existing host keeps it", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stdout, stderr } = await runHosts(
      [
        "add",
        "lane2",
        "--role",
        "lane-runner",
        "--port",
        "4266",
        "--worktree-root",
        path.join(dir, "lane2"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts.lane2?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator", "verifier"]);
    expect(stderr).not.toContain("at least one role");
    expect(stdout).not.toContain("role moved");
  });

  it("adds a lane-runner when three hosts already hold only that role, and each of those three keeps it", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        "lane-a": {
          transport: "local",
          worktreeRoot: path.join(dir, "lane-a"),
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 46101 },
        },
        "lane-b": {
          transport: "local",
          worktreeRoot: path.join(dir, "lane-b"),
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 46102 },
        },
        "lane-c": {
          transport: "local",
          worktreeRoot: path.join(dir, "lane-c"),
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 46103 },
        },
      },
    });
    const { code, stderr } = await runHosts(
      [
        "add",
        "lane-d",
        "--role",
        "lane-runner",
        "--port",
        "46104",
        "--worktree-root",
        path.join(dir, "lane-d"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts["lane-a"]?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts["lane-b"]?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts["lane-c"]?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts["lane-d"]?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator"]);
    expect(stderr).not.toContain("at least one role");
  });

  it("adds a verifier while a host holds only lane-runner, and does not change that host's role", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stdout, stderr } = await runHosts(
      [
        "add",
        "verifyhost",
        "--ssh",
        "verifyhost.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--role",
        "verifier",
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.verifyhost?.roles).toEqual(["verifier"]);
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner"]);
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator", "verifier"]);
    expect(stdout).not.toContain("role moved");
    expect(stderr).not.toContain("at least one role");
  });

  it("adds a lane-runner beside a host that also holds orchestrator, and that host keeps lane-runner", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, singleMachineInstallation(path.join(dir, "worktrees")));
    const { code, stdout } = await runHosts(
      [
        "add",
        "lanehost",
        "--ssh",
        "m",
        "--port",
        "4166",
        "--worktree-root",
        path.join(dir, "lanehost"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain("role moved");
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator", "lane-runner"]);
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner"]);
  });

  it("refuses a name that is already in the file with the engine refusal", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr } = await runHosts(
      [
        "add",
        "lanehost",
        "--ssh",
        "m",
        "--port",
        "4266",
        "--worktree-root",
        path.join(dir, "lanehost"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "already in the installation file; editing is a separate mode",
    );
  });

  it("writes nothing when the confirmation is declined", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      [
        "add",
        "verifyhost",
        "--ssh",
        "verifyhost.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--role",
        "verifier",
      ],
      file,
      {},
      async () => false,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("not confirmed; nothing was written");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("exits 1 when the file changed between the read and the write", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = v2Installation(path.join(dir, "worktrees"));
    writeJsonFile(file, installation);
    // The first probe run races the file: another writer replaces it after
    // this command read it, so the compare-and-swap write must refuse.
    const raced = v2Installation(path.join(dir, "other-worktrees"));
    const { code, stderr } = await runHosts(
      [
        "add",
        "verifyhost",
        "--ssh",
        "verifyhost.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--role",
        "verifier",
        "--yes",
      ],
      file,
      {
        onFirstRun: () => {
          writeJsonFile(file, raced);
        },
      },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("changed on disk since it was read");
    // The other writer's file is intact; this command wrote nothing over it.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(raced);
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts edit", () => {
  /** HN1 fix round 2, finding 1: no 20+ character window of a token-run key. */
  const tokenRunKey = `Ab1${"xY9".repeat(11)}`;

  it("withholds a 36-character token-run key from an edit draft error", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "worktrees"),
          roles: ["orchestrator"],
        },
        [tokenRunKey]: {
          transport: "local",
          worktreeRoot: path.join(dir, "worktrees"),
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 4166 },
        },
      },
    });
    const before = readFileSync(file, "utf8");
    const { code, stdout, stderr } = await runHosts(
      ["edit", tokenRunKey, "--worktree-root", "relative/path", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("worktreeRoot: must be an absolute path");
    const printed = stdout + stderr;
    for (let start = 0; start + 20 <= tokenRunKey.length; start++) {
      expect(printed).not.toContain(tokenRunKey.slice(start, start + 20));
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("changes the port and keeps what the flags leave out", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stdout } = await runHosts(
      ["edit", "lanehost", "--port", "4266", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    const parsed = readInstallationFile(file) as {
      hosts: Record<
        string,
        {
          sshAlias?: string;
          worktreeRoot: string;
          roles: string[];
          runner?: { port: number; kind: string };
        }
      >;
    };
    expect(parsed.hosts.lanehost?.runner?.port).toBe(4266);
    expect(parsed.hosts.lanehost?.runner?.kind).toBe("opencode");
    expect(parsed.hosts.lanehost?.sshAlias).toBe("m");
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner"]);
  });

  it("PT1a: edits a host in a file whose policy.daemon.stallAfterMinutes is bad, keeping the operator's value", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...(v2Installation(path.join(dir, "worktrees")) as Record<string, unknown>),
      policy: { daemon: { stallAfterMinutes: 0 } },
    });
    const { code, stdout, stderr } = await runHosts(
      ["edit", "lanehost", "--port", "4266", "--yes"],
      file,
    );
    expect(stderr).not.toContain("stallAfterMinutes");
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      hosts: Record<string, { runner?: { port: number } }>;
      policy: { daemon: { stallAfterMinutes: number } };
    };
    expect(written.hosts.lanehost?.runner?.port).toBe(4266);
    expect(written.policy.daemon.stallAfterMinutes).toBe(0);
  });

  it("PT1b1: edits a host in a file whose policy.daemon.autoResumeMax is bad, keeping the operator's value", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      ...(v2Installation(path.join(dir, "worktrees")) as Record<string, unknown>),
      policy: { daemon: { autoResumeMax: "plenty" } },
    });
    const { code, stdout, stderr } = await runHosts(
      ["edit", "lanehost", "--port", "4266", "--yes"],
      file,
    );
    expect(stderr).not.toContain("autoResumeMax");
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      hosts: Record<string, { runner?: { port: number } }>;
      policy: { daemon: { autoResumeMax: string | number } };
    };
    expect(written.hosts.lanehost?.runner?.port).toBe(4266);
    expect(written.policy.daemon.autoResumeMax).toBe("plenty");
  });

  it("edits the roles of an existing host", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code } = await runHosts(
      ["edit", "lanehost", "--role", "lane-runner,verifier", "--yes"],
      file,
    );
    expect(code).toBe(0);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner", "verifier"]);
  });

  it("edits a host to add lane-runner while another host holds only that role, and the other host keeps it", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr } = await runHosts(
      [
        "edit",
        "mac",
        "--role",
        "orchestrator,verifier,lane-runner",
        "--port",
        "46000",
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.mac?.roles).toEqual([
      "orchestrator",
      "verifier",
      "lane-runner",
    ]);
    expect(parsed.hosts.lanehost?.roles).toEqual(["lane-runner"]);
    expect(stderr).not.toContain("at least one role");
  });

  it("keeps the runner's gateSlot when another field is edited (KF-30b)", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const base = v2Installation(path.join(dir, "worktrees")) as {
      hosts: Record<string, Record<string, unknown>>;
    };
    writeJsonFile(file, {
      ...base,
      hosts: {
        ...base.hosts,
        lanehost: {
          ...base.hosts.lanehost,
          runner: {
            kind: "opencode",
            port: 4166,
            gateSlot: { path: "/usr/local/bin/gate-slot", slots: 8 },
          },
        },
      },
    });
    const { code, stdout } = await runHosts(
      ["edit", "lanehost", "--port", "4266", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    const parsed = readInstallationFile(file) as {
      hosts: Record<
        string,
        { runner?: { port: number; gateSlot?: { path: string; slots: number } } }
      >;
    };
    expect(parsed.hosts.lanehost?.runner?.port).toBe(4266);
    expect(parsed.hosts.lanehost?.runner?.gateSlot).toEqual({
      path: "/usr/local/bin/gate-slot",
      slots: 8,
    });
  });

  it("refuses a host that is not in the file", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr } = await runHosts(
      ["edit", "nosuch", "--port", "4266", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "not in the installation file; adding is a separate mode",
    );
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts remove", () => {
  it("refuses the orchestrator host", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr } = await runHosts(["remove", "mac", "--yes"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("holds the orchestrator role");
  });

  it("refuses the last lane-runner host", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr } = await runHosts(
      ["remove", "lanehost", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("is the last lane-runner host");
  });

  it("refuses a host with a live attempt, and allows one that released capacity", async () => {
    const stateDir = makeTempDir();
    const file = path.join(stateDir, "fleet.json");
    const installation = v2Installation(path.join(stateDir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.verifyhost = {
      transport: "ssh",
      sshAlias: "verifyhost.example",
      worktreeRoot: path.join(stateDir, "verifyhost"),
      roles: ["verifier"],
    };
    writeJsonFile(file, installation);
    const attempts = new AttemptRepositoryAdapter({ stateDir });
    await attempts.saveAttempt(
      attemptRecord({
        id: "att-1",
        state: "running",
        runner: {
          kind: "opencode",
          remotePort: 47000,
          host: "verifyhost.example",
          hostName: "verifyhost",
          agent: "lane",
          model: "provider/glm-5.3",
          variant: null,
        },
      }),
    );
    const argv = ["remove", "verifyhost", "--yes", "--state-dir", stateDir];
    const refused = await runHosts(argv, file);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("attempt att-1 is running on verifyhost");
    expect(refused.stderr).toContain("has live work; nothing was removed");
    // An attempt whose state is in CAPACITY_RELEASE_STATES no longer blocks.
    const storedAttempt = await attempts.findAttemptById("att-1");
    await attempts.saveAttempt({
      ...storedAttempt!,
      state: "ended",
      revision: nextAttemptRevision(storedAttempt!),
    });
    const released = await runHosts(argv, file);
    expect(released.code).toBe(0);
  });

  it("refuses a host with an active reservation", async () => {
    const stateDir = makeTempDir();
    const file = path.join(stateDir, "fleet.json");
    const installation = v2Installation(path.join(stateDir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.verifyhost = {
      transport: "ssh",
      sshAlias: "verifyhost.example",
      worktreeRoot: path.join(stateDir, "verifyhost"),
      roles: ["verifier"],
    };
    writeJsonFile(file, installation);
    const journal = new ExecutionJournalAdapter({ stateDir });
    await journal.saveCapacityReservation(
      heldReservation({ hostId: "verifyhost" }),
    );
    const { code, stderr } = await runHosts(
      ["remove", "verifyhost", "--yes", "--state-dir", stateDir],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "reservation res-1 holds a slot for attempt att-1 on verifyhost",
    );
    expect(stderr).toContain("has live work; nothing was removed");
  });

  it("removes a verifier host, prints the leftover-forward hint and the single-machine note", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = v2Installation(path.join(dir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.verifyhost = {
      transport: "ssh",
      sshAlias: "verifyhost.example",
      worktreeRoot: path.join(dir, "verifyhost"),
      roles: ["verifier"],
      runner: { kind: "opencode", port: 47000 },
    };
    writeJsonFile(file, installation);
    const { code, stdout } = await runHosts(
      ["remove", "verifyhost", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "note: a leftover ssh -f -N forward for this host may still listen on 127.0.0.1:47001",
    );
    expect(stdout).toContain("pgrep -f 'ssh .*-L 127.0.0.1:47001'");
    // lanehost is still ssh, so the installation is not single-machine.
    expect(stdout).not.toContain("single-machine again");
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, unknown>;
    };
    expect(parsed.hosts.verifyhost).toBeUndefined();
    expect(parsed.hosts.lanehost).toBeDefined();
  });

  it("notes when removing the last ssh host returns the install to single machine", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = singleMachineInstallation(path.join(dir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.lanehost = {
      transport: "ssh",
      sshAlias: "m",
      worktreeRoot: path.join(dir, "lanehost"),
      roles: ["verifier"],
    };
    writeJsonFile(file, installation);
    const { code, stdout } = await runHosts(
      ["remove", "lanehost", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "the installation is single-machine again: no host is reached over ssh",
    );
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, unknown>;
    };
    expect(parsed.hosts.lanehost).toBeUndefined();
    expect(parsed.hosts.mac).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// usage and help
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts usage", () => {
  it("prints the help block for --help and exits 0", async () => {
    const dir = makeTempDir();
    const { code, stdout } = await runHosts(
      ["--help"],
      path.join(dir, "fleet.json"),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: fleet-v2 hosts <subcommand> [flags]");
    expect(stdout).toContain("list");
    expect(stdout).toContain("add <name>");
    expect(stdout).toContain("remove <name>");
    expect(stdout).toContain("There is no --force.");
    expect(stdout).toContain("Several hosts may hold");
    expect(stdout).not.toContain("moves that");
  });

  it("treats a missing subcommand and an unknown flag as usage errors", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const bare = await runHosts([], file);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("Unknown hosts subcommand");
    const flagged = await runHosts(["add", "x", "--wat", "1"], file);
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain("Unknown hosts add option: --wat");
    const unnamed = await runHosts(["add", "--worktree-root", "/srv"], file);
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toContain("hosts add requires a host name");
  });

  it("requires --worktree-root for add and a known role name", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const noRoot = await runHosts(["add", "verifyhost", "--yes"], file);
    expect(noRoot.code).toBe(2);
    expect(noRoot.stderr).toContain("hosts add requires --worktree-root");
    const badRole = await runHosts(
      [
        "add",
        "verifyhost",
        "--worktree-root",
        path.join(dir, "verifyhost"),
        "--role",
        "wizard",
        "--yes",
      ],
      file,
    );
    expect(badRole.code).toBe(2);
    expect(badRole.stderr).toContain(
      "--role must be one of: orchestrator, lane-runner, verifier",
    );
  });
});

// ---------------------------------------------------------------------------
// hosts show and the P2 host-draft fixes
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts show and the P2 host-draft fixes", () => {
  it("keeps the existing host's lane-runner role alias when another lane-runner is added", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        oldhost: {
          transport: "ssh",
          sshAlias: "old",
          worktreeRoot: path.join(dir, "oldhost"),
          roles: ["verifier", "lane-runner"],
          roleAliases: {
            "lane-runner": "old-lr",
            verifier: "old-v",
          },
          runner: { kind: "opencode", port: 4200 },
        },
      },
    });
    const added = await runHosts(
      [
        "add",
        "newhost",
        "--worktree-root",
        path.join(dir, "newhost"),
        "--role",
        "lane-runner",
        "--port",
        "5000",
        "--yes",
      ],
      file,
    );
    expect(added.code).toBe(0);
    const reloaded = readFileSync(file, "utf8");
    expect(reloaded).toContain('"lane-runner": "old-lr"');
    expect(reloaded).toContain('"verifier": "old-v"');
    const addedParsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(addedParsed.hosts.oldhost?.roles).toEqual([
      "verifier",
      "lane-runner",
    ]);
    // The sole-alias case: the alias map stays intact on the untouched host.
    const soleDir = makeTempDir();
    const soleFile = path.join(soleDir, "fleet.json");
    writeJsonFile(soleFile, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(soleDir, "wt"),
          roles: ["orchestrator"],
        },
        oldhost: {
          transport: "ssh",
          sshAlias: "old",
          worktreeRoot: path.join(soleDir, "oldhost"),
          roles: ["verifier", "lane-runner"],
          roleAliases: { "lane-runner": "old-lr" },
          runner: { kind: "opencode", port: 4200 },
        },
      },
    });
    const sole = await runHosts(
      [
        "add",
        "newhost",
        "--worktree-root",
        path.join(soleDir, "newhost"),
        "--role",
        "lane-runner",
        "--port",
        "5000",
        "--yes",
      ],
      soleFile,
    );
    expect(sole.code).toBe(0);
    const soleReloaded = JSON.parse(readFileSync(soleFile, "utf8")) as {
      hosts: Record<string, { roleAliases?: unknown; roles?: string[] }>;
    };
    expect(soleReloaded.hosts.oldhost.roleAliases).toEqual({
      "lane-runner": "old-lr",
    });
    expect(soleReloaded.hosts.oldhost.roles).toEqual([
      "verifier",
      "lane-runner",
    ]);
  });

  it("prints one line under --yes naming any role alias dropped by an edit", async () => {
    // An edit that drops a role drops that role's alias.
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        lanehost: {
          transport: "ssh",
          sshAlias: "m",
          worktreeRoot: path.join(dir, "lanehost"),
          roles: ["lane-runner", "verifier"],
          roleAliases: {
            "lane-runner": "moved-lr",
            verifier: "old-v",
          },
          runner: { kind: "opencode", port: 4166 },
        },
      },
    });
    const edited = await runHosts(["edit", "lanehost", "--role", "lane-runner", "--yes"], file);
    expect(edited.code).toBe(0);
    const noticeLines = edited.stdout
      .split("\n")
      .filter((line) => line.startsWith("dropped role alias:"));
    expect(noticeLines).toEqual(["dropped role alias: hosts.lanehost.roleAliases.verifier"]);
    expect(noticeLines.join("\n")).not.toContain("old-v");
  });

  it("renders the role-ambiguous refusal as operator text naming the role and telling the operator to name the host", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator", "verifier"],
        },
        second: {
          transport: "local",
          worktreeRoot: path.join(dir, "second"),
          roles: ["verifier"],
        },
        lanehost: {
          transport: "ssh",
          sshAlias: "m",
          worktreeRoot: path.join(dir, "lanehost"),
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 4166 },
        },
      },
    });
    const shown = await runHosts(["show", "--role", "verifier"], file);
    expect(shown.code).toBe(1);
    expect(shown.stdout).toBe("");
    expect(shown.stderr).toContain("verifier");
    expect(shown.stderr).toContain("name the host");
    expect(shown.stderr).not.toContain("fleet.json");
  });

  it("hosts show prints the generated port, tunnel, container, role-alias and auth-presence table for all hosts, one named host or one unambiguous --role", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
          runner: { kind: "opencode", port: 4100 },
        },
        lanehost: {
          transport: "ssh",
          sshAlias: "m",
          container: "lane-box",
          roleAliases: { "lane-runner": "m" },
          worktreeRoot: path.join(dir, "lanehost"),
          roles: ["lane-runner"],
          runner: {
            kind: "opencode",
            port: 4166,
            authFile: path.join(dir, "auth.json"),
          },
        },
      },
    });
    const all = await runHosts(["show"], file);
    expect(all.code).toBe(0);
    for (const column of [
      "HOST",
      "TRANSPORT",
      "SSH",
      "CONTAINER",
      "ROLES",
      "ROLE_ALIASES",
      "RUNNER",
      "TUNNEL_OFFSET",
      "DIAL_PORT",
      "AUTH",
    ]) {
      expect(all.stdout).toContain(column);
    }
    expect(all.stdout.indexOf("lanehost")).toBeLessThan(all.stdout.indexOf("mac"));
    expect(all.stdout).toContain("lane-box");
    expect(all.stdout).toContain("lane-runner=m");
    expect(all.stdout).toContain("4167");
    expect(all.stdout).toContain("configured");
    expect(all.stdout).not.toContain("auth.json");
    const one = await runHosts(["show", "lanehost"], file);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain("4167");
    expect(one.stdout).not.toContain("mac");
    const local = await runHosts(["show", "mac"], file);
    expect(local.code).toBe(0);
    expect(local.stdout).toContain("4100");
    const byRole = await runHosts(["show", "--role", "orchestrator"], file);
    expect(byRole.code).toBe(0);
    expect(byRole.stdout).toContain("mac");
    expect(byRole.stdout).not.toContain("lanehost");
    const unknown = await runHosts(["show", "nosuchhost"], file);
    expect(unknown.code).toBe(1);
    const both = await runHosts(["show", "mac", "--role", "orchestrator"], file);
    expect(both.code).toBe(2);
  });

  it("hosts edit updates container and role-alias over existing host values; the loader bounds tunnel offset to 1", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        lanehost: {
          transport: "ssh",
          sshAlias: "m",
          container: "lane-box",
          roleAliases: { "lane-runner": "m" },
          worktreeRoot: path.join(dir, "lanehost"),
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 4166 },
        },
      },
    });
    const edited = await runHosts(
      [
        "edit",
        "lanehost",
        "--container",
        "newc",
        "--role-alias",
        "lane-runner=nl",
        "--yes",
      ],
      file,
    );
    expect(edited.code).toBe(0);
    const reloaded = readFileSync(file, "utf8");
    expect(reloaded).toContain('"container": "newc"');
    expect(reloaded).toContain('"lane-runner": "nl"');
    expect(reloaded).not.toContain('"lane-box"');
    expect(() => readInstallationFile(file)).not.toThrow();
    // The frozen runner dials port + 1, so the loader refuses any other offset.
    const refused = await runHosts(
      ["edit", "lanehost", "--tunnel-offset", "3", "--yes"],
      file,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("tunnelOffset");
    expect(readFileSync(file, "utf8")).toBe(reloaded);
  });

  it("hostsCommand never throws on malformed runtime argv/options, sparse arrays, unknown role enums or throwing getters", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const hostileOptions = new Proxy(
      {},
      {
        get() {
          throw new Error("no access");
        },
      },
    );
    const cases: readonly (readonly [
      string,
      () => Promise<number>,
      number,
    ])[] = [
      ["null argv", () => hostsCommand(null as never, mockIo().io), 2],
      ["string argv", () => hostsCommand("show" as never, mockIo().io), 2],
      [
        "sparse argv",
        () => {
          const sparse = ["show"] as unknown as string[];
          sparse[3] = "x";
          return hostsCommand(sparse, mockIo().io);
        },
        2,
      ],
      [
        "hostile options",
        () => hostsCommand(["show"], mockIo().io, hostileOptions as never),
        1,
      ],
    ];
    for (const [label, run, expected] of cases) {
      const code = await run();
      expect(code, label).toBe(expected);
    }
    void file;
  });

  it("leaves the installation file untouched when a probe fails or confirmation is declined on an edit with P2 fields", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const before = readFileSync(file, "utf8");
    const failed = await runHosts(
      ["edit", "lanehost", "--container", "newc", "--yes"],
      file,
      { failWhen: () => true },
    );
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("refused: a probe reported FAIL");
    expect(readFileSync(file, "utf8")).toBe(before);
    const declined = await runHosts(
      ["edit", "lanehost", "--container", "newc"],
      file,
      {},
      async () => false,
    );
    expect(declined.code).toBe(1);
    expect(declined.stderr).toContain("not confirmed");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("hosts show reports an unreadable installation as unknown and exits 1 instead of empty or 0", async () => {
    const dir = makeTempDir();
    const shown = await runHosts(["show"], dir);
    expect(shown.code).toBe(1);
    expect(shown.stderr).toContain("installation: unknown (unreadable)");
    expect(shown.stdout).toBe("");
  });

  it("hosts show, dropped-alias notice and refusals never echo paths or secret-shaped text", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const token = ["ghp", "_" + "a".repeat(24)].join("");
    const sk = ["sk", "-" + "b".repeat(24)].join("");
    const aws = ["AKIA", "C".repeat(16)].join("");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: "/srv/secret/worktrees",
          tmpDir: "/srv/secret/" + sk,
          roles: ["orchestrator", "verifier"],
        },
        lanehost: {
          transport: "ssh",
          sshAlias: "m",
          worktreeRoot: path.join(dir, "lanehost"),
          roles: ["verifier", "lane-runner"],
          roleAliases: {
            verifier: "m-v",
            "lane-runner": "m-lr",
          },
          runner: {
            kind: "opencode",
            port: 4166,
            authFile: "/srv/secret/" + token,
          },
        },
      },
    });
    const shown = await runHosts(["show"], file);
    expect(shown.code).toBe(0);
    expect(shown.stdout).not.toContain("/srv/secret");
    expect(shown.stdout).not.toContain(token);
    expect(shown.stdout).not.toContain(sk);
    expect(shown.stdout).not.toContain(aws);
    const unknown = await runHosts(["show", "nosuchhost"], file);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).not.toContain("/srv/secret");
    expect(unknown.stderr).not.toContain(token);
    // A lane-runner move drops the alias on the host it moved from; the notice
    // and the diff name ids and roles only, never the secret paths.
    const moved = await runHosts(
      ["add", "newhost", "--worktree-root", path.join(dir, "newhost"), "--role", "lane-runner", "--port", "5000", "--yes"],
      file,
    );
    expect(moved.code).toBe(0);
    expect(moved.stdout).not.toContain("/srv/secret");
    expect(moved.stdout).not.toContain(token);
    expect(moved.stdout).not.toContain(sk);
    expect(moved.stdout).not.toContain(aws);
  });

  it("hosts show invokes no subprocess or probe executor", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { io } = mockIo();
    const throwing = {
      run: () => {
        throw new Error("no subprocess");
      },
    } as unknown as HostProbeExecutor;
    const code = await hostsCommand(["show"], io, {
      installationFile: file,
      probeExecutor: throwing,
    });
    expect(code).toBe(0);
  });

  it("bounds argv length, flag value length and hosts show table row count", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const longArgv = await runHosts(["show", ...Array.from({ length: 129 }, () => "x")], file);
    expect(longArgv.code).toBe(2);
    const longToken = await runHosts(["show", "x".repeat(1025)], file);
    expect(longToken.code).toBe(2);
    const hosts: Record<string, unknown> = {
      mac: {
        transport: "local",
        worktreeRoot: path.join(dir, "wt"),
        roles: ["orchestrator"],
      },
      lanehost: {
        transport: "ssh",
        sshAlias: "m",
        worktreeRoot: path.join(dir, "lanehost"),
        roles: ["lane-runner"],
        runner: { kind: "opencode", port: 4166 },
      },
    };
    for (let index = 0; index < 256; index += 1) {
      hosts[`verifier${index}`] = {
        transport: "local",
        worktreeRoot: path.join(dir, `verifier${index}`),
        roles: ["verifier"],
      };
    }
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts,
    });
    const crowded = await runHosts(["show"], file);
    expect(crowded.code).toBe(1);
    expect(crowded.stderr).toContain("host count exceeds maximum (256)");
  });
});

// ---------------------------------------------------------------------------
// Fix round 1: global redaction, usage-refusal echo and move-role guards
// ---------------------------------------------------------------------------

describe("fix round 1: redaction, usage echo and moveLaneRunnerRole guards", () => {
  it("sanitizeToken replaces every secret-shaped span and separator, not only the first", () => {
    const first = ["ghp", "_" + "a".repeat(24)].join("");
    const second = ["sk", "-" + "b".repeat(24)].join("");
    const third = ["AKIA", "C".repeat(16)].join("");
    const text = `${first} ${second} ${third} ${first}`;
    const sanitized = sanitizeToken(text);
    expect(sanitized).not.toContain(first);
    expect(sanitized).not.toContain(second);
    expect(sanitized).not.toContain(third);
    expect(sanitized).toBe(
      "<redacted> <redacted> <redacted> <redacted>",
    );
    // The separator pattern removes every slash and backslash, not one.
    expect(sanitizeToken("/srv/a\\/b")).not.toContain("/");
    expect(sanitizeToken("/srv/a\\/b")).not.toContain("\\");
  });

  it("usage refusals never echo raw operator values", async () => {
    const token = ["sk", "-" + "c".repeat(24)].join("");
    const path = "/srv/secret/fleet.json";
    const { io, stderr } = mockIo();
    expect(await hostsCommand(["add", "x", "--port", token], io)).toBe(2);
    expect(await hostsCommand(["add", "x", "--role", token], io)).toBe(2);
    expect(await hostsCommand([token], io)).toBe(2);
    const out = stderr.join("");
    expect(out).not.toContain(token);
    expect(out).not.toContain(path);
  });

  it("host-name refusals and notices never echo a secret-shaped or invalid name (Fable round)", async () => {
    const ghp = ["ghp", "_" + "a1".repeat(12)].join("");
    const akia = ["AKIA", "C".repeat(16)].join("");
    const colon = "user:" + "t".repeat(122) + "@h";
    expect(colon.length).toBe(129);
    const secrets = [ghp, akia, colon];
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        [akia]: {
          transport: "ssh",
          sshAlias: "old",
          worktreeRoot: path.join(dir, "old"),
          roles: ["verifier", "lane-runner"],
          roleAliases: { "lane-runner": "old-lr", verifier: "old-v" },
          runner: { kind: "opencode", port: 4200 },
        },
      },
    });
    for (const secret of secrets) {
      const results = [
        await runHosts(["edit", secret, "--port", "1"], file, {}, async () => false),
        // A valid name that is added lands in the file diff by design; only the
        // refused (invalid) name must stay out of every line.
        ...(secret === colon
          ? [await runHosts(["add", secret, "--ssh", "h", "--worktree-root", "/w", "--role", "verifier", "--yes"], file)]
          : []),
        // `show` of a name the file holds prints that row by design.
        ...(secret !== akia ? [await runHosts(["show", secret], file)] : []),
        await runHosts(["remove", secret], file, {}, async () => false),
      ];
      for (const result of results) {
        for (const s of secrets) {
          expect(result.stdout + result.stderr).not.toContain(s);
        }
      }
    }
    // The loader refuses a secret-shaped host-map key outright (HN1); an add
    // that succeeds still screens a key the loader accepts but the host-key
    // screen withholds: a long opaque run.
    const opaque = ["Zq", "9x".repeat(12)].join("");
    const movedFile = path.join(dir, "fleet-opaque.json");
    writeJsonFile(movedFile, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        [opaque]: {
          transport: "ssh",
          sshAlias: "old",
          worktreeRoot: path.join(dir, "old"),
          roles: ["verifier", "lane-runner"],
          roleAliases: { "lane-runner": "old-lr", verifier: "old-v" },
          runner: { kind: "opencode", port: 4200 },
        },
      },
    });
    const moved = await runHosts(
      ["add", "newhost", "--worktree-root", path.join(dir, "n"), "--role", "lane-runner", "--port", "5000", "--yes"],
      movedFile,
    );
    expect(moved.code).toBe(0);
    expect(moved.stdout + moved.stderr).not.toContain(opaque);
    expect(moved.stdout + moved.stderr).not.toContain(akia);
    expect(formatRoleAmbiguousRefusal("verifier", [ghp, akia, "ok-host"])).not.toContain(ghp);
    expect(formatRoleAmbiguousRefusal("verifier", [ghp, akia, "ok-host"])).not.toContain(akia);
    expect(formatRoleAmbiguousRefusal("verifier", [ghp, "ok-host"])).toContain("ok-host");
  });

  it("moveLaneRunnerRole guards hostile runtime hosts without throwing", () => {
    // A null roleAliases map is returned unchanged, not a throw.
    const withNullAliases = {
      schemaVersion: 2,
      hosts: {
        other: {
          transport: "local",
          worktreeRoot: "/w",
          roles: ["lane-runner"],
          roleAliases: null,
        },
      },
    };
    const nulled = moveLaneRunnerRole(withNullAliases, "new");
    expect(nulled.movedFrom).toEqual([]);
    expect(nulled.value).toBe(withNullAliases);
    const nulledHosts = (nulled.value as { hosts: Record<string, Record<string, unknown>> }).hosts;
    expect(nulledHosts.other.roles).toEqual(["lane-runner"]);
    expect(nulledHosts.other.roleAliases).toBeNull();

    // A throwing getter on current.hosts never runs.
    const hostileHosts = {
      get hosts() {
        throw new Error("hostile");
      },
    };
    expect(() => moveLaneRunnerRole(hostileHosts, "new")).not.toThrow();
    expect(moveLaneRunnerRole(hostileHosts, "new").movedFrom).toEqual([]);

    // A throwing getter on a roles element never runs; the host is skipped.
    const roles = ["lane-runner"];
    Object.defineProperty(roles, 0, {
      get() {
        throw new Error("hostile");
      },
      enumerable: true,
    });
    const getterRoles = {
      schemaVersion: 2,
      hosts: { other: { transport: "local", worktreeRoot: "/w", roles } },
    };
    expect(() => moveLaneRunnerRole(getterRoles, "new")).not.toThrow();
    expect(moveLaneRunnerRole(getterRoles, "new").movedFrom).toEqual([]);

    // A throwing getter on roleAliases never runs; the value still comes back.
    let aliasInvocations = 0;
    const hostileAliases = {
      transport: "local",
      worktreeRoot: "/w",
      roles: ["lane-runner"],
      get roleAliases() {
        aliasInvocations += 1;
        throw new Error("hostile");
      },
    };
    const getterAliases = { schemaVersion: 2, hosts: { other: hostileAliases } };
    const guarded = moveLaneRunnerRole(getterAliases, "new");
    expect(aliasInvocations).toBe(0);
    expect(guarded.movedFrom).toEqual([]);
    expect(guarded.value).toBe(getterAliases);

    // A non-plain host entry is skipped, never spread.
    class HostileHost {
      roles = ["lane-runner"];
    }
    const classHosts = {
      schemaVersion: 2,
      hosts: { other: new HostileHost() },
    };
    expect(() => moveLaneRunnerRole(classHosts, "new")).not.toThrow();
    expect(moveLaneRunnerRole(classHosts, "new").movedFrom).toEqual([]);
  });

  it("moveLaneRunnerRole does not change another host's roles or role aliases", () => {
    const current = {
      schemaVersion: 2,
      hosts: {
        other: {
          transport: "local",
          worktreeRoot: "/w",
          roles: ["orchestrator", "lane-runner"],
          roleAliases: { orchestrator: "o", "lane-runner": "l" },
        },
        sole: {
          transport: "local",
          worktreeRoot: "/w",
          roles: ["lane-runner"],
          roleAliases: { "lane-runner": "only" },
        },
      },
    };
    const moved = moveLaneRunnerRole(current, "new");
    expect(moved.movedFrom).toEqual([]);
    expect(moved.value).toBe(current);
    expect(moved.refused).toBeUndefined();
    const hosts = (moved.value as { hosts: Record<string, Record<string, unknown>> }).hosts;
    expect(hosts.other.roles).toEqual(["orchestrator", "lane-runner"]);
    expect(hosts.other.roleAliases).toEqual({
      orchestrator: "o",
      "lane-runner": "l",
    });
    expect(hosts.sole.roles).toEqual(["lane-runner"]);
    expect(hosts.sole.roleAliases).toEqual({ "lane-runner": "only" });
  });
});

describe("moveLaneRunnerRole host-map accessors (Luna pre-merge round)", () => {
  it("refuses an accessor on the host map, returns the same value, and does not run the getter", () => {
    let invoked = 0;
    const hosts: Record<string, unknown> = {
      holder: {
        transport: "local",
        worktreeRoot: "/srv/w",
        roles: ["orchestrator", "lane-runner"],
      },
    };
    Object.defineProperty(hosts, "hostile", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("hostile getter ran");
      },
    });
    const current = { schemaVersion: 2, hosts };
    let result: ReturnType<typeof moveLaneRunnerRole> | undefined;
    expect(() => {
      result = moveLaneRunnerRole(current, "new");
    }).not.toThrow();
    expect(invoked).toBe(0);
    expect(result?.movedFrom).toEqual([]);
    expect(result?.value).toBe(current);
    expect(result?.refused).toBe("accessor");
  });
});

describe("hosts commands screen every host-map key (Fable re-check round)", () => {
  function fixture(key: string, extra: Record<string, unknown> = {}) {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: path.join(dir, "wt"),
          roles: ["orchestrator"],
        },
        [key]: {
          transport: "ssh",
          sshAlias: "old",
          worktreeRoot: path.join(dir, "old"),
          roles: ["verifier", "lane-runner"],
          roleAliases: { "lane-runner": "old-lr", verifier: "old-v" },
          runner: { kind: "opencode", port: 4200 },
        },
        ...extra,
      },
    });
    return { dir, file };
  }

  it("a secret-shaped sole lane-runner key never reaches stdout or stderr when the role moves", async () => {
    const key = ["ghp", "_" + "a1".repeat(18)].join("");
    const { dir, file } = fixture(key);
    const moved = await runHosts(
      ["add", "newhost", "--role", "lane-runner", "--worktree-root", path.join(dir, "n"), "--port", "1", "--yes"],
      file,
    );
    expect(moved.stdout + moved.stderr).not.toContain(key);
    const refused = await runHosts(
      ["add", "newhost", "--role", "lane-runner", "--worktree-root", "relative", "--port", "1", "--yes"],
      file,
    );
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).not.toContain(key);
  });

  it("a bare-alphanumeric-run key such as a slack-shaped one is screened in notices, list and loader errors", async () => {
    // A secret-shaped key is refused by the loader (HN1); the notices screen
    // a key it accepts: a long opaque alphanumeric run.
    const key = ["Zq", "9x".repeat(12)].join("");
    const { dir, file } = fixture(key);
    const listed = await runHosts(["list"], file);
    expect(listed.stdout + listed.stderr).not.toContain(key);
    expect(listed.stdout).toContain(HOST_KEY_WITHHELD);
    const moved = await runHosts(
      ["add", "newhost", "--role", "lane-runner", "--worktree-root", path.join(dir, "n"), "--port", "1", "--yes"],
      file,
    );
    expect(moved.code).toBe(0);
    expect(moved.stdout + moved.stderr).not.toContain(key);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts[key]?.roles).toEqual(["verifier", "lane-runner"]);
    expect(
      formatRoleAmbiguousRefusal("verifier", [key, "ok-host"]),
    ).not.toContain(key);
  });

  it("printed loader errors screen host-map keys", async () => {
    const key = ["ghp", "_" + "a1".repeat(18)].join("");
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: { [key]: { transport: "carrier-pigeon", worktreeRoot: "/w", roles: ["orchestrator"] } },
    });
    for (const argv of [["list"], ["show"], ["remove", "x", "--yes"]]) {
      const result = await runHosts(argv, file);
      expect(result.stdout + result.stderr).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts rename", () => {
  const githubToken = `ghp_${'a'.repeat(20)}`;
  const awsKey = `AKIA${'A'.repeat(16)}`;
  const slackToken = `xoxb-${'a'.repeat(10)}`;
  const apiKey = `sk-${'a'.repeat(20)}`;

  const sha256 = (text: string): string =>
    createHash("sha256").update(text).digest("hex");

  /** A v2 file the loader refuses only because the lane-runner key is the GitHub token. */
  function secretKeyInstallation(): unknown {
    return {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: "/srv/fleet/mac",
          roles: ["orchestrator"],
          runner: { kind: "opencode", port: 46000 },
        },
        [githubToken]: {
          transport: "ssh",
          sshAlias: "lane-alias",
          container: "fleet-runner",
          roleAliases: { "lane-runner": "lane-alias" },
          worktreeRoot: "/srv/fleet/lane",
          tmpDir: "/srv/fleet/tmp",
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 4166, tunnelOffset: 1 },
        },
      },
    };
  }

  /** A loader-valid two-host v2 file for the same-name refusal. */
  function cleanTwoHostInstallation(): unknown {
    return {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot: "/srv/fleet/mac",
          roles: ["orchestrator"],
          runner: { kind: "opencode", port: 46000 },
        },
        "lane-host": {
          transport: "ssh",
          sshAlias: "lane-alias",
          worktreeRoot: "/srv/fleet/lane",
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 4166 },
        },
      },
    };
  }

  it("loader refusal reaches hosts list with no echo", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());
    const { code, stdout, stderr } = await runHosts(["list"], file);
    expect(code).toBe(1);
    expect(stderr).toContain(HOST_NAME_SECRET_REFUSAL);
    expect(stdout + stderr).not.toContain(githubToken);
  });

  it("hosts add refuses a secret-shaped name and does not echo it", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(["add", githubToken, "--yes"], file);
    expect(code).toBe(1);
    expect(stderr).toContain(HOST_NAME_SECRET_REFUSAL);
    expect(stderr).not.toContain(githubToken);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("rename on a secret-shaped key makes the loader accept the file", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = secretKeyInstallation() as {
      hosts: Record<string, unknown>;
    };
    writeJsonFile(file, installation);
    const before = readFileSync(file, "utf8");
    const expectedHash = sha256(before);
    const screened = `host:${sha256(githubToken).slice(0, 12)}`;
    const digest = sha256(
      JSON.stringify({ expectedHash, newName: "lane-host", oldName: githubToken }),
    );
    const { code, stdout, stderr } = await runHosts(
      ["rename", githubToken, "lane-host", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(screened);
    expect(stdout).toContain("to lane-host");
    expect(stdout).toContain(`request:${digest}`);
    expect(stdout + stderr).not.toContain(githubToken);
    expect(stdout + stderr).not.toContain(file);

    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const hosts = parsed.installation.hosts ?? {};
    expect(Object.hasOwn(hosts, githubToken)).toBe(false);
    expect(Object.hasOwn(hosts, "lane-host")).toBe(true);
    expect(hosts["lane-host"]?.sshAlias).toBe("lane-alias");
    expect(hosts["lane-host"]?.container).toBe("fleet-runner");
    expect(hosts["lane-host"]?.roleAliases).toEqual({
      "lane-runner": "lane-alias",
    });
    expect(hosts["lane-host"]?.tmpDir).toBe("/srv/fleet/tmp");
    expect(hosts["lane-host"]?.worktreeRoot).toBe("/srv/fleet/lane");
    expect(hosts["lane-host"]?.roles).toEqual(["lane-runner"]);
    expect(hosts["lane-host"]?.runner).toEqual({
      kind: "opencode",
      port: 4166,
      tunnelOffset: 1,
    });
    expect(hosts.mac).toEqual(installation.hosts.mac);
  });

  it("rename refusals", async () => {
    const runRefusal = async (
      argv: readonly string[],
      file: string,
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      const before = readFileSync(file, "utf8");
      const result = await runHosts([...argv, "--yes"], file);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("request:");
      expect(readFileSync(file, "utf8")).toBe(before);
      return result;
    };

    {
      const dir = makeTempDir();
      const file = path.join(dir, "fleet.json");
      writeJsonFile(file, secretKeyInstallation());
      const { stderr } = await runRefusal(["rename", githubToken, "a..b"], file);
      expect(stderr).toContain("the new host name is not a valid host name");
    }
    {
      const dir = makeTempDir();
      const file = path.join(dir, "fleet.json");
      writeJsonFile(file, secretKeyInstallation());
      const { stderr } = await runRefusal(["rename", githubToken, apiKey], file);
      expect(stderr).toContain(HOST_NAME_SECRET_REFUSAL);
      expect(stderr).not.toContain(apiKey);
    }
    {
      const dir = makeTempDir();
      const file = path.join(dir, "fleet.json");
      writeJsonFile(file, secretKeyInstallation());
      const { stderr } = await runRefusal(["rename", githubToken, "mac"], file);
      expect(stderr).toContain("already a host");
    }
    {
      const dir = makeTempDir();
      const file = path.join(dir, "fleet.json");
      writeJsonFile(file, secretKeyInstallation());
      const { stderr } = await runRefusal(["rename", "nosuch", "lane-host"], file);
      expect(stderr).toContain("no host has that name");
    }
    {
      const dir = makeTempDir();
      const file = path.join(dir, "fleet.json");
      writeJsonFile(file, cleanTwoHostInstallation());
      const { stderr } = await runRefusal(["rename", "lane-host", "lane-host"], file);
      expect(stderr).toContain("the same as the current name");
    }
  });

  it("F96-3 a second rename does not write again", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());
    const first = await runHosts(["rename", githubToken, "lane-host", "--yes"], file);
    expect(first.code).toBe(0);
    const afterFirst = readFileSync(file, "utf8");

    const second = await runHosts(["rename", githubToken, "lane-host", "--yes"], file);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("no host has that name");
    expect(second.stdout + second.stderr).not.toContain(githubToken);
    expect(readFileSync(file, "utf8")).toBe(afterFirst);

    const declinedDir = makeTempDir();
    const declinedFile = path.join(declinedDir, "fleet.json");
    writeJsonFile(declinedFile, secretKeyInstallation());
    const original = readFileSync(declinedFile, "utf8");
    const declined = await runHosts(
      ["rename", githubToken, "lane-host"],
      declinedFile,
      {},
      async () => false,
    );
    expect(declined.code).toBe(1);
    expect(declined.stderr).toContain("not confirmed; nothing was written");
    expect(declined.stdout + declined.stderr).not.toContain("request:");
    expect(readFileSync(declinedFile, "utf8")).toBe(original);

    const racedDir = makeTempDir();
    const racedFile = path.join(racedDir, "fleet.json");
    writeJsonFile(racedFile, secretKeyInstallation());
    const racedBytes =
      `${JSON.stringify({ schemaVersion: 2, forge: { mode: "none" }, hosts: {} }, null, 2)}\n`;
    const raced = await runHosts(
      ["rename", githubToken, "lane-host"],
      racedFile,
      {},
      async () => {
        writeFileSync(racedFile, racedBytes, "utf8");
        return true;
      },
    );
    expect(raced.code).toBe(1);
    expect(raced.stderr).toContain("installation: changed");
    expect(raced.stderr).not.toContain(githubToken);
    expect(readFileSync(racedFile, "utf8")).toBe(racedBytes);
  });

  it("F96-4 an unreadable or non-JSON file is not an empty rename", async () => {
    const dir = makeTempDir();
    const asDirectory = await runHosts(["rename", "a", "b", "--yes"], dir);
    expect(asDirectory.code).toBe(1);
    expect(asDirectory.stderr).toContain("installation: unreadable");
    expect(asDirectory.stdout + asDirectory.stderr).not.toContain("request:");

    const file = path.join(dir, "fleet.json");
    writeFileSync(file, "not-json", "utf8");
    const notJson = await runHosts(["rename", "a", "b", "--yes"], file);
    expect(notJson.code).toBe(1);
    expect(notJson.stderr).toContain("installation: invalid");
    expect(notJson.stdout + notJson.stderr).not.toContain("request:");
  });

  it("F96-2 rename makes no forge, git, journal or network call", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());
    const { code, calls } = await runHosts(
      ["rename", githubToken, "lane-host", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("F96-6 rename does not invoke git", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());
    const { code, calls } = await runHosts(
      ["rename", githubToken, "lane-host", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("F96-5 no secret-shaped text and no path in rename or loader output", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());

    const list = await runHosts(["list"], file);
    expect(list.code).toBe(1);
    const listOutput = list.stdout + list.stderr;
    expect(listOutput).not.toContain(githubToken);
    expect(listOutput).not.toContain(awsKey);
    expect(listOutput).not.toContain(slackToken);
    expect(listOutput).not.toContain(apiKey);
    expect(listOutput).not.toContain(file);

    const rename = await runHosts(["rename", githubToken, "lane-host", "--yes"], file);
    expect(rename.code).toBe(0);
    const renameOutput = rename.stdout + rename.stderr;
    expect(renameOutput).not.toContain(githubToken);
    expect(renameOutput).not.toContain(awsKey);
    expect(renameOutput).not.toContain(slackToken);
    expect(renameOutput).not.toContain(apiKey);
    expect(renameOutput).not.toContain(file);
  });

  it("F96-8 rename carries the full request digest", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, secretKeyInstallation());
    const before = readFileSync(file, "utf8");
    const expectedHash = sha256(before);
    const digest = sha256(
      JSON.stringify({ expectedHash, newName: "lane-host", oldName: githubToken }),
    );
    const { code, stdout } = await runHosts(
      ["rename", githubToken, "lane-host", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(`request:${digest}`);
  });

  it("help lists rename", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const { code, stdout } = await runHosts(["--help"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("rename <old> <new>");
  });

  it("the fakes are valid host names and secret-shaped", () => {
    for (const fake of [githubToken, awsKey, slackToken, apiKey]) {
      expect(fake.length).toBeLessThan(128);
      expect(isValidHostName(fake)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// HN1 fix round 1: host keys are never echoed
// ---------------------------------------------------------------------------

/** Every window of twenty characters or more of `key` that `text` contains. */
function echoedWindows(text: string, key: string): string[] {
  const echoed: string[] = [];
  for (let start = 0; start < key.length; start += 1) {
    for (let end = start + 20; end <= key.length; end += 1) {
      const window = key.slice(start, end);
      if (text.includes(window) && !echoed.includes(window)) {
        echoed.push(window);
      }
    }
  }
  return echoed;
}

describe("hosts output never echoes a withheld host key", () => {
  // A valid dotted key the loader accepts, carrying a long opaque token run.
  const tokenRunKey = "x.abcdefghijklmnopqrstuvwxyz0123456789";
  // A flat 36-character alphanumeric key, the shape of an opaque token.
  // Built at runtime so the fixture is not a literal secret-scanner match (gitleaks generic-api-key).
  const flatTokenKey = "abcdefghij0123456789".repeat(2).slice(0, 36);

  function installationWithTokenKeys(worktreeRoot: string): unknown {
    return {
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        mac: {
          transport: "local",
          worktreeRoot,
          roles: ["orchestrator", "lane-runner"],
          runner: { kind: "opencode", port: 46000 },
        },
        [flatTokenKey]: {
          transport: "ssh",
          sshAlias: "lane-alias",
          worktreeRoot: `${worktreeRoot}/lane`,
          roles: ["lane-runner"],
          runner: { kind: "opencode", port: 4166 },
        },
      },
    };
  }

  it("hosts list discloses nothing of a malformed host under a token-run key", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = installationWithTokenKeys(
      path.join(dir, "worktrees"),
    ) as { hosts: Record<string, unknown> };
    // The malformed entry: the loader refuses it and names the host key.
    installation.hosts[tokenRunKey] = "not-an-object";
    writeJsonFile(file, installation);
    const { code, stdout, stderr } = await runHosts(["list"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("the installation file is invalid");
    expect(stderr).toContain("must be an object");
    expect(echoedWindows(stdout + stderr, tokenRunKey)).toEqual([]);
  });

  it("hosts list never prints a withheld key even when the file parses", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, installationWithTokenKeys(path.join(dir, "worktrees")));
    const { code, stdout } = await runHosts(["list"], file);
    expect(code).toBe(0);
    expect(echoedWindows(stdout, flatTokenKey)).toEqual([]);
    expect(stdout).toContain("<host key withheld>");
  });

  it("removing a host with a 36-character alphanumeric key prints no key", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, installationWithTokenKeys(path.join(dir, "worktrees")));
    const { code, stdout, stderr } = await runHosts(
      ["remove", flatTokenKey, "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    expect(stdout).toContain("-");
    expect(echoedWindows(stdout + stderr, flatTokenKey)).toEqual([]);
  });

  it("editing a host with a 36-character alphanumeric key prints no key", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, installationWithTokenKeys(path.join(dir, "worktrees")));
    const { code, stdout, stderr } = await runHosts(
      ["edit", flatTokenKey, "--port", "4167", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("written");
    expect(echoedWindows(stdout + stderr, flatTokenKey)).toEqual([]);
  });

  it("renaming a host whose root carries an own __proto__ key refuses and leaves the file unchanged", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    // Written as JSON text so the root gains an own "__proto__" data property.
    writeFileSync(
      file,
      `${JSON.stringify(
        installationWithTokenKeys(path.join(dir, "worktrees")),
        null,
        2,
      ).slice(0, -1)},"__proto__": {"injected": true}}\n`,
      "utf8",
    );
    const before = readFileSync(file, "utf8");
    expect(JSON.parse(before)).toEqual(
      expect.objectContaining({ schemaVersion: 2 }),
    );
    expect(Object.hasOwn(JSON.parse(before), "__proto__")).toBe(true);
    const { code, stderr } = await runHosts(
      ["rename", flatTokenKey, "renamed-host", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(stderr).not.toContain("renamed host");
  });

  // HN1b fix a: no thrown error escapes the screened io. A dependency's
  // failure is reported as exactly one screened line — the tag, the message's
  // first line, no stack — and the screen still withholds every secret.
  it("a thrown Error from a state reader prints one screened error line and no stack", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, installationWithTokenKeys(path.join(dir, "worktrees")));
    // Built at runtime so the fixture is not a literal secret-scanner match.
    const token = `s3cret${"xY9".repeat(11)}`.slice(0, 36);
    const spy = vi
      .spyOn(AttemptRepositoryAdapter.prototype, "listAllAttempts")
      .mockRejectedValue(
        new Error(
          `hosts.${flatTokenKey}: live-work read failed near token ${token}`,
        ),
      );
    try {
      const { code, stdout, stderr } = await runHosts(
        ["remove", flatTokenKey, "--yes"],
        file,
      );
      expect(code).toBe(1);
      const errorLines = stderr
        .split("\n")
        .filter((line) => line.startsWith("error: "));
      expect(errorLines).toHaveLength(1);
      expect(stderr).not.toContain("    at ");
      expect(echoedWindows(stdout + stderr, flatTokenKey)).toEqual([]);
      expect(echoedWindows(stdout + stderr, token)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a thrown non-Error prints error: unknown and nothing of the value", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, installationWithTokenKeys(path.join(dir, "worktrees")));
    const token = `s3cret${"xY9".repeat(11)}`.slice(0, 36);
    const spy = vi
      .spyOn(AttemptRepositoryAdapter.prototype, "listAllAttempts")
      .mockRejectedValue(`thrown string carrying token ${token}`);
    try {
      const { code, stdout, stderr } = await runHosts(
        ["remove", flatTokenKey, "--yes"],
        file,
      );
      expect(code).toBe(1);
      expect(stderr).toContain("error: unknown");
      expect(stderr).not.toContain("thrown string");
      expect(echoedWindows(stdout + stderr, token)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// HN1b fix round (a2): the installation-file resolution is inside the guard
// ---------------------------------------------------------------------------

describe("hosts installation-file resolution never escapes the screened io", () => {
  it("a throwing process.cwd() with no explicit file prints one screened error line", async () => {
    // Built at runtime so the fixture is not a literal secret-scanner match.
    const token = `t0k3n${"aB7".repeat(11)}`.slice(0, 36);
    const { io, stdout: rawStdout, stderr: rawStderr } = mockIo();
    const spy = vi
      .spyOn(process, "cwd")
      .mockImplementation(() => {
        throw new Error(`cwd lost near token ${token}`);
      });
    try {
      const code = await hostsCommand(["list"], io);
      const stdout = rawStdout.join("");
      const stderr = rawStderr.join("");
      expect(code).toBe(1);
      const errorLines = stderr
        .split("\n")
        .filter((line) => line.startsWith("error: "));
      expect(errorLines).toHaveLength(1);
      expect(stderr).not.toContain("    at ");
      expect(echoedWindows(stdout + stderr, token)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
