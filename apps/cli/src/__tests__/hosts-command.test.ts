/**
 * `fleet-v2 hosts` (lane H4): list, add, edit and remove on a real
 * installation file in a temp directory, with the host probe executor faked
 * (no ssh, no subprocess). The engine owns every rule, so these tests assert
 * the command's contract: exit codes (0 written, 1 refused, 2 usage), the
 * loader's own refusals, the v1→v2 conversion on the first write, the
 * lane-runner role move, live-work refusals on remove, the compare-and-swap
 * conflict and the help text.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type {
  DoctorCommandRunResult,
  HostProbeExecutor,
} from "@fleet/onboarding";
import { parseInstallation } from "@fleet/installation";
import {
  AttemptRepositoryAdapter,
  ExecutionJournalAdapter,
  type AttemptRecord,
  type CapacityReservationRecord,
} from "@fleet/work-execution";

import { runCli, type CliIo } from "../index.js";

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

/** A loader-valid two-host v2 installation: mac orchestrates, midnight runs lanes. */
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
      midnight: {
        transport: "ssh",
        sshAlias: "m",
        worktreeRoot: `${worktreeRoot}/midnight`,
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
      hostName: "midnight",
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
    hostId: "midnight",
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
      "midnight  ssh  alias m  roles: lane-runner  worktree-root:",
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
  it("writes a new host after the probe, diff and --yes", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = v2Installation(path.join(dir, "worktrees"));
    writeJsonFile(file, installation);
    const { code, stdout, calls } = await runHosts(
      [
        "add",
        "sunrise",
        "--ssh",
        "sunrise.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "sunrise"),
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
    expect(reachability?.[5]).toBe("sunrise.example");
    expect(reachability?.[6]).toBe("--");
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[]; runner?: { port: number } }>;
    };
    expect(parsed.hosts.sunrise?.roles).toEqual(["verifier"]);
    expect(parsed.hosts.sunrise?.runner?.port).toBe(47000);
    // The existing hosts are untouched.
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator", "verifier"]);
    expect(parsed.hosts.midnight?.roles).toEqual(["lane-runner"]);
  });

  it("refuses with exit 1 and writes nothing when a probe FAILs", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const before = readFileSync(file, "utf8");
    const { code, stdout, stderr } = await runHosts(
      [
        "add",
        "sunrise",
        "--ssh",
        "sunrise.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "sunrise"),
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
    expect(stdout).toContain("FAIL host sunrise reachable —");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("treats an unsafe ssh alias as a usage error (exit 2) and probes nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr, calls } = await runHosts(
      [
        "add",
        "sunrise",
        "--ssh",
        "-oProxyCommand=evil",
        "--worktree-root",
        path.join(dir, "sunrise"),
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

  it("moves the lane-runner role from the host that holds it and says so", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, singleMachineInstallation(path.join(dir, "worktrees")));
    const { code, stdout } = await runHosts(
      [
        "add",
        "midnight",
        "--ssh",
        "m",
        "--port",
        "4166",
        "--worktree-root",
        path.join(dir, "midnight"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "lanes now run on midnight (the lane-runner role moved from mac)",
    );
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.mac?.roles).toEqual(["orchestrator"]);
    expect(parsed.hosts.midnight?.roles).toEqual(["lane-runner"]);
  });

  it("refuses a name that is already in the file with the engine refusal", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stderr } = await runHosts(
      [
        "add",
        "midnight",
        "--ssh",
        "m",
        "--port",
        "4266",
        "--worktree-root",
        path.join(dir, "midnight"),
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
        "sunrise",
        "--ssh",
        "sunrise.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "sunrise"),
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
        "sunrise",
        "--ssh",
        "sunrise.example",
        "--port",
        "47000",
        "--worktree-root",
        path.join(dir, "sunrise"),
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
  it("changes the port and keeps what the flags leave out", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code, stdout } = await runHosts(
      ["edit", "midnight", "--port", "4266", "--yes"],
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
    expect(parsed.hosts.midnight?.runner?.port).toBe(4266);
    expect(parsed.hosts.midnight?.runner?.kind).toBe("opencode");
    expect(parsed.hosts.midnight?.sshAlias).toBe("m");
    expect(parsed.hosts.midnight?.roles).toEqual(["lane-runner"]);
  });

  it("edits the roles of an existing host", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    const { code } = await runHosts(
      ["edit", "midnight", "--role", "lane-runner,verifier", "--yes"],
      file,
    );
    expect(code).toBe(0);
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { roles: string[] }>;
    };
    expect(parsed.hosts.midnight?.roles).toEqual(["lane-runner", "verifier"]);
  });

  it("refuses a lane-runner move that would leave the other host with no role", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, v2Installation(path.join(dir, "worktrees")));
    // Moving the lane-runner role onto mac would leave midnight with no role;
    // the loader refuses the candidate with its own message.
    const { code, stderr } = await runHosts(
      ["edit", "mac", "--role", "orchestrator,verifier,lane-runner", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("the loader refuses this change");
    expect(stderr).toContain(
      "hosts.midnight.roles: at least one role is required",
    );
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
      ["remove", "midnight", "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("is the last lane-runner host");
  });

  it("refuses a host with a live attempt, and allows one that released capacity", async () => {
    const stateDir = makeTempDir();
    const file = path.join(stateDir, "fleet.json");
    const installation = v2Installation(path.join(stateDir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.sunrise = {
      transport: "ssh",
      sshAlias: "sunrise.example",
      worktreeRoot: path.join(stateDir, "sunrise"),
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
          host: "sunrise.example",
          hostName: "sunrise",
          agent: "lane",
          model: "provider/glm-5.3",
          variant: null,
        },
      }),
    );
    const argv = ["remove", "sunrise", "--yes", "--state-dir", stateDir];
    const refused = await runHosts(argv, file);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("attempt att-1 is running on sunrise");
    expect(refused.stderr).toContain("has live work; nothing was removed");
    // An attempt whose state is in CAPACITY_RELEASE_STATES no longer blocks.
    await attempts.saveAttempt(attemptRecord({ id: "att-1", state: "ended" }));
    const released = await runHosts(argv, file);
    expect(released.code).toBe(0);
  });

  it("refuses a host with an active reservation", async () => {
    const stateDir = makeTempDir();
    const file = path.join(stateDir, "fleet.json");
    const installation = v2Installation(path.join(stateDir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.sunrise = {
      transport: "ssh",
      sshAlias: "sunrise.example",
      worktreeRoot: path.join(stateDir, "sunrise"),
      roles: ["verifier"],
    };
    writeJsonFile(file, installation);
    const journal = new ExecutionJournalAdapter({ stateDir });
    await journal.saveCapacityReservation(
      heldReservation({ hostId: "sunrise" }),
    );
    const { code, stderr } = await runHosts(
      ["remove", "sunrise", "--yes", "--state-dir", stateDir],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "reservation res-1 holds a slot for attempt att-1 on sunrise",
    );
    expect(stderr).toContain("has live work; nothing was removed");
  });

  it("removes a verifier host, prints the leftover-forward hint and the single-machine note", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = v2Installation(path.join(dir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.sunrise = {
      transport: "ssh",
      sshAlias: "sunrise.example",
      worktreeRoot: path.join(dir, "sunrise"),
      roles: ["verifier"],
      runner: { kind: "opencode", port: 47000 },
    };
    writeJsonFile(file, installation);
    const { code, stdout } = await runHosts(
      ["remove", "sunrise", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "note: a leftover ssh -f -N forward for this host may still listen on 127.0.0.1:47001",
    );
    expect(stdout).toContain("pgrep -f 'ssh .*-L 127.0.0.1:47001'");
    // midnight is still ssh, so the installation is not single-machine.
    expect(stdout).not.toContain("single-machine again");
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, unknown>;
    };
    expect(parsed.hosts.sunrise).toBeUndefined();
    expect(parsed.hosts.midnight).toBeDefined();
  });

  it("notes when removing the last ssh host returns the install to single machine", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const installation = singleMachineInstallation(path.join(dir, "worktrees"));
    (installation as { hosts: Record<string, unknown> }).hosts.midnight = {
      transport: "ssh",
      sshAlias: "m",
      worktreeRoot: path.join(dir, "midnight"),
      roles: ["verifier"],
    };
    writeJsonFile(file, installation);
    const { code, stdout } = await runHosts(
      ["remove", "midnight", "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "the installation is single-machine again: no host is reached over ssh",
    );
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, unknown>;
    };
    expect(parsed.hosts.midnight).toBeUndefined();
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
    const noRoot = await runHosts(["add", "sunrise", "--yes"], file);
    expect(noRoot.code).toBe(2);
    expect(noRoot.stderr).toContain("hosts add requires --worktree-root");
    const badRole = await runHosts(
      [
        "add",
        "sunrise",
        "--worktree-root",
        path.join(dir, "sunrise"),
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
