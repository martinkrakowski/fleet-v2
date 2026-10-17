// Adapter tests for LaneDiffCheckAdapter over a real throwaway git
// repository, through the local command executor. The same scenarios as
// tests/lane-diff-check.test.sh must reach the same verdicts. The fake
// credential is assembled at run time from harmless parts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The base tag's full commit sha: the only shape the adapter accepts. */
function base(repo: string): string {
  return execFileSync("git", ["rev-parse", "base"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

afterAll(() => {
  for (const repo of dirs) rmSync(repo, { recursive: true, force: true });
});

describe("LaneDiffCheckAdapter", () => {
  it("an untouched worktree is clean", async () => {
    const repo = makeRepo();
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("an ordinary source change is clean", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/a.ts"), "export const a = 2;\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("an untracked file with a token-shaped string is a finding without the value", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/b.ts"), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      // A well-formed commit sha that does not exist: git itself fails.
      baseCommit: "a".repeat(40),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result.outcome).toBe("error");
  });

  it("a baseCommit that is not a commit object name is refused before any git call", async () => {
    const repo = makeRepo();
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: "--output=/tmp/x",
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({
      outcome: "error",
      reason: "invalid-base-commit",
    });
  });

  it("an explicitly allowed .github prefix lifts the protection", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".github/workflows/gate.yml"), "name: gate2\n");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: [".github"],
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("findings never carry file content", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/b.ts"), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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
      baseCommit: base(repo),
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

  it("a tracked file named with a space is scanned despite the diff header TAB (O14d1 R3)", async () => {
    const repo = makeRepo();
    // Tracked and clean in the index; the secret exists in the worktree
    // only, so the worktree content scan is what catches it.
    const spaced = "packages/x/a b.ts";
    writeFileSync(join(repo, spaced), "export const a = 1;\n");
    git(repo, "add", "--", spaced);
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "spaced");
    writeFileSync(join(repo, spaced), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/a b.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a `* -diff` .gitattributes cannot hide a secret, and .gitattributes itself is protected (O14d1 R3)", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/.gitattributes"), "* -diff\n");
    git(repo, "add", "packages/x/.gitattributes");
    writeFileSync(join(repo, "packages/x/src/a.ts"), `const t = "${tok}";\n`);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        {
          path: "packages/x/src/a.ts",
          line: 1,
          rule: "secret-pattern:github-token",
        },
        { path: "packages/x/.gitattributes", rule: "protected-path" },
      ]),
    );
  });

  it("a NUL byte cannot make a tracked file's secret invisible (O14d1 R3)", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "packages/x/src/a.ts"),
      `before${"\0"}after\nconst t = "${tok}";\n`,
    );
    git(repo, "add", "packages/x/src/a.ts");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 2,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a secret staged then deleted from the worktree (MD) is scanned from the index blob", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/a.ts"), `const t = "${tok}";\n`);
    git(repo, "add", "packages/x/src/a.ts");
    rmSync(join(repo, "packages/x/src/a.ts"));
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
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

  it("a staged add then worktree deletion (AD) is scanned from the index blob", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/n.ts"), `const t = "${tok}";\n`);
    git(repo, "add", "packages/x/src/n.ts");
    rmSync(join(repo, "packages/x/src/n.ts"));
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/n.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("an executor that ignores cwd still yields the right findings, with -C and an absolute cat path", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "packages/x/src/b.ts"), `const t = "${tok}";\n`);
    const gitArgvs: string[][] = [];
    const catArgvs: string[][] = [];
    // The fake ignores `cwd` completely and always spawns in an unrelated
    // directory, like a batch-mode ssh transport would.
    const oblivious = {
      async run(argv: readonly string[]) {
        if (argv[0] === "git") gitArgvs.push([...argv]);
        if (argv[0] === "cat") catArgvs.push([...argv]);
        try {
          const out = execFileSync(argv[0], argv.slice(1), {
            cwd: tmpdir(),
            encoding: "utf8",
          });
          return { exitCode: 0, signal: null, stdout: out, stderr: "" };
        } catch (error) {
          // A non-zero exit is an answer (`test -L` on a regular file), not
          // a transport error, exactly as the real executors report it.
          const status = (error as { status?: number }).status ?? 1;
          return { exitCode: status, signal: null, stdout: "", stderr: "" };
        }
      },
    };
    const obliviousAdapter = new LaneDiffCheckAdapter(oblivious);
    const result = await obliviousAdapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
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
    expect(gitArgvs.length).toBeGreaterThan(0);
    for (const argv of gitArgvs) {
      expect(argv.slice(0, 3)).toEqual(["git", "-C", repo]);
    }
    for (const argv of catArgvs) {
      expect(argv[0]).toBe("cat");
      expect(argv[1]).toBe("--");
      expect(argv[2]).toBe(join(repo, "packages/x/src/b.ts"));
      expect(argv[2]).toMatch(/^\//);
    }
  });

  it("an untracked symbolic link is scanned as its target text, never the target's contents (review of #129)", async () => {
    const repo = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), "lane-diff-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), `const t = "${tok}";\n`);
      symlinkSync(
        join(outside, "secret.txt"),
        join(repo, "packages/x/src/link.ts"),
      );
      const result = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      expect(result.outcome).toBe("clean");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a link whose target text is secret-shaped is still found (review of #129)", async () => {
    const repo = makeRepo();
    symlinkSync(`/tmp/${tok}`, join(repo, "packages/x/src/link.ts"));
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      {
        path: "packages/x/src/link.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a `test -L` that gives no answer (ssh exit 255) fails closed (re-check of #129)", async () => {
    const repo = makeRepo();
    // The link text is secret-shaped and its target is a harmless file, so
    // following the link would scan the target and come back clean.
    const outside = mkdtempSync(join(tmpdir(), "lane-diff-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, tok), "harmless\n");
    symlinkSync(join(outside, tok), join(repo, "packages/x/src/link.ts"));
    const flaky = {
      async run(argv: readonly string[], options?: { cwd?: string }) {
        if (argv[0] === "test" && argv[1] === "-L")
          return { exitCode: 255, signal: null, stdout: "", stderr: "" };
        return new LocalExecutor().run(argv, options);
      },
    };
    const result = await new LaneDiffCheckAdapter(flaky).checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result.outcome).toBe("error");
  });

  it("a link to a FIFO is read as link text and never blocks on the pipe (review of #129)", async () => {
    // git lists no bare FIFO as a change, but it does list a link to one;
    // `cat` would wait on the pipe until the executor's timeout.
    const repo = makeRepo();
    const fifo = join(repo, "pipe");
    execFileSync("mkfifo", [fifo]);
    writeFileSync(join(repo, ".git/info/exclude"), "pipe\n");
    symlinkSync(fifo, join(repo, "packages/x/src/pipe.ts"));
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result.outcome).toBe("clean");
  }, 10_000);

  it("a repository-local clean filter cannot hide a staged secret (O14d1 R3)", async () => {
    const repo = makeRepo();
    git(repo, "config", "filter.x.clean", "cat /dev/null");
    writeFileSync(join(repo, "packages/x/.gitattributes"), "*.ts filter=x\n");
    git(repo, "add", "packages/x/.gitattributes");
    writeFileSync(join(repo, "packages/x/src/a.ts"), `const t = "${tok}";\n`);
    git(repo, "add", "packages/x/src/a.ts");
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        {
          path: "packages/x/src/a.ts",
          line: 1,
          rule: "secret-pattern:github-token",
        },
      ]),
    );
  });
});
