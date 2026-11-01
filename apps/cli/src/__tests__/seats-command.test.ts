/**
 * `fleet-v2 seats free-tier` (lane FS4, part B): status, on and off on a
 * real installation file in a temp directory. The onboarding engine owns the
 * flag rules and the compare-and-swap write, so these tests assert the
 * command's contract: exit codes (0 written/shown/unchanged, 1 refused,
 * 2 usage), the exact status/impact lines, the diff, the confirm path, the
 * compare-and-swap conflict and the byte-for-byte F8 canonical form.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { DoctorProbes } from "@fleet/onboarding";
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
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-seats-command-"));
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

/** The same raw v2 file value as the engine's own tests. */
function fixture(
  policy?: Record<string, unknown>,
  reviewerChain?: string[],
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    forge: { mode: "none" },
    hosts: {
      host: {
        transport: "local",
        worktreeRoot: "/tmp/wt",
        roles: ["orchestrator", "lane-runner", "verifier"],
        runner: { kind: "opencode", port: 4166, maxLanes: 1 },
      },
    },
    seats: [
      {
        id: "free-impl",
        tool: "opencode",
        model: "acme/alpha-1",
        roles: ["implementer"],
        costClass: "free",
      },
      {
        id: "paid-impl",
        tool: "opencode",
        model: "acme/alpha-2",
        roles: ["implementer"],
        costClass: "paid",
      },
      {
        id: "free-rev",
        tool: "opencode",
        model: "acme/beta-1",
        roles: ["reviewer"],
        costClass: "free",
      },
      {
        id: "free-rev-2",
        tool: "opencode",
        model: "acme/beta-3",
        roles: ["reviewer"],
        costClass: "free",
      },
      {
        id: "paid-rev",
        tool: "opencode",
        model: "acme/beta-2",
        roles: ["reviewer"],
        costClass: "paid",
      },
    ],
    chains: {
      implementer: [{ seatId: "free-impl" }, { seatId: "paid-impl" }],
      reviewer: (reviewerChain ?? ["free-rev", "paid-rev"]).map((seatId) => ({
        seatId,
      })),
    },
    ...(policy !== undefined ? { policy } : {}),
  };
}

