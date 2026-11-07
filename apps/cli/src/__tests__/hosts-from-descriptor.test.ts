/**
 * `fleet-v2 hosts add --from-descriptor` (lane H13): the command reads a
 * host descriptor file whose allow-listed fields become the draft — port,
 * worktree root, runner and capabilities. The operator still supplies the
 * alias and the roles. These tests assert the command's contract: exit codes,
 * the refusals (unknown field, unreadable file, non-JSON, the flag
 * combination, edit not accepting the flag, a probe FAIL), and the
 * version-override rule.
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
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-hosts-descriptor-"));
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

/** The descriptor fixture: an opencode runner with declared capabilities. */
function descriptorFixture(worktreeRoot: string): Record<string, unknown> {
  return {
    port: 4166,
    worktreeRoot,
    tools: [{ name: "opencode", version: "1.2.3" }],
    capabilities: {
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    },
  };
}

/** A loader-valid single-host v2 installation: mac orchestrates and runs lanes. */
function baseInstallation(worktreeRoot: string): unknown {
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
}

/**
 * The faked probe executor, mirroring `hosts-command.test.ts`: every argv is
 * recorded, `mktemp` answers with a path inside the worktree root it was
 * given, and everything else succeeds with a version-answer stdout.
 */
function fakeExecutor(behaviour: FakeExecutorBehaviour = {}): {
  executor: HostProbeExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    executor: {
      async run(argv): Promise<DoctorCommandRunResult> {
        calls.push([...argv]);
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

/** One hosts invocation against a real file; the probe executor is always faked. */
async function runHosts(
  argv: readonly string[],
  installationFile: string,
  behaviour: FakeExecutorBehaviour = {},
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
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), calls };
}

// ---------------------------------------------------------------------------
// add --from-descriptor
// ---------------------------------------------------------------------------

describe("fleet-v2 hosts add --from-descriptor", () => {
  it("writes a host with the descriptor's worktree root, port and capabilities", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const worktreeRoot = path.join(dir, "lanehost");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeJsonFile(descriptorFile, descriptorFixture(worktreeRoot));
    const { code, stdout, calls } = await runHosts(
      [
        "add",
        "lanehost",
        "--from-descriptor",
        descriptorFile,
        "--ssh",
        "m",
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
    expect(reachability?.[5]).toBe("m");
    expect(reachability?.[6]).toBe("--");
    const parsed = readInstallationFile(file) as {
      hosts: Record<
        string,
        {
          transport: string;
          sshAlias?: string;
          worktreeRoot: string;
          roles: string[];
          runner: {
            kind: string;
            port: number;
            capabilities: Record<string, unknown>;
          };
        }
      >;
    };
    const host = parsed.hosts.lanehost;
    expect(host.worktreeRoot).toBe(worktreeRoot);
    expect(host.transport).toBe("ssh");
    expect(host.sshAlias).toBe("m");
    expect(host.roles).toEqual(["lane-runner"]);
    expect(host.runner.kind).toBe("opencode");
    expect(host.runner.port).toBe(4166);
    expect(host.runner.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    });
  });

  it("refuses an unknown descriptor field with exit 1 and writes nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeJsonFile(descriptorFile, {
      ...descriptorFixture(path.join(dir, "lanehost")),
      os: "linux",
    });
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      ["add", "lanehost", "--from-descriptor", descriptorFile, "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("the descriptor is refused:");
    expect(stderr).toContain("unknown key");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a missing descriptor file with exit 1 and writes nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const before = readFileSync(file, "utf8");
    const { code } = await runHosts(
      [
        "add",
        "lanehost",
        "--from-descriptor",
        path.join(dir, "nope.json"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("names no descriptor path when the file cannot be read", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorPath = path.join(dir, "nope.json");
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      ["add", "lanehost", "--from-descriptor", descriptorPath, "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("the host descriptor file could not be read");
    expect(stderr).not.toContain(descriptorPath);
    expect(stderr).not.toContain(dir);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a descriptor file that is not JSON", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeFileSync(descriptorFile, "not json at all", "utf8");
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      ["add", "lanehost", "--from-descriptor", descriptorFile, "--yes"],
      file,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("not JSON");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("exits 2 when --from-descriptor is combined with --port", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeJsonFile(descriptorFile, descriptorFixture(path.join(dir, "lanehost")));
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      [
        "add",
        "lanehost",
        "--from-descriptor",
        descriptorFile,
        "--port",
        "47000",
        "--yes",
      ],
      file,
    );
    expect(code).toBe(2);
    expect(stderr).toContain("--port cannot be given with it");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("exits 2 when --from-descriptor is combined with --worktree-root", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeJsonFile(descriptorFile, descriptorFixture(path.join(dir, "lanehost")));
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      [
        "add",
        "lanehost",
        "--from-descriptor",
        descriptorFile,
        "--worktree-root",
        path.join(dir, "other"),
        "--yes",
      ],
      file,
    );
    expect(code).toBe(2);
    expect(stderr).toContain(
      "--worktree-root and --port cannot be given with it",
    );
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("exits 2 when edit receives --from-descriptor", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeJsonFile(descriptorFile, descriptorFixture(path.join(dir, "lanehost")));
    const before = readFileSync(file, "utf8");
    const { code, stderr } = await runHosts(
      ["edit", "mac", "--from-descriptor", descriptorFile, "--yes"],
      file,
    );
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown hosts edit option: --from-descriptor");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses on a probe FAIL even when the descriptor is otherwise valid", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    writeJsonFile(descriptorFile, descriptorFixture(path.join(dir, "lanehost")));
    const before = readFileSync(file, "utf8");
    const { code, stdout, stderr } = await runHosts(
      ["add", "lanehost", "--from-descriptor", descriptorFile, "--yes"],
      file,
      { failWhen: (argv) => argv.includes("true") },
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "refused: a probe reported FAIL; nothing was written",
    );
    expect(stdout).toContain("FAIL host lanehost reachable —");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("prints the override line when the measured opencode version differs from the claim", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, baseInstallation(path.join(dir, "worktrees")));
    const descriptorFile = path.join(dir, "host.json");
    // The fake executor measures "tool 1.0.0"; the descriptor claims 1.2.3.
    writeJsonFile(descriptorFile, descriptorFixture(path.join(dir, "lanehost")));
    const { code, stdout } = await runHosts(
      ["add", "lanehost", "--from-descriptor", descriptorFile, "--yes"],
      file,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "the descriptor's claimed opencode version does not match the measured one; the measured version stands",
    );
    // The file carries no version field; the claim is never written.
    const parsed = readInstallationFile(file) as {
      hosts: Record<string, { runner?: { version?: unknown } }>;
    };
    expect(parsed.hosts.lanehost?.runner?.version).toBeUndefined();
  });
});
