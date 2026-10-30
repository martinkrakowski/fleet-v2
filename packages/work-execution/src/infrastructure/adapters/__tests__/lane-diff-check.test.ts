// Adapter tests for LaneDiffCheckAdapter over a real throwaway git
// repository, through the local command executor. The same scenarios as
// tests/lane-diff-check.test.sh must reach the same verdicts. The fake
// credential is assembled at run time from harmless parts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

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
      async run(argv: readonly string[], options?: { cwd?: string; input?: string }) {
        if (argv[0] === "env") gitArgvs.push([...argv]);
        if (argv[0] === "cat") catArgvs.push([...argv]);
        try {
          const out = execFileSync(argv[0], argv.slice(1), {
            cwd: tmpdir(),
            encoding: "utf8",
            ...(options?.input !== undefined ? { input: options.input } : {}),
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
      // The hardened overrides travel inside the argv, so they reach a
      // remote git that never sees the executor's environment.
      expect(argv.slice(0, 4)).toEqual([
        "env",
        "GIT_NO_REPLACE_OBJECTS=1",
        expect.stringMatching(/^GIT_GRAFT_FILE=\/nonexistent\//),
        "git",
      ]);
      expect(argv.slice(4, 7)).toEqual(["--no-replace-objects", "-C", repo]);
    }
    for (const argv of catArgvs) {
      expect(argv[0]).toBe("cat");
      expect(argv[1]).toBe("--");
      expect(argv[2]).toBe(join(repo, "packages/x/src/b.ts"));
      expect(argv[2]).toMatch(/^\//);
    }
  });

  it("an untracked symbolic link is a symlink finding even when its target stays reachable (KF-27; review of #129)", async () => {
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
      // The link's target TEXT (the path string) is scanned, never the
      // target's contents, and the link itself is a finding.
      if (result.outcome !== "findings")
        throw new Error(`expected findings, got ${result.outcome}`);
      expect(result.findings).toEqual([
        { path: "packages/x/src/link.ts", rule: "symlink" },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a link whose target text is secret-shaped is still found, alongside the symlink finding (review of #129)", async () => {
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
      { path: "packages/x/src/link.ts", rule: "symlink" },
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
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    // The link is read as link text (no pipe stall) and is itself a
    // symlink finding.
    expect(result.findings).toEqual([
      { path: "packages/x/src/pipe.ts", rule: "symlink" },
    ]);
  }, 10_000);

  it("a repository-local clean filter cannot hide a staged secret (O14d1 R3)", async () => {
    const repo = makeRepo();
    git(repo, "config", "filter.x.clean", "cat /dev/null");
    writeFileSync(join(repo, "packages/x/.gitattributes"), "*.ts filter=x\n");
    git(repo, "add", "packages/x/.gitattributes");
    writeFileSync(join(repo, "packages/x/src/a.ts"), `const t = "${tok}";\n`);
    git(repo, "add", "packages/x/src/a.ts");
    const result = await adapter.checkLaneDiff(
      {
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      },
    );
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

  /** An executor that records every argv and otherwise behaves locally. */
  function recordingAdapter() {
    const argvs: string[][] = [];
    const local = new LocalExecutor();
    const executor = {
      async run(argv: readonly string[], options?: { cwd?: string }) {
        argvs.push([...argv]);
        return local.run(argv, options as never);
      },
    };
    return { argvs, adapter: new LaneDiffCheckAdapter(executor) };
  }

  /** A repo whose base already holds a fixture line in packages/x/src/a.ts. */
  function makeFixtureRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "lane-diff-check-adapter-"));
    dirs.push(repo);
    const run = (args: string[], cwd = repo) =>
      execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
    run(["git", "init", "-q", "."]);
    run(["git", "config", "user.email", "t@example.invalid"]);
    run(["git", "config", "user.name", "t"]);
    execFileSync("mkdir", ["-p", join(repo, "packages/x/src")]);
    writeFileSync(
      join(repo, "packages/x/src/a.ts"),
      `export const a = 1;\n${`const fixture = "${tok}";`}\n`,
    );
    run(["git", "add", "."]);
    run(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    run(["git", "tag", "base"]);
    return repo;
  }

  describe("KF-27: base-line allowance, symlinks, helper config keys", () => {
    it("the base blob is probed and read through a verified object walk", async () => {
      const repo = makeFixtureRepo();
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\nexport const a = 2;\n`,
      );
      const sha = base(repo);
      const { argvs, adapter: recording } = recordingAdapter();
      const result = await recording.checkLaneDiff({
        worktreePath: repo,
        baseCommit: sha,
        allowedPathPrefixes: PREFIXES,
      });
      expect(result).toEqual({ outcome: "clean" });
      const catFileArgvs = argvs.filter((argv) => argv.includes("cat-file"));
      expect(
        catFileArgvs.some(
          (argv) =>
            argv.includes("-e") &&
            argv.includes(`${sha}:packages/x/src/a.ts`),
        ),
      ).toBe(true);
      // The walk verifies every object: the commit and the blob re-hashed,
      // the trees listed and round-tripped through mktree.
      expect(argvs.some((argv) => argv.includes("ls-tree"))).toBe(true);
      expect(argvs.some((argv) => argv.includes("mktree"))).toBe(true);
      expect(
        argvs.some(
          (argv) =>
            argv.includes("hash-object") && argv.includes("--stdin"),
        ),
      ).toBe(true);
      expect(
        catFileArgvs.some(
          (argv) => argv.includes("blob") && !argv.includes("-e"),
        ),
      ).toBe(true);
    });

    it("a file the base never had gets no excuse, even though it is committed", async () => {
      const repo = makeRepo();
      writeFileSync(join(repo, "packages/x/src/n.ts"), `const t = "${tok}";\n`);
      git(repo, "add", "-A");
      git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "new");
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

    it("a base blob read that fails after a successful probe excuses nothing", async () => {
      const repo = makeFixtureRepo();
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\nexport const a = 2;\n`,
      );
      const sha = base(repo);
      const local = new LocalExecutor();
      const brokenRead = {
        async run(argv: readonly string[], options?: { cwd?: string }) {
          const outcome = await local.run(argv, options as never);
          // Any base blob read through the verified walk fails: the fixture
          // line is then NOT excused (baseLines null), never an error. Only
          // the bare-id blob read breaks — the index blob read (`:<path>`)
          // must keep working.
          if (
            argv.includes("cat-file") &&
            argv.includes("blob") &&
            argv.some((arg) => /^[0-9a-f]{40,64}$/.test(arg))
          ) {
            return { ...outcome, exitCode: 1, stdout: "", stderr: "" };
          }
          return outcome;
        },
      };
      const result = await new LaneDiffCheckAdapter(brokenRead).checkLaneDiff({
        worktreePath: repo,
        baseCommit: sha,
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

    it("a base-line fixture the base already had passes; a second copy beyond the base count fails", async () => {
      // CL-2 shape: a touched file whose base already has fixture lines.
      const repo = makeFixtureRepo();
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\nexport const a = 2;\n`,
      );
      const clean = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      expect(clean).toEqual({ outcome: "clean" });
      // One more copy of the same line than the base holds: the copy fails.
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\nconst fixture = "${tok}";\n`,
      );
      const copied = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      if (copied.outcome !== "findings")
        throw new Error(`expected findings, got ${copied.outcome}`);
      expect(copied.findings).toEqual([
        {
          path: "packages/x/src/a.ts",
          line: 3,
          rule: "secret-pattern:github-token",
        },
      ]);
    });

    it("a replace ref forging the base blob excuses nothing", async () => {
      const repo = makeRepo();
      // The real base blob is clean; the lane adds a fixture line and plants
      // a replace ref whose tree already contains that line, hoping the
      // check reads the forged base blob and excuses it.
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst t = "${tok}";\n`,
      );
      git(repo, "add", "packages/x/src/a.ts");
      const forgedTree = execFileSync(
        "git",
        ["write-tree"],
        { cwd: repo, encoding: "utf8" },
      ).trim();
      const forged = execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit-tree", forgedTree, "-m", "forged"],
        { cwd: repo, encoding: "utf8" },
      ).trim();
      const sha = base(repo);
      git(repo, "update-ref", `refs/replace/${sha}`, forged);
      const result = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: sha,
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

    it("helper-shaped config key names are read once, by name only, and reported masked", async () => {
      const repo = makeRepo();
      git(repo, "config", "core.editor", "editor-program");
      git(repo, "config", "credential.gh.helper", "helper-program");
      git(repo, "config", "diff.external", "external-program");
      const { argvs, adapter: recording } = recordingAdapter();
      const result = await recording.checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      expect(
        argvs.some(
          (argv) =>
            argv.includes("config") &&
            argv.includes("-z") &&
            argv.includes("--local") &&
            argv.includes("--includes") &&
            argv.includes("--name-only") &&
            argv.includes("--list"),
        ),
      ).toBe(true);
      if (result.outcome !== "findings")
        throw new Error(`expected findings, got ${result.outcome}`);
      expect(result.findings).toEqual([
        { path: ".git/config", rule: "git-config-helper:core.editor" },
        {
          path: ".git/config",
          rule: "git-config-helper:credential.<sub>.helper",
        },
        { path: ".git/config", rule: "git-config-helper:diff.external" },
      ]);
      // Names only: no config value is ever part of a finding.
      expect(JSON.stringify(result)).not.toContain("helper-program");
      expect(JSON.stringify(result)).not.toContain("editor-program");
      expect(JSON.stringify(result)).not.toContain("external-program");
    });

    it("a failed config key read is an error, never a silent pass", async () => {
      const repo = makeRepo();
      const local = new LocalExecutor();
      const brokenKeys = {
        async run(argv: readonly string[], options?: { cwd?: string }) {
          const outcome = await local.run(argv, options as never);
          if (argv.includes("config") && argv.includes("--name-only")) {
            return { ...outcome, exitCode: 1, stdout: "", stderr: "" };
          }
          return outcome;
        },
      };
      const result = await new LaneDiffCheckAdapter(brokenKeys).checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      expect(result.outcome).toBe("error");
    });

    it("a forged loose base blob object in the store excuses nothing (KF-27b)", async () => {
      // Fresh, never-packed repo: the base blob is a loose object file. A
      // lane with write access to the shared object store overwrites it
      // with a valid zlib stream of OTHER content that contains the new
      // line — git does not check hashes on read, so only a re-hash catch.
      const repo = makeFixtureRepo();
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\nexport const a = 2;\n`,
      );
      // Stage the change: the index blob then differs from the base blob,
      // so the forged object is served only for the base read.
      git(repo, "add", "packages/x/src/a.ts");
      const sha = base(repo);
      const blobSha = execFileSync(
        "git",
        ["rev-parse", `${sha}:packages/x/src/a.ts`],
        { cwd: repo, encoding: "utf8" },
      ).trim();
      const forged = `const fixture = "${tok}";\nconst fixture = "${tok}";\n`;
      const object = Buffer.concat([
        Buffer.from(`blob ${Buffer.byteLength(forged)}\0`),
        Buffer.from(forged),
      ]);
      const objectPath = join(
        repo,
        ".git",
        "objects",
        blobSha.slice(0, 2),
        blobSha.slice(2),
      );
      // Loose object files are read-only; replace the file outright.
      rmSync(objectPath, { force: true });
      writeFileSync(objectPath, deflateSync(object), { mode: 0o444 });
      const result = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: sha,
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

    it("a base that is not an ancestor of HEAD excuses nothing (KF-27b)", async () => {
      // An orphan commit holds the same fixture line in the same path, but
      // it sits on an unrelated root: merge-base --is-ancestor fails, and
      // nothing is excused even though the base blob read would succeed.
      const repo = makeRepo();
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\n`,
      );
      git(repo, "add", "packages/x/src/a.ts");
      const orphanTree = execFileSync("git", ["write-tree"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      const orphan = execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit-tree", orphanTree, "-m", "o"],
        { cwd: repo, encoding: "utf8" },
      ).trim();
      git(repo, "reset", "-q", "--hard");
      writeFileSync(
        join(repo, "packages/x/src/a.ts"),
        `export const a = 1;\nconst fixture = "${tok}";\n`,
      );
      const result = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: orphan,
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

    it("a base symlink at the path excuses nothing (KF-27b)", async () => {
      // The BASE commit itself has link.ts as a symbolic link whose target
      // text equals the new line; the worktree replaces it with a regular
      // file holding that line. Only a regular-file base entry
      // (100644/100755) excuses: a symlink, submodule or tree at the path
      // is unknown and excuses nothing.
      const repo = mkdtempSync(join(tmpdir(), "lane-diff-check-adapter-"));
      dirs.push(repo);
      const run = (args: string[], cwd = repo) =>
        execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
      run(["git", "init", "-q", "."]);
      run(["git", "config", "user.email", "t@example.invalid"]);
      run(["git", "config", "user.name", "t"]);
      mkdirSync(join(repo, "packages/x/src"), { recursive: true });
      symlinkSync(`const fixture = "${tok}";`, join(repo, "packages/x/src/link.ts"));
      run(["git", "add", "packages/x/src/link.ts"]);
      run(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "link"]);
      run(["git", "tag", "base"]);
      rmSync(join(repo, "packages/x/src/link.ts"));
      writeFileSync(join(repo, "packages/x/src/link.ts"), `const fixture = "${tok}";\n`);
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

    it("helper keys set only in the worktree config are caught too (KF-27b)", async () => {
      const repo = makeRepo();
      git(repo, "config", "extensions.worktreeConfig", "true");
      git(repo, "config", "--worktree", "core.editor", "worktree-editor");
      const result = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      if (result.outcome !== "findings")
        throw new Error(`expected findings, got ${result.outcome}`);
      expect(result.findings).toEqual([
        { path: ".git/config", rule: "git-config-helper:core.editor" },
      ]);
      expect(JSON.stringify(result)).not.toContain("worktree-editor");
    });

    it("a two-part pager key's lane-chosen command name is masked (KF-27b)", async () => {
      const repo = makeRepo();
      git(repo, "config", "pager.less", "pager-program");
      const result = await adapter.checkLaneDiff({
        worktreePath: repo,
        baseCommit: base(repo),
        allowedPathPrefixes: PREFIXES,
      });
      if (result.outcome !== "findings")
        throw new Error(`expected findings, got ${result.outcome}`);
      expect(result.findings).toEqual([
        { path: ".git/config", rule: "git-config-helper:pager.<sub>" },
      ]);
      // Neither the value nor the lane-chosen command name appears.
      expect(JSON.stringify(result)).not.toContain("pager-program");
      expect(JSON.stringify(result)).not.toContain("pager.less");
    });

    it("the grafts override travels inside the argv and the child env is the local allow-list (KF-27b)", async () => {
      const repo = makeRepo();
      const argvs: string[][] = [];
      const envs: (Readonly<Record<string, string>> | undefined)[] = [];
      const local = new LocalExecutor();
      const recording = {
        async run(argv: readonly string[], options?: { cwd?: string; env?: Record<string, string> }) {
          argvs.push([...argv]);
          envs.push(options?.env);
          return local.run(argv, options as never);
        },
      };
      const previousAgent = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = join(tmpdir(), "kf-27b-agent.sock");
      try {
        const result = await new LaneDiffCheckAdapter(recording).checkLaneDiff({
          worktreePath: repo,
          baseCommit: base(repo),
          allowedPathPrefixes: PREFIXES,
        });
        expect(result).toEqual({ outcome: "clean" });
      } finally {
        if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK;
        else process.env.SSH_AUTH_SOCK = previousAgent;
      }
      const gitArgvs = argvs.filter((argv) => argv[0] === "env");
      expect(gitArgvs.length).toBeGreaterThan(0);
      for (const argv of gitArgvs) {
        expect(argv.slice(0, 4)).toEqual([
          "env",
          "GIT_NO_REPLACE_OBJECTS=1",
          expect.stringMatching(/^GIT_GRAFT_FILE=\/nonexistent\//),
          "git",
        ]);
      }
      // These git calls never touch a remote over git, so the local
      // allow-list applies even when the host has an ssh agent.
      for (let index = 0; index < argvs.length; index += 1) {
        if (argvs[index][0] !== "env") continue;
        const env = envs[index];
        expect(env).toBeDefined();
        expect(env && "SSH_AUTH_SOCK" in env).toBe(false);
      }
    });
  });
});
