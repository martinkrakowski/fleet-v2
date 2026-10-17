/**
 * `fleet-v2 init` (lane O10a) against a real installation file in a temp
 * directory, with the detection executor and doctor probes faked (no
 * subprocess for detection, no probes for doctor). These tests assert the
 * command's contract: the section 5 example command writes a file the
 * loader accepts with the isolation block as specified, an existing file
 * refuses without --force and its bytes are unchanged, nothing is written
 * without --yes, unknown flags are usage errors, and the credential
 * checklist lists paths without creating them.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { DoctorCommandExecutor, DoctorProbes } from "@fleet/onboarding";
import { parseInstallation } from "@fleet/installation";

import { runCli, type CliIo } from "../index.js";

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-init-command-"));
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

/** The detection environment: every platform tool present, tools signed in. */
function detectionExecutor(cwd: string): DoctorCommandExecutor {
  const table: Record<
    string,
    { exitCode: number; stdout?: string; stderr?: string }
  > = {
    "uname -s": { exitCode: 0, stdout: "Linux\n" },
    pwd: { exitCode: 0, stdout: `${cwd}\n` },
    "node --version": { exitCode: 0, stdout: "v20.11.0\n" },
    "yarn --version": { exitCode: 0, stdout: "4.1.0\n" },
    "git --version": { exitCode: 0, stdout: "git version 2.43.0\n" },
    "gh --version": { exitCode: 0, stdout: "gh version 2.50.0\n" },
    "sh -c true": { exitCode: 0 },
    "nc -h": { exitCode: 0, stdout: "usage: nc\n" },
    "curl --version": { exitCode: 0, stdout: "curl 8.5.0\n" },
    "ssh -V": { exitCode: 0, stderr: "OpenSSH_9.6\n" },
    "opencode --version": { exitCode: 0, stdout: "1.0.0\n" },
    "claude --version": { exitCode: 0, stdout: "1.0.0\n" },
    "claude auth status": { exitCode: 0, stdout: "signed in as someone\n" },
  };
  return {
    async run(argv) {
      const answer = table[argv.join(" ")];
      if (answer === undefined) {
        return {
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          error: "not probed",
        };
      }
      return {
        exitCode: answer.exitCode,
        signal: null,
        stdout: answer.stdout ?? "",
        stderr: answer.stderr ?? "",
      };
    },
  };
}

