// CLI tests for `lane diff-check` (CO34a): the exported command runs the
// pure `parseLaneDiffCliArgs` and the injected checker. The fake credential
// is assembled at run time from harmless parts; no matched value is ever
// asserted into an expected stream.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../index.js";
import { laneCommand, type LaneDiffChecker } from "../commands/lane.js";
import type {
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from "@fleet/work-execution";

const tok = `ghp_${"abcdefghij"}${"0123456789"}`;
const SHA = "a".repeat(40);

function capturingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
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

/** A fake checker that records its calls and answers from a script. */
function fakeChecker(
  answer: () => LaneDiffCheckResult | null,
): LaneDiffChecker & {
  trusted: LaneDiffCheckRequest[];
  baselineOff: { worktreePath: string; allowedPathPrefixes: readonly string[] }[];
} {
  const trusted: LaneDiffCheckRequest[] = [];
  const baselineOff: {
    worktreePath: string;
    allowedPathPrefixes: readonly string[];
  }[] = [];
  return {
    trusted,
    baselineOff,
    async checkLaneDiff(request) {
      trusted.push(request);
      return answer() as LaneDiffCheckResult;
    },
    async checkLaneDiffBaselineOff(request) {
      baselineOff.push(request);
      return answer() as LaneDiffCheckResult;
    },
  };
}

const READY_ARGV = [
  "/wt",
  "--allowed-path-prefixes",
  '["packages/x"]',
  "--base",
  SHA,
];

describe("lane diff-check command", () => {
  it("missing worktree exits 2 and does not call the checker", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    const code = await laneCommand(
      ["--allowed-path-prefixes", '["packages/x"]', "--base", SHA],
      io,
      checker,
    );
    expect(code).toBe(2);
    expect(stderr).toEqual(["lane diff-check: usage\n"]);
    expect(stdout).toEqual([]);
    expect(checker.trusted).toEqual([]);
    expect(checker.baselineOff).toEqual([]);
  });

  it("an absolute prefix exits 2 and the prefix text is absent", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    const code = await laneCommand(
      ["/wt", "--allowed-path-prefixes", '["/etc"]'],
      io,
      checker,
    );
    expect(code).toBe(2);
    expect(stderr).toEqual(["lane diff-check: usage\n"]);
    expect(`${stdout.join("")}${stderr.join("")}`).not.toContain("/etc");
    expect(checker.trusted).toEqual([]);
    expect(checker.baselineOff).toEqual([]);
  });

  it("an absent base warns once and is not a clean exit", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    const code = await laneCommand(
      ["/wt", "--allowed-path-prefixes", '["packages/x"]'],
      io,
      checker,
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([
      "lane diff-check: base is not a full commit sha; no base-line allowance\n",
    ]);
    expect(stdout).toEqual([]);
    expect(checker.trusted).toEqual([]);
    expect(checker.baselineOff).toHaveLength(1);
  });

  it("a ref name is not passed into the checker", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "findings", findings: [] }));
    const code = await laneCommand(
      ["/wt", "--allowed-path-prefixes", '["packages/x"]', "--base", "origin/main"],
      io,
      checker,
    );
    // A ref is allowance off: it is not printed and never becomes a git
    // argument; the baseline-off variant is called instead.
    expect(code).toBe(1);
    expect(checker.trusted).toEqual([]);
    expect(checker.baselineOff).toHaveLength(1);
    const call = checker.baselineOff[0];
    expect(JSON.stringify(call)).not.toContain("origin/main");
    expect(`${stdout.join("")}${stderr.join("")}`).not.toContain("origin/main");
  });

  it("a trusted sha is passed to checkLaneDiff", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(checker.trusted).toEqual([
      {
        worktreePath: "/wt",
        baseCommit: SHA,
        allowedPathPrefixes: ["packages/x"],
      },
    ]);
    expect(checker.baselineOff).toEqual([]);
  });

  it("one finding prints path line and rule and exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "findings",
      findings: [{ path: "packages/x/src/b.ts", line: 4, rule: "secret-pattern:aws-access-key" }],
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual(["packages/x/src/b.ts:4:secret-pattern:aws-access-key\n"]);
    expect(stderr).toEqual([]);
    // The fixture credential is absent from both streams.
    expect(stdout.join("")).not.toContain("abcdefghij");
    expect(stderr.join("")).not.toContain("abcdefghij");
  });

  it("a dist finding is printed", async () => {
    const { io, stdout } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "findings",
      findings: [
        { path: "dist/bundle.js", line: 4, rule: "secret-pattern:aws-access-key" },
      ],
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual(["dist/bundle.js:4:secret-pattern:aws-access-key\n"]);
    expect(stdout.join("")).not.toContain(tok);
  });

  it("a finding without a line prints path and rule", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "findings",
      findings: [{ path: "docs/x.md", rule: "outside-allowed-paths" }],
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual(["docs/x.md:outside-allowed-paths\n"]);
    expect(stderr).toEqual([]);
  });

  it("an error result exits 1 and prints no stdout", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "error",
      reason: "lane diff check: could not list the changed files",
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "lane diff check: could not list the changed files\n",
    ]);
  });

  it("an unreadable-file reason exits 1 and does not add stdout", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "error",
      reason: "lane diff check: could not read a changed file's worktree content",
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "lane diff check: could not read a changed file's worktree content\n",
    ]);
  });

  it("an error reason outside the printable shapes prints the unknown line", async () => {
    const { io, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "error",
      reason: "git exploded: secret=abcdefghij",
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
    expect(stderr.join("")).not.toContain("git exploded");
  });

  it("a null checker result exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => null);
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
  });

  it("a findings value that is not an array exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "findings",
      findings: "everything is fine",
    } as unknown as LaneDiffCheckResult));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
  });

  it("an empty findings array exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "findings", findings: [] }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
  });

  it("an unsafe finding record makes the whole result unknown", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({
      outcome: "findings",
      findings: [
        { path: "ok.ts", line: 1, rule: "secret-pattern:aws-access-key" },
        { path: "bad\npath.ts", line: 2, rule: "secret-pattern:aws-access-key" },
      ],
    }));
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
  });

  it("a sparse hole or an own every override in findings exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    // A sparse array: `every` skips the hole, an index loop does not.
    const sparse = [
      { path: "ok.ts", line: 1, rule: "secret-pattern:aws-access-key" },
    ] as unknown[];
    sparse[2] = {
      path: "late.ts",
      line: 2,
      rule: "secret-pattern:aws-access-key",
    };
    const code = await laneCommand(
      READY_ARGV,
      io,
      fakeChecker(() => ({ outcome: "findings", findings: sparse } as never)),
    );
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
  });

  it("a clean result with an extra field or an array shape exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const malformed = {
      outcome: "clean",
      extra: 1,
    } as unknown as LaneDiffCheckResult;
    const arrayShape = ["clean"] as unknown as LaneDiffCheckResult;
    let code = await laneCommand(
      READY_ARGV,
      io,
      fakeChecker(() => malformed),
    );
    expect(code).toBe(1);
    code = await laneCommand(
      READY_ARGV,
      io,
      fakeChecker(() => arrayShape),
    );
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).not.toContain("extra");
  });

  it("a clean result with only the outcome exits 0 for a trusted base", async () => {
    const { io, stdout, stderr } = capturingIo();
    const code = await laneCommand(
      READY_ARGV,
      io,
      fakeChecker(() => ({ outcome: "clean" })),
    );
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("a throwing getter on the checker result exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    checker.checkLaneDiff = async () =>
      ({
        get outcome(): string {
          throw new Error("hostile getter carried a secret abcdefghij");
        },
      }) as unknown as LaneDiffCheckResult;
    const code = await laneCommand(READY_ARGV, io, checker);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
    // The thrown message is absent from both streams.
    expect(stderr.join("")).not.toContain("hostile getter");
    expect(stderr.join("")).not.toContain("abcdefghij");
  });

  it("a missing baseline-off method exits 1", async () => {
    const { io, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    delete (checker as { checkLaneDiffBaselineOff?: unknown })
      .checkLaneDiffBaselineOff;
    const code = await laneCommand(
      ["/wt", "--allowed-path-prefixes", '["packages/x"]'],
      io,
      checker,
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["lane diff-check: unknown\n"]);
    // It does not fall through to checkLaneDiff.
    expect(checker.trusted).toEqual([]);
  });

  it("a clean result with the baseline off still exits 1", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    const code = await laneCommand(
      ["/wt", "--allowed-path-prefixes", '["packages/x"]', "--base", "HEAD"],
      io,
      checker,
    );
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "lane diff-check: base is not a full commit sha; no base-line allowance\n",
    ]);
  });

  it("lane diff-check help exits 0", async () => {
    const { io, stdout, stderr } = capturingIo();
    const checker = fakeChecker(() => ({ outcome: "clean" }));
    const code = await laneCommand(["--help"], io, checker);
    expect(code).toBe(0);
    expect(stdout[0]).toContain("--allowed-path-prefixes");
    expect(stdout[0]).toContain("--base");
    expect(stdout[0]).toContain("--policy-protected-paths");
    expect(stderr).toEqual([]);
    expect(checker.trusted).toEqual([]);
  });

  it("runCli routes lane diff-check and constructs no adapter on usage", async () => {
    const { io, stdout, stderr } = capturingIo();
    const code = await runCli(["lane", "diff-check"], io);
    expect(code).toBe(2);
    expect(stderr).toEqual(["lane diff-check: usage\n"]);
    expect(stdout).toEqual([]);
  });

  it("runCli runs lane diff-check on the given worktree and base: clean exits 0, a stray file exits 1 naming its path", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ldc1-"));
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q");
      git("config", "user.email", "t@example.invalid");
      git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(repo, "packages/x"), { recursive: true });
      writeFileSync(join(repo, "packages/x/a.txt"), "one\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      const argv = (extra: string[] = []): string[] => [
        "lane",
        "diff-check",
        repo,
        "--allowed-path-prefixes",
        '["packages/x"]',
        "--base",
        base,
        ...extra,
      ];

      // Clean worktree: exit 0 is only possible with a trusted base sha, so the
      // worktree and the base both reached the handler intact.
      const clean = capturingIo();
      expect(await runCli(argv(), clean.io)).toBe(0);
      expect(clean.stdout).toEqual([]);
      expect(clean.stderr).toEqual([]);

      // A file outside the allowed prefixes in THIS worktree is reported by
      // path and rule: the handler really scanned the worktree it was given.
      writeFileSync(join(repo, "stray.txt"), "x\n");
      const dirty = capturingIo();
      expect(await runCli(argv(), dirty.io)).toBe(1);
      expect(dirty.stderr).toEqual([]);
      expect(dirty.stdout.join("")).toContain("stray.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runCli keeps the other lane invocations parsing as before", async () => {
    const lane = capturingIo();
    expect(await runCli(["lane", "--help"], lane.io)).toBe(0);
    expect(lane.stdout[0]).toContain("fleet-v2 lane diff-check");
    const sub = capturingIo();
    expect(await runCli(["lane", "diff-check", "--help"], sub.io)).toBe(0);
    expect(sub.stdout[0]).toContain("--allowed-path-prefixes");
    // The bare `lane` group word with no arguments is still a usage error.
    const bare = capturingIo();
    expect(await runCli(["lane"], bare.io)).toBe(2);
    expect(bare.stderr).toEqual(["lane diff-check: usage\n"]);
  });

  it("runCli lane diff-check with a missing worktree is still a usage error", async () => {
    const { io, stdout, stderr } = capturingIo();
    const code = await runCli(
      ["lane", "diff-check", "--allowed-path-prefixes", '["packages/x"]', "--base", SHA],
      io,
    );
    expect(code).toBe(2);
    expect(stderr).toEqual(["lane diff-check: usage\n"]);
    expect(stdout).toEqual([]);
  });
});
