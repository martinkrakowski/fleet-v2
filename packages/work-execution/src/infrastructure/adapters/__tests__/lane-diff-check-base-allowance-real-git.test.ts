// CB8 base-line allowance, proven against a real throwaway git repository
// (brief step 1). The scanned worktree is UNSTAGED: the index still holds the
// base blob, the worktree file is the edited version, so a line inserted
// ABOVE a base fixture shifts it — exactly the conductor's suspect scenario.
// The fake credential is assembled at run time from harmless parts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { LaneDiffCheckAdapter } from "../LaneDiffCheckAdapter.adapter.js";
import { LocalExecutor } from "../LocalExecutor.adapter.js";

/** One credential-shaped fixture line, built from harmless parts. */
const BASE_FIXTURE = `const t = "${"ghp_" + "abcdefghij" + "0123456789"}";\n`;
/** A DIFFERENT credential-shaped line, so a base count can never excuse it. */
const NEW_FIXTURE = `const u = "${"ghp_" + "zzzzzzzzzz" + "0123456789"}";\n`;

const PREFIXES = ["packages/x"];
const FILE = "packages/x/src/a.ts";
/** The base blob: one plain line, then the fixture. */
const BASE_CONTENT = "export const a = 1;\n" + BASE_FIXTURE;

const dirs: string[] = [];
const adapter = new LaneDiffCheckAdapter(new LocalExecutor());

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lane-diff-base-allowance-"));
  dirs.push(repo);
  execFileSync("mkdir", ["-p", join(repo, "packages/x/src")]);
  writeFileSync(join(repo, FILE), BASE_CONTENT);
  const run = (args: string[]) => execFileSync(args[0], args.slice(1), { cwd: repo });
  run(["git", "init", "-q", "."]);
  run(["git", "config", "user.email", "t@example.invalid"]);
  run(["git", "config", "user.name", "t"]);
  run(["git", "add", "."]);
  run(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  run(["git", "tag", "base"]);
  return repo;
}

/** The base tag's full commit sha: the only shape the adapter accepts. */
function base(repo: string): string {
  return execFileSync("git", ["rev-parse", "base"], { cwd: repo, encoding: "utf8" }).trim();
}

afterAll(() => {
  for (const repo of dirs) rmSync(repo, { recursive: true, force: true });
});

describe("LaneDiffCheckAdapter base-line allowance (real git)", () => {
  it("a credential-shaped line already present in the base blob is excused", async () => {
    const repo = makeRepo();
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("the same base fixture shifted to other line numbers by an UNSTAGED line inserted above it is still excused", async () => {
    const repo = makeRepo();
    // One unrelated line above the fixture shifts it from line 2 to line 3,
    // with the index still holding the base blob (nothing staged).
    writeFileSync(join(repo, FILE), "export const b = 2;\n" + BASE_CONTENT);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("the same base fixture shifted by several inserted lines is still excused", async () => {
    const repo = makeRepo();
    const filler = "export const c = 3;\nexport const d = 4;\n";
    writeFileSync(join(repo, FILE), filler + BASE_CONTENT);
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("the shifted base fixture plus ONE new credential-shaped line yields exactly ONE finding", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, FILE),
      "export const b = 2;\n" + BASE_CONTENT + NEW_FIXTURE,
    );
    const result = await adapter.checkLaneDiff({
      worktreePath: repo,
      baseCommit: base(repo),
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    expect(result.findings).toEqual([
      { path: FILE, line: 4, rule: "secret-pattern:github-token" },
    ]);
  });

  it("a null/absent base excuses nothing: the same unchanged base fixture is reported by the baseline-off scan", async () => {
    const repo = makeRepo();
    // An unrelated unstaged edit puts the file in the scanned change set; the
    // fixture shifts to line 3. Without a trusted base the allowance cannot
    // be computed, so the fixture line must still be reported, never excused.
    writeFileSync(join(repo, FILE), "export const b = 2;\n" + BASE_CONTENT);
    const result = await adapter.checkLaneDiffBaselineOff({
      worktreePath: repo,
      allowedPathPrefixes: PREFIXES,
    });
    if (result.outcome !== "findings")
      throw new Error(`expected findings, got ${result.outcome}`);
    // Off mode scans the worktree version and the index (base) version of the
    // file with no allowance at all, so the fixture is reported at BOTH of
    // its line numbers — nothing is excused without a base.
    expect([...result.findings].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))).toEqual([
      { path: FILE, line: 2, rule: "secret-pattern:github-token" },
      { path: FILE, line: 3, rule: "secret-pattern:github-token" },
    ]);
  });
});