async function runSeats(
  argv: readonly string[],
  file: string,
  confirm?: (question: string) => Promise<boolean>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(
    ["seats", "free-tier", ...argv],
    io,
    undefined,
    undefined,
    undefined,
    undefined,
    { installationFile: file, ...(confirm !== undefined ? { confirm } : {}) },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function runSeatsRaw(
  argv: readonly string[],
  file: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(argv, io, undefined, undefined, undefined, undefined, {
    installationFile: file,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("fleet-v2 seats free-tier status", () => {
  it("a: reads an absent key as on and lists the free seats", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const { code, stdout } = await runSeats(["status"], file);
    expect(code).toBe(0);
    expect(stdout).toContain(
      "free-tier: on (policy.useFreeSeats absent; absent means on)",
    );
    expect(stdout).toContain("free seats (in use): free-impl, free-rev");
  });

  it("b: reads an explicit true", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture({ useFreeSeats: true }));
    const { code, stdout } = await runSeats(["status"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("free-tier: on (policy.useFreeSeats true)");
  });

  it("k: a v1 file reports on and cannot change", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 1,
      forge: { owner: "example-owner", repo: "example-repo" },
    });
    const { code, stdout } = await runSeats(["status"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("schema version 1");
  });
});

// ---------------------------------------------------------------------------
// on / off
// ---------------------------------------------------------------------------

describe("fleet-v2 seats free-tier on|off", () => {
  it("c: off then on restores a policy-less file byte for byte", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture());
    writeFileSync(file, original, "utf8");

    const off = await runSeats(["off", "--yes"], file);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("free-tier: on -> off");
    expect(off.stdout).toContain("seats disabled: free-impl, free-rev");
    expect(off.stdout).toContain("chains.implementer: 2 -> 1 seats in use");
    expect(
      off.stdout
        .split("\n")
        .some(
          (line) =>
            line.startsWith("+ ") && line.includes('"useFreeSeats": false'),
        ),
    ).toBe(true);
    expect(off.stdout).toContain(
      "takes effect for the API after it restarts; CLI dispatches use it at once",
    );

    const on = await runSeats(["on", "--yes"], file);
    expect(on.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(original);

    const status = await runSeats(["status"], file);
    expect(status.stdout).toContain("absent; absent means on");
  });

  it("d: a policy with other keys keeps them across the round trip", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture({ perLaneCostCeiling: 2 }));
    writeFileSync(file, original, "utf8");

    const off = await runSeats(["off", "--yes"], file);
    expect(off.code).toBe(0);
    const on = await runSeats(["on", "--yes"], file);
    expect(on.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("e: an explicit true is left alone by on, and renders to absent", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture({ useFreeSeats: true }));
    writeFileSync(file, original, "utf8");

    const on = await runSeats(["on", "--yes"], file);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain("free-tier is already on; nothing was written");
    expect(readFileSync(file, "utf8")).toBe(original);

    const off = await runSeats(["off", "--yes"], file);
    expect(off.code).toBe(0);
    const backOn = await runSeats(["on", "--yes"], file);
    expect(backOn.code).toBe(0);

    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      if (!isFleetInstallationV2(parsed.installation)) {
        throw new Error("expected a v2 file");
      }
      expect(parsed.installation.policy?.useFreeSeats).toBeUndefined();
    }
  });

  it("f: off on an already-off file is unchanged", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture({ useFreeSeats: false }));
    writeFileSync(file, original, "utf8");
    const { code, stdout } = await runSeats(["off", "--yes"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("free-tier is already off; nothing was written");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("g: refuses when a role would be left with no seat", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture(undefined, ["free-rev", "free-rev-2"]));
    writeFileSync(file, original, "utf8");
    let confirmCalls = 0;
    const { code, stderr } = await runSeats(["off"], file, async () => {
      confirmCalls += 1;
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "chains.reviewer: every seat is free and policy.useFreeSeats is false; add a paid or plan-quota seat",
    );
    expect(stderr).toContain("nothing was written");
    expect(confirmCalls).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("h: recovers a refused file with on", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(
      file,
      fixture({ useFreeSeats: false }, ["free-rev", "free-rev-2"]),
    );
    const { code } = await runSeats(["on", "--yes"], file);
    expect(code).toBe(0);
    const parsed = parseInstallation(JSON.parse(readFileSync(file, "utf8")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      if (!isFleetInstallationV2(parsed.installation)) {
        throw new Error("expected a v2 file");
      }
      expect(parsed.installation.policy?.useFreeSeats).toBeUndefined();
    }
  });

  it("i: a declined confirm refuses and writes nothing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const original = canonicalBytes(fixture());
    writeFileSync(file, original, "utf8");
    let question = "";
    const { code, stderr } = await runSeats(["off"], file, async (q) => {
      question = q;
      return false;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("not confirmed; nothing was written");
    expect(question).toContain("[y/N]");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("j: compare-and-swap refuses when the file changed while confirming", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const racer = fixture({ perLaneCostCeiling: 3 });
    const { code, stderr } = await runSeats(["off"], file, async () => {
      writeFileSync(file, canonicalBytes(racer), "utf8");
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("changed on disk since it was read");
    expect(readFileSync(file, "utf8")).toBe(canonicalBytes(racer));
  });

  it("k: a v1 file refuses off with a migration hint", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 1,
      forge: { owner: "example-owner", repo: "example-repo" },
    });
    const { code, stderr } = await runSeats(["off", "--yes"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("migrate to v2");
  });
});

// ---------------------------------------------------------------------------
// broken files
// ---------------------------------------------------------------------------

describe("fleet-v2 seats free-tier refuses broken files", () => {
  it("m: an unreadable installation file exits 1 without prompting or writing", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    mkdirSync(file);
    let confirmCalls = 0;
    const { code, stderr } = await runSeats(["off"], file, async () => {
      confirmCalls += 1;
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("could not be read");
    expect(confirmCalls).toBe(0);
    expect(readdirSync(dir)).toEqual(["fleet.json"]);
  });

  it("n: invalid JSON exits 1 without prompting and leaves the bytes unchanged", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const bytes = `{"schemaVersion": 2,\n`;
    writeFileSync(file, bytes, "utf8");
    let confirmCalls = 0;
    const { code, stderr } = await runSeats(["off"], file, async () => {
      confirmCalls += 1;
      return true;
    });
    expect(code).toBe(1);
    expect(stderr).toContain("invalid");
    expect(confirmCalls).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("o: a file that parses but fails the v2 schema exits 1 without prompting and leaves the bytes unchanged", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    const bytes = `${JSON.stringify({ schemaVersion: 2 }, null, 2)}\n`;
    writeFileSync(file, bytes, "utf8");
    let confirmCalls = 0;
    const { code, stderr } = await runSeats(["off"], file, async () => {
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

describe("fleet-v2 seats free-tier usage", () => {
  it("l: reports usage errors with exit 2", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());

    const noSubcommand = await runSeatsRaw(["seats"], file);
    expect(noSubcommand.code).toBe(2);

    const unknownAction = await runSeats(["maybe"], file);
    expect(unknownAction.code).toBe(2);

    const unknownFlag = await runSeats(["off", "--force"], file);
    expect(unknownFlag.code).toBe(2);

    const yesWithStatus = await runSeats(["status", "--yes"], file);
    expect(yesWithStatus.code).toBe(2);
  });

  it("l: a help token prints the help and exits 0", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const { code, stdout } = await runSeats(["--help"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: fleet-v2 seats free-tier");
  });
});

// ---------------------------------------------------------------------------
// list and check
// ---------------------------------------------------------------------------

/** The seat probe result the fake probes return for every seat. */
type FakeSeatOutcome =
  | { outcome: "pass"; reason: string }
  | { outcome: "fail"; reason: string }
  | { outcome: "unknown"; reason: string };

/** Full-accepting probes whose seat probe records calls and returns `outcome`. */
function fakeProbes(
  outcome: FakeSeatOutcome,
  calls?: string[],
): DoctorProbes {
  return {
    hostReachable: async () => true,
    commandAvailable: async () => true,
    toolVersion: async () => "1.0.0",
    fileMode: async () => 0o600,
    worktreeRootWritable: async () => true,
    ocmRunBinary: async () => ({ path: "/repo/bin/ocm-run", sha256: "c".repeat(64) }),
    expectedOcmRunHash: async () => "c".repeat(64),
    seatProbe: async () => {
      calls?.push("seatProbe");
      return outcome;
    },
  };
}

async function runSeatsGroup(
  argv: readonly string[],
  file: string,
  options: Record<string, unknown> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(argv, io, undefined, undefined, undefined, undefined, {
    installationFile: file,
    ...options,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("fleet-v2 seats list", () => {
  it("m: prints every seat of the v2 fixture in file order", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());

    const { code, stdout } = await runSeatsGroup(["seats", "list"], file);
    const lines = stdout.split("\n").filter((line) => line !== "");
    expect(code).toBe(0);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      "free-impl  tool=opencode model=acme/alpha-1 roles=implementer cost=free health=healthy",
    );
    expect(lines).toContain(
      "paid-rev  tool=opencode model=acme/beta-2 roles=reviewer cost=paid health=healthy",
    );
  });

  it("m: a v1 file prints the migration hint and exits 0", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeJsonFile(file, {
      schemaVersion: 1,
      forge: { owner: "example-owner", repo: "example-repo" },
    });

    const { code, stdout } = await runSeatsGroup(["seats", "list"], file);
    expect(code).toBe(0);
    expect(stdout).toContain(
      "schema version 1 has no seats section; migrate to v2",
    );
  });

  it("m: a missing file is refused with exit 1", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "absent", "fleet.json");

    const { code, stderr } = await runSeatsGroup(["seats", "list"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("no installation file; run fleet-v2 init first");
  });
});

describe("fleet-v2 seats check", () => {
  it("m: every seat probes PASS and the seat probe runs once per seat", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const calls: string[] = [];

    const { code, stdout } = await runSeatsGroup(["seats", "check"], file, {
      probes: fakeProbes({ outcome: "pass", reason: "answered" }, calls),
    });
    const lines = stdout.split("\n").filter((line) => line !== "");
    expect(code).toBe(0);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("PASS seat free-impl probe — answered");
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call === "seatProbe")).toBe(true);
  });

  it("m: a failing seat probe exits 1", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());
    const calls: string[] = [];

    const { code, stdout } = await runSeatsGroup(["seats", "check"], file, {
      probes: fakeProbes({ outcome: "fail", reason: "no answer" }, calls),
    });
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL seat free-impl probe — no answer");
    expect(calls).toHaveLength(5);
  });

  it("m: invalid JSON is refused before any probe runs", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeFileSync(file, `{"schemaVersion": 2,\n`, "utf8");
    const calls: string[] = [];

    const { code, stderr } = await runSeatsGroup(["seats", "check"], file, {
      probes: fakeProbes({ outcome: "pass", reason: "answered" }, calls),
    });
    expect(code).toBe(1);
    expect(stderr).toContain(`installation invalid (${file}):`);
    expect(calls).toHaveLength(0);
  });
});

describe("fleet-v2 seats group usage", () => {
  it("m: an unknown subcommand prints the group help to stderr and exits 2", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());

    const { code, stderr } = await runSeatsGroup(["seats", "bogus"], file);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown seats subcommand: bogus");
    expect(stderr).toContain(
      "Usage: fleet-v2 seats list | check | free-tier [status|on|off] [--yes]",
    );
  });

  it("m: --help prints the group help naming every subcommand and exits 0", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "fleet.json");
    writeCanonical(file, fixture());

    const { code, stdout } = await runSeatsGroup(["seats", "--help"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("list");
    expect(stdout).toContain("check");
    expect(stdout).toContain("free-tier");
  });
});