/** Full-accepting doctor probes: every line PASS. */
function passingDoctorProbes(): DoctorProbes {
  return {
    hostReachable: async () => true,
    commandAvailable: async () => true,
    toolVersion: async () => "1.0.0",
    fileMode: async () => 0o600,
    worktreeRootWritable: async () => true,
    ocmRunBinary: async () => ({
      path: "/repo/bin/ocm-run",
      sha256: "c".repeat(64),
    }),
    expectedOcmRunHash: async () => "c".repeat(64),
    seatProbe: async () => ({ outcome: "pass", reason: "answered" }),
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runInit(
  argv: readonly string[],
  directory: string,
  overrides: {
    doctorProbes?: DoctorProbes;
  } = {},
): Promise<RunResult> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(
    ["init", ...argv],
    io,
    undefined,
    undefined,
    undefined,
    {
      installationFile: path.join(directory, "installation", "fleet.json"),
      detectionExecutor: detectionExecutor(directory),
      doctorProbes: overrides.doctorProbes ?? passingDoctorProbes(),
    },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** The exact command from plan section 5; --shelf is absent and means local. */
const EXAMPLE_COMMAND = [
  "--profile",
  "single",
  "--tools",
  "opencode,claude",
  "--recommend",
  "--isolation",
  "none",
  "--forge",
  "none",
  "--yes",
];

describe("fleet-v2 init", () => {
  it("the section 5 example command writes a file that loads, with the isolation block as specified", async () => {
    const directory = makeTempDir();
    const result = await runInit(EXAMPLE_COMMAND, directory);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const file = path.join(directory, "installation", "fleet.json");
    expect(existsSync(file)).toBe(true);
    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
    const hosts = (parsed.ok ? parsed.installation.hosts : {}) as Record<
      string,
      { runner?: { capabilities?: Record<string, unknown> } }
    >;
    expect(hosts["this-machine"]?.runner?.capabilities).toEqual({
      networkEgressRestricted: false,
      cpuAndMemoryLimited: false,
      processTreeTermination: false,
      filesystemScope: "inherited-directory",
    });
    // The doctor engine ran and its lines were printed.
    expect(result.stdout).toMatch(/PASS installation schema/);
    expect(result.stdout).toContain(
      "dispatch will refuse until the declaration changes",
    );
  });

  it("refuses to overwrite an existing file without --force, and the bytes are unchanged", async () => {
    const directory = makeTempDir();
    const file = path.join(directory, "installation", "fleet.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"original": true}\n', "utf8");
    const before = readFileSync(file, "utf8");
    const result = await runInit(EXAMPLE_COMMAND, directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--force");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("overwrites an existing file only with --force", async () => {
    const directory = makeTempDir();
    const file = path.join(directory, "installation", "fleet.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"original": true}\n', "utf8");
    const result = await runInit([...EXAMPLE_COMMAND, "--force"], directory);
    expect(result.code).toBe(0);
    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
  });

  it("without --yes prints the plan and writes nothing", async () => {
    const directory = makeTempDir();
    const file = path.join(directory, "installation", "fleet.json");
    const result = await runInit(
      EXAMPLE_COMMAND.filter((token) => token !== "--yes"),
      directory,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`would write ${file}`);
    expect(result.stdout).toContain("nothing was written");
    expect(existsSync(file)).toBe(false);
  });

  it("rejects an unknown flag and a missing required flag with exit 2", async () => {
    const directory = makeTempDir();
    const unknown = await runInit(
      [...EXAMPLE_COMMAND.slice(0, -1), "--wat"],
      directory,
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("--wat");
    const missing = await runInit(
      [
        "--profile",
        "single",
        "--tools",
        "opencode,claude",
        "--recommend",
        "--forge",
        "none",
        "--shelf",
        "local",
        "--yes",
      ],
      directory,
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--isolation is required");
  });

  it("prints the credential checklist and creates no credential file", async () => {
    const directory = makeTempDir();
    const result = await runInit(
      [
        "--profile",
        "single",
        "--tools",
        "claude-code",
        "--isolation",
        "container",
        "--forge",
        "github",
        "--forgeRepo",
        "owner/repo",
        "--shelf",
        "local",
        "--yes",
      ],
      directory,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "credential checklist (nothing is created)",
    );
    expect(result.stdout).toContain("gh auth status");
    // Only the installation file exists; the checklist created nothing.
    const listing = readFileSync(
      path.join(directory, "installation", "fleet.json"),
      "utf8",
    );
    expect(listing).toContain('"forge"');
  });

  it("needs --hosts for the multi profile and drafts the answered hosts", async () => {
    const directory = makeTempDir();
    const missing = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--shelf",
        "local",
      ],
      directory,
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--hosts");
    const result = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "container",
        "--forge",
        "none",
        "--shelf",
        "local",
        "--hosts",
        JSON.stringify([
          {
            name: "head",
            transport: "local",
            worktreeRoot: path.join(directory, "worktrees"),
            roles: ["orchestrator", "verifier"],
          },
          {
            name: "lane",
            transport: "local",
            worktreeRoot: path.join(directory, "worktrees"),
            roles: ["lane-runner"],
            runner: { kind: "opencode", port: 4166 },
          },
        ]),
        "--yes",
      ],
      directory,
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const parsed = parseInstallation(
      JSON.parse(
        readFileSync(
          path.join(directory, "installation", "fleet.json"),
          "utf8",
        ),
      ),
    );
    expect(parsed.ok).toBe(true);
    const hosts = (parsed.ok ? parsed.installation.hosts : {}) as Record<
      string,
      { runner?: { capabilities?: Record<string, unknown> } }
    >;
    expect(Object.keys(hosts).sort()).toEqual(["head", "lane"]);
    expect(hosts.lane?.runner?.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    });
  });

  it("names a multi-profile authFile in the checklist and creates nothing", async () => {
    const directory = makeTempDir();
    const authFile = path.join(directory, "opencode auth");
    const result = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--hosts",
        JSON.stringify([
          {
            name: "head",
            transport: "local",
            worktreeRoot: path.join(directory, "worktrees"),
            roles: ["orchestrator", "lane-runner"],
            runner: { kind: "opencode", port: 46000, authFile },
          },
        ]),
      ],
      directory,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "credential checklist (nothing is created)",
    );
    // The checklist names the authFile in a quoted chmod command…
    expect(result.stdout).toContain(`chmod 600 '${authFile}'`);
    // …and nothing created it.
    expect(existsSync(authFile)).toBe(false);
  });

  it("refuses a --hosts draft that is not the draft shape with exit 2", async () => {
    const directory = makeTempDir();
    const draft = {
      name: "head",
      transport: "local",
      worktreeRoot: "/w",
      roles: ["orchestrator"],
    };
    const bad = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--hosts",
        JSON.stringify([{ ...draft, extra: 1 }]),
      ],
      directory,
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown key 'extra'");
    expect(bad.stderr).toContain("expected keys:");

    const notAnObject = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--hosts",
        JSON.stringify(["head"]),
      ],
      directory,
    );
    expect(notAnObject.code).toBe(2);
    expect(notAnObject.stderr).toContain("is not a host draft object");

    const noName = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--hosts",
        JSON.stringify([{ ...draft, name: 7 }]),
      ],
      directory,
    );
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain("a string 'name'");

    const noRoles = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--hosts",
        JSON.stringify([{ ...draft, roles: undefined }]),
      ],
      directory,
    );
    expect(noRoles.code).toBe(2);
    expect(noRoles.stderr).toContain("'roles' array");

    const badWorktree = await runInit(
      [
        "--profile",
        "multi",
        "--tools",
        "claude",
        "--isolation",
        "none",
        "--forge",
        "none",
        "--hosts",
        JSON.stringify([{ ...draft, worktreeRoot: 7 }]),
      ],
      directory,
    );
    expect(badWorktree.code).toBe(2);
    expect(badWorktree.stderr).toContain("a string 'worktreeRoot'");
  });
});
