// Adapter tests for LaneDiffCheckAdapter over a real throwaway git
// repository, through the local command executor. The same scenarios as
// tests/lane-diff-check.test.sh must reach the same verdicts. The fake
// credential is assembled at run time from harmless parts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { LaneDiffCheckAdapter } from "../LaneDiffCheckAdapter.adapter.js";
import { LocalExecutor } from "../LocalExecutor.adapter.js";

const tok = `ghp_${"abcdefghij"}${"0123456789"}`;
const PREFIXES = ["packages/x"];

const dirs: string[] = [];

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lane-diff-check-adapter-"));
  dirs.push(repo);
  const run = (args: string[], cwd = repo) =>
    execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  run(["git", "init", "-q", "."]);
  run(["git", "config", "user.email", "t@example.invalid"]);
  run(["git", "config", "user.name", "t"]);
  writeFileSync(join(repo, ".gitignore"), "/.lane/\n");
  execFileSync("mkdir", [
    "-p",
    join(repo, "packages/x/src"),
    join(repo, ".github/workflows"),
  ]);
  writeFileSync(join(repo, "packages/x/src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, ".github/workflows/gate.yml"), "name: gate\n");
  run(["git", "add", "."]);
  run(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  run(["git", "tag", "base"]);
  return repo;
}

const adapter = new LaneDiffCheckAdapter(new LocalExecutor());

function git(repo: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repo });
}

afterAll(() => {
  for (const repo of dirs) rmSync(repo, { recursive: true, force: true });
});

describe("LaneDiffCheckAdapter", () => {
  it("an untouched worktree is clean", async () => {
    const repo = makeRepo();
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("an ordinary source change is clean", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/a.ts"), "export const a = 2;\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("an untracked file with a token-shaped string is a finding without the value", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/b.ts"), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/b.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a changed workflow is a protected-path finding", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".github/workflows/gate.yml"), "name: gate2\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      { path: ".github/workflows/gate.yml", rule: "outside-allowed-paths" },
      { path: ".github/workflows/gate.yml", rule: "protected-path" },
    ]);
  });

  it("a protected lockfile under an allowed prefix is refused", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/yarn.lock"), "# lockfile\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      { path: "packages/x/yarn.lock", rule: "protected-path" },
    ]);
  });

  it("a deleted file under an allowed prefix passes", async () => {
    const repo = makeRepo();
    rmSync(join(repo, "packages/x/src/a.ts"));
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("a path outside every prefix is refused as outside-allowed-paths", async () => {
    const repo = makeRepo();
    execFileSync("mkdir", ["-p", join(repo, "docs")]);
    writeFileSync(join(repo, "docs/notes.md"), "n\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      { path: "docs/notes.md", rule: "outside-allowed-paths" },
    ]);
  });

  it("a staged rename away from a protected path is still a protected-path finding", async () => {
    const repo = makeRepo();
    git(repo, "mv", ".github/workflows/gate.yml", "packages/x/gate.yml");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      { path: ".github/workflows/gate.yml", rule: "outside-allowed-paths" },
      { path: ".github/workflows/gate.yml", rule: "protected-path" },
    ]);
  });

  it("a failed git collection fails closed as an error", async () => {
    const repo = makeRepo();
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "no-such-ref",
      allowedPathPrefixes: PREFIXES,
    });
    expect(result.outcome).toBe("error");
  });

  it("an explicitly allowed .github prefix lifts the protection", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".github/workflows/gate.yml"), "name: gate2\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: [".github"],
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("findings never carry file content", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/b.ts"), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    expect(JSON.stringify(result)).not.toContain("abcdefghij");
  });

  it("a committed .github change and a committed secret are both findings (O14d1 B1)", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".github/x.yml"), "name: x\n");
    writeFileSync(join(repo, "packages/x/src/s.ts"), `const t = "${tok}";\n`);
    git(repo, "add", "-A");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "wip");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        { path: ".github/x.yml", rule: "outside-allowed-paths" },
        { path: ".github/x.yml", rule: "protected-path" },
        {
          path: "packages/x/src/s.ts",
          line: 1,
          rule: "secret-pattern:github-token",
        },
      ]),
    );
  });

  it("a secret staged and then reverted in the worktree is still a finding (O14d1 S1b)", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/a.ts"), `const t = "${tok}";\n`);
    git(repo, "add", "packages/x/src/a.ts");
    execFileSync(
      "git",
      ["restore", "--worktree", "--source=HEAD", "packages/x/src/a.ts"],
      { cwd: repo },
    );
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("an added line starting with '++ ' is content, never a file header (O14d1 B2)", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "packages/x/src/a.ts"),
      `export const a = 2;\n++ x\nconst t = "${tok}";\n`,
    );
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 3,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a tab in a changed file name fails closed without echoing the path (O14d1 B3)", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, `packages/x/src/with${"\t"}tab.ts`), "x\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({
      outcome: "error",
      reason: "unsupported-path-characters",
    });
    expect(JSON.stringify(result)).not.toContain("tab");
  });

  it("a hostile local git config cannot change the parser input (O14d1 S1)", async () => {
    const repo = makeRepo();
    git(repo, "config", "color.ui", "always");
    git(repo, "config", "diff.noprefix", "true");
    git(repo, "config", "diff.mnemonicPrefix", "true");
    writeFileSync(join(repo, "packages/x/src/b.ts"), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "base",
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/b.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });
});
