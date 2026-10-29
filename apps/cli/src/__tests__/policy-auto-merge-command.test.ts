/**
 * `fleet-v2 policy auto-merge` (lane AM5-3): status, on and off on a real
 * installation file in a temp directory. The onboarding engine owns the block
 * rules and the compare-and-swap write, so these tests assert the command's
 * contract: exit codes (0 shown/written/unchanged, 1 refused, 2 usage), the
 * exact status/impact lines, the confirm path, the compare-and-swap conflict
 * and that off keeps the block's other two fields.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  isFleetInstallationV2,
  parseInstallation,
  writeInstallationV2,
} from "@fleet/installation";

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
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-policy-auto-merge-"));
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

/** The canonical v2 bytes a write would produce for a raw value. */
function canonicalBytes(value: unknown): string {
  const parsed = parseInstallation(value);
  if (!parsed.ok) {
    throw new Error(`fixture failed to parse: ${parsed.errors.join(", ")}`);
  }
  if (!isFleetInstallationV2(parsed.installation)) {
    throw new Error("fixture must be a v2 file");
  }
  return writeInstallationV2(parsed.installation);
}

function writeCanonical(filePath: string, value: unknown): void {
  writeFileSync(filePath, canonicalBytes(value), "utf8");
}

/** A minimal valid v2 installation; the optional policy block is written as-is. */
function fixture(policy?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    forge: { mode: "github", owner: "example-org", repo: "example-repo" },
    hosts: {
      local: {
        transport: "local",
        worktreeRoot: "/tmp/wt",
        roles: ["orchestrator", "lane-runner", "verifier"],
        runner: { kind: "opencode", port: 46000 },
      },
    },
    ...(policy !== undefined ? { policy } : {}),
  };
}

async function runPolicy(
  argv: readonly string[],
  file: string,
  confirm?: (question: string) => Promise<boolean>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(
    ["policy", "auto-merge", ...argv],
    io,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { installationFile: file, ...(confirm !== undefined ? { confirm } : {}) },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("fleet-v2 policy auto-merge status", () => {
  it("reports an absent block as off", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const { code, stdout } = await runPolicy(["status"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("auto-merge: off");
    expect(stdout).toContain("absent; absent means off");
  });

  it("reports an explicit on block", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(
      file,
      fixture({ autoMerge: { enabled: true, allowHighRisk: false, onBlocked: "ask-owner" } }),
    );
    const { code, stdout } = await runPolicy(["status"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("auto-merge: on");
  });

  it("reports a v1 file as off and unchangeable", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 1,
      forge: { owner: "example-owner", repo: "example-repo" },
    });
    const { code, stdout } = await runPolicy(["status"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("schema version 1");
  });
});

// ---------------------------------------------------------------------------
// on / off
// ---------------------------------------------------------------------------

describe("fleet-v2 policy auto-merge on|off", () => {
  it("on --yes writes the full block and a second on is already-on", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const first = await runPolicy(["on", "--yes"], file);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("auto-merge: off -> on");
    expect(first.stdout).toContain("takes effect for the API after it restarts; CLI attempts use it at once");
    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.installation.policy?.autoMerge).toEqual({
        enabled: true,
        allowHighRisk: false,
        onBlocked: "ask-owner",
      });
    }
    const second = await runPolicy(["on", "--yes"], file);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("auto-merge is already on; nothing was written");
  });

  it("a declined confirm refuses and writes nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture());
    writeFileSync(file, original, "utf8");
    let confirmCalls = 0;
    let question = "";
    const { code, stderr } = await runPolicy(["on"], file, async (q) => {
      confirmCalls += 1;
      question = q;
      return false;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("not confirmed; nothing was written");
    expect(question).toContain("[y/N]");
    expect(confirmCalls).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("compare-and-swap refuses when the file changed while confirming", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const racer = fixture({ perLaneCostCeiling: 3 });
    const { code, stderr } = await runPolicy(["on"], file, async () => {
      writeFileSync(file, canonicalBytes(racer), "utf8");
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("changed on disk since it was read");
    expect(readFileSync(file, "utf8")).toBe(canonicalBytes(racer));
  });

  it("off keeps the block's other two fields", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(
      file,
      fixture({ autoMerge: { enabled: true, allowHighRisk: true, onBlocked: "hold" } }),
    );
    const { code } = await runPolicy(["off", "--yes"], file);
    expect(code).toBe(0);
    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.installation.policy?.autoMerge).toEqual({
        enabled: false,
        allowHighRisk: true,
        onBlocked: "hold",
      });
    }
  });

  it("an absent file is already-off for off and refuses on", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const off = await runPolicy(["off", "--yes"], file);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("auto-merge is already off (no installation file)");
    const on = await runPolicy(["on", "--yes"], file);
    expect(on.code).toBe(1);
    expect(on.stderr).toContain("run fleet-v2 init first");
  });

  it("a v1 file refuses on with a migration hint and off is already-off", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 1,
      forge: { owner: "example-owner", repo: "example-repo" },
    });
    const on = await runPolicy(["on", "--yes"], file);
    expect(on.code).toBe(1);
    expect(on.stderr).toContain("migrate to v2");
    const off = await runPolicy(["off", "--yes"], file);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("auto-merge is already off (schema version 1)");
  });
});

// ---------------------------------------------------------------------------
// broken files
// ---------------------------------------------------------------------------

describe("fleet-v2 policy auto-merge refuses broken files", () => {
  it("an unreadable installation file exits 1 without prompting or writing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    mkdirSync(file);
    let confirmCalls = 0;
    const { code, stderr } = await runPolicy(["on"], file, async () => {
      confirmCalls += 1;
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("could not be read");
    expect(confirmCalls).toBe(0);
    expect(readdirSync(dir)).toEqual(["fleet.json"]);
  });

  it("invalid JSON exits 1 without prompting and leaves the bytes unchanged", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const bytes = `{"schemaVersion": 2,\n`;
    writeFileSync(file, bytes, "utf8");
    let confirmCalls = 0;
    const { code, stderr } = await runPolicy(["on"], file, async () => {
      confirmCalls += 1;
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("invalid");
    expect(confirmCalls).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe("fleet-v2 policy auto-merge usage", () => {
  it("reports usage errors with exit 2", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());

    const noAction = await runPolicy([], file);
    expect(noAction.code).toBe(2);

    const unknownAction = await runPolicy(["maybe"], file);
    expect(unknownAction.code).toBe(2);

    const unknownFlag = await runPolicy(["on", "--force"], file);
    expect(unknownFlag.code).toBe(2);

    const badHighRisk = await runPolicy(["on", "--allow-high-risk", "yes"], file);
    expect(badHighRisk.code).toBe(2);
    expect(badHighRisk.stderr).toContain("--allow-high-risk accepts only true or false");

    const badOnBlocked = await runPolicy(["on", "--on-blocked", "maybe"], file);
    expect(badOnBlocked.code).toBe(2);
    expect(badOnBlocked.stderr).toContain("--on-blocked accepts only ask-owner or hold");

    const yesWithStatus = await runPolicy(["status", "--yes"], file);
    expect(yesWithStatus.code).toBe(2);
  });

  it("a help token prints the help and exits 0", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const { code, stdout } = await runPolicy(["--help"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: fleet-v2 policy auto-merge");
  });
});
