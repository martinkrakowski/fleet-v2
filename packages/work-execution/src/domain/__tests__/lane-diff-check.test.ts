// Parity tests for the pure lane diff check (O14d1): the same fixtures as
// tests/lane-diff-check.test.sh (S2) must reach the same verdicts here. The
// fake credentials are assembled at run time from harmless parts, so this
// file itself matches none of the patterns. Findings carry path, line and
// rule name only — never a matched value.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkLaneDiff,
  isFixedProtectedPath,
  pathUnderPrefix,
  validateAllowedPathPrefix,
  PROTECTED_PATH_RULES,
  type LaneDiffChangedPath,
  type LaneDiffSecretPattern,
} from "../lane-diff-check.js";

/** The repo root, found by walking up from this test file. */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "scripts", "lane-diff-check.sh"))) {
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error("could not locate scripts/lane-diff-check.sh");
    dir = parent;
  }
  return dir;
}

// The script's pattern table, narrowed to the fixtures below. Patterns live
// in the input; the pure function never invents any.
const SCRIPT_PATTERNS: readonly LaneDiffSecretPattern[] = [
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "private-key-block", regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    name: "home-credential-path",
    regex: /\/home\/[a-z]+\/\.(ssh|config\/gh|gemini|aws|docker\/config\.json)/,
  },
  {
    name: "password-assignment",
    regex: /[Pp]assword[ \t]*[:=][ \t]*["'][^"']{6,}["']/,
  },
];

const tok = `ghp_${"abcdefghij"}${"0123456789"}`;

function line(path: string, line: number, text: string): LaneDiffChangedPath {
  return { path, status: "added", addedLines: [{ line, text }] };
}

const PREFIXES = ["packages/x"];

function check(
  paths: LaneDiffChangedPath[],
  extra: Record<string, unknown> = {},
) {
  return checkLaneDiff({
    changedPaths: paths,
    allowedPathPrefixes: PREFIXES,
    secretPatterns: SCRIPT_PATTERNS,
    ...extra,
  });
}

describe("checkLaneDiff (script parity)", () => {
  it("an ordinary source change is clean", () => {
    const verdict = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [{ line: 1, text: "export const a = 2;" }],
      },
    ]);
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it("a changed workflow under .github is a protected-path finding (and outside the prefixes)", () => {
    const verdict = check([
      { path: ".github/workflows/gate.yml", status: "modified" },
    ]);
    expect(verdict.findings).toEqual([
      { path: ".github/workflows/gate.yml", rule: "outside-allowed-paths" },
      { path: ".github/workflows/gate.yml", rule: "protected-path" },
    ]);
  });

  it("a lane plumbing change under .lane is a protected-path finding (D3)", () => {
    for (const status of ["added", "modified", "untracked"] as const) {
      const verdict = check([{ path: ".lane/brief.md", status }]);
      expect(verdict.findings).toEqual([
        { path: ".lane/brief.md", rule: "outside-allowed-paths" },
        { path: ".lane/brief.md", rule: "protected-path" },
      ]);
    }
  });

  it("a policy addition extends the protected list (.gemini)", () => {
    const verdict = check(
      [{ path: ".gemini/settings.json", status: "untracked" }],
      {
        policyProtectedPaths: [".gemini"],
      },
    );
    expect(verdict.findings).toEqual([
      { path: ".gemini/settings.json", rule: "outside-allowed-paths" },
      { path: ".gemini/settings.json", rule: "protected-path" },
    ]);
  });

  it("a Claude Code settings file under .claude is a protected-path finding (B3)", () => {
    const verdict = check([
      { path: ".claude/settings.json", status: "untracked" },
    ]);
    expect(verdict.findings).toEqual([
      { path: ".claude/settings.json", rule: "outside-allowed-paths" },
      { path: ".claude/settings.json", rule: "protected-path" },
    ]);
  });

  it("opencode config (.opencode/, opencode.json*) is a protected-path finding (B3)", () => {
    for (const path of [
      ".opencode/auth.json",
      "opencode.json",
      "opencode.jsonc",
      "opencode.json5",
    ]) {
      const verdict = check([{ path, status: "untracked" }]);
      expect(verdict.findings).toContainEqual({
        path,
        rule: "protected-path",
      });
    }
  });

  it(".claude/, .opencode/ and opencode.json* match at any depth and case-insensitively (Fix 3)", () => {
    for (const path of [
      ".Claude/settings.json",
      "packages/app/.claude/settings.json",
      "packages/x/.Claude/settings.json",
      "packages/x/.OpenCode/auth.json",
      "packages/x/opencode.jsonc",
      "packages/x/OpenCode.JSON5",
    ]) {
      const verdict = check([{ path, status: "untracked" }]);
      expect(verdict.findings).toContainEqual({
        path,
        rule: "protected-path",
      });
    }
  });

  it("a token-shaped string in a new file is a finding with its line and rule only", () => {
    const verdict = check([
      line("packages/x/src/b.ts", 1, `const t = "${tok}";`),
    ]);
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/b.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a private key block is a finding with its line", () => {
    const pk = `-----BEGIN${" OPENSSH PRIVATE KEY"}-----`;
    const verdict = check([
      {
        path: "packages/x/src/key.txt",
        status: "untracked",
        addedLines: [
          { line: 1, text: "line one" },
          { line: 2, text: pk },
        ],
      },
    ]);
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/key.txt",
        line: 2,
        rule: "secret-pattern:private-key-block",
      },
    ]);
  });

  it("a home credential path is a finding", () => {
    const verdict = check([
      {
        path: "packages/x/src/note.md",
        status: "added",
        addedLines: [
          { line: 1, text: `see /home/${"martin"}/.ssh/id_ed25519 for the key` },
        ],
      },
    ]);
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/note.md",
        line: 1,
        rule: "secret-pattern:home-credential-path",
      },
    ]);
  });

  it("a password assignment is a finding but reading one from the environment is not", () => {
    const assigned = check([
      line("packages/x/src/c.ts", 1, `const password = ${'"hunter2hunter2"'};`),
    ]);
    expect(assigned.findings.map((f) => f.rule)).toEqual([
      "secret-pattern:password-assignment",
    ]);
    const fromEnv = check([
      line("packages/x/src/d.ts", 1, "const password = process.env.PASSWORD;"),
    ]);
    expect(fromEnv).toEqual({ ok: true, findings: [] });
  });

  it("the matched secret value never appears in any finding", () => {
    const verdict = check([
      line("packages/x/src/b.ts", 1, `const t = "${tok}";`),
    ]);
    expect(JSON.stringify(verdict)).not.toContain("abcdefghij");
  });

  it("a staged rename away from a protected path is still a protected-path finding", () => {
    const verdict = check([
      { path: ".github/workflows/gate.yml", status: "deleted" },
      { path: "packages/x/gate.yml", status: "added" },
    ]);
    expect(verdict.findings).toEqual([
      { path: ".github/workflows/gate.yml", rule: "outside-allowed-paths" },
      { path: ".github/workflows/gate.yml", rule: "protected-path" },
    ]);
  });

  it("an untracked non-ASCII file name is scanned as the real file", () => {
    const verdict = check([
      {
        path: "packages/x/src/caf\u00e9 file.ts",
        status: "untracked",
        addedLines: [{ line: 1, text: `const t = "${tok}";` }],
      },
    ]);
    expect(verdict.findings[0]).toEqual({
      path: "packages/x/src/caf\u00e9 file.ts",
      line: 1,
      rule: "secret-pattern:github-token",
    });
  });
});

describe("checkLaneDiff (allowed prefixes)", () => {
  it("a path outside every allowed prefix is refused as outside-allowed-paths", () => {
    const verdict = check([{ path: "apps/cli/other.ts", status: "untracked" }]);
    expect(verdict.findings).toEqual([
      { path: "apps/cli/other.ts", rule: "outside-allowed-paths" },
    ]);
  });

  it("a deleted file under an allowed prefix passes", () => {
    const verdict = check([
      { path: "packages/x/src/old.ts", status: "deleted" },
    ]);
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it("a protected lockfile is refused even under an allowed prefix, unless a prefix explicitly allows it", () => {
    const refused = check([
      { path: "packages/x/yarn.lock", status: "modified" },
    ]);
    expect(refused.findings).toEqual([
      { path: "packages/x/yarn.lock", rule: "protected-path" },
    ]);
    const rootLock = checkLaneDiff({
      changedPaths: [{ path: "yarn.lock", status: "modified" }],
      allowedPathPrefixes: ["packages/x", "yarn.lock"],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(rootLock).toEqual({ ok: true, findings: [] });
  });

  it("a .github path a prefix explicitly allows is not protected", () => {
    const verdict = checkLaneDiff({
      changedPaths: [
        { path: ".github/workflows/gate.yml", status: "modified" },
      ],
      allowedPathPrefixes: [".github"],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it("lifting a protected directory does not lift the protected files inside it (review of #129)", () => {
    const paths = [
      "scripts/package.json",
      "scripts/yarn.lock",
      "scripts/.gitattributes",
      "scripts/.gitmodules",
    ];
    const verdict = checkLaneDiff({
      changedPaths: [
        ...paths.map((path) => ({ path, status: "modified" as const })),
        { path: "scripts/tool.sh", status: "modified" },
      ],
      allowedPathPrefixes: ["scripts"],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(verdict.findings).toEqual(
      paths.map((path) => ({ path, rule: "protected-path" })),
    );
    const exact = checkLaneDiff({
      changedPaths: [{ path: "scripts/package.json", status: "modified" }],
      allowedPathPrefixes: ["scripts", "scripts/package.json"],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(exact).toEqual({ ok: true, findings: [] });
  });

  it("an absent or empty prefixes list refuses every path (fail closed)", () => {
    for (const allowedPathPrefixes of [[], undefined]) {
      const verdict = checkLaneDiff({
        changedPaths: [{ path: "packages/x/src/a.ts", status: "modified" }],
        ...(allowedPathPrefixes !== undefined ? { allowedPathPrefixes } : {}),
      } as unknown as Parameters<typeof checkLaneDiff>[0]);
      expect(verdict.findings).toEqual([
        { path: "packages/x/src/a.ts", rule: "outside-allowed-paths" },
        { path: "packages/x/src/a.ts", rule: "secret-patterns-missing" },
      ]);
    }
  });

  it("an empty secretPatterns list is a refusal finding, never a silent pass", () => {
    const verdict = checkLaneDiff({
      changedPaths: [
        {
          path: "packages/x/src/a.ts",
          status: "modified",
          addedLines: [{ line: 1, text: "export const a = 2;" }],
        },
      ],
      allowedPathPrefixes: PREFIXES,
      secretPatterns: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toEqual([
      { path: "packages/x/src/a.ts", rule: "secret-patterns-missing" },
    ]);
  });
});

describe("validateAllowedPathPrefix (brief prepare)", () => {
  it("accepts ordinary relative prefixes", () => {
    for (const prefix of [
      "packages/x/src",
      "docs",
      "README.md",
      "packages/x/",
    ]) {
      expect(validateAllowedPathPrefix(prefix)).toBeNull();
    }
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["absolute path", "/etc/passwd"],
    ["parent traversal", "packages/../.."],
    ["leading dot-dot", "../escape"],
    ["git plumbing", ".git"],
    ["git plumbing subdir", ".git/hooks/pre-commit"],
    ["lane plumbing", ".lane"],
    ["lane plumbing subdir", ".lane/brief.md"],
  ])("refuses %s (%j)", (_label, prefix) => {
    expect(validateAllowedPathPrefix(prefix)).not.toBeNull();
  });
});

describe("pathUnderPrefix", () => {
  it("matches the prefix itself and anything under it, never a sibling", () => {
    expect(pathUnderPrefix("packages/x", "packages/x")).toBe(true);
    expect(pathUnderPrefix("packages/x/src/a.ts", "packages/x")).toBe(true);
    expect(pathUnderPrefix("packages/x/src/a.ts", "packages/x/")).toBe(true);
    expect(pathUnderPrefix("packages/xtra/a.ts", "packages/x")).toBe(false);
  });
});

describe("checkLaneDiff (policy additions are never lifted, O14d1 S3)", () => {
  it("a policy-protected path applies even when the brief explicitly allows the fixed protected prefix", () => {
    const verdict = checkLaneDiff({
      changedPaths: [{ path: ".github/workflows/ci.yml", status: "modified" }],
      allowedPathPrefixes: [".github"],
      policyProtectedPaths: [".github/workflows/"],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(verdict.findings).toEqual([
      { path: ".github/workflows/ci.yml", rule: "protected-path" },
    ]);
  });
});

describe("isFixedProtectedPath (script parity, O14d1)", () => {
  function hasShAndGit(): boolean {
    for (const [cmd, args] of [
      ["sh", ["-c", "exit 0"]],
      ["git", ["--version"]],
    ] as const) {
      const res = spawnSync(cmd, args, { stdio: "ignore" });
      if (res.error || res.status !== 0) return false;
    }
    return true;
  }

  /**
   * Partition fixture paths into batches where no two paths in the same batch
   * collide case-insensitively on any path prefix, so case-insensitive volumes
   * (macOS APFS) keep the exact casing of every fixture path.
   */
  function partitionCaseSafe(paths: readonly string[]): string[][] {
    const batches: {
      paths: string[];
      prefixes: Map<string, string>;
      files: Set<string>;
    }[] = [];
    for (const relPath of paths) {
      const parts = relPath.split("/");
      const prefixes: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        prefixes.push(parts.slice(0, i + 1).join("/"));
      }
      let placed = false;
      for (const batch of batches) {
        const collides = prefixes.some((p) => {
          const lower = p.toLowerCase();
          if (batch.files.has(lower)) return true;
          const existing = batch.prefixes.get(lower);
          if (existing === undefined) return false;
          return p === relPath || existing !== p;
        });
        if (!collides) {
          for (const p of prefixes) {
            batch.prefixes.set(p.toLowerCase(), p);
          }
          batch.files.add(relPath.toLowerCase());
          batch.paths.push(relPath);
          placed = true;
          break;
        }
      }
      if (!placed) {
        const prefixMap = new Map<string, string>();
        for (const p of prefixes) {
          prefixMap.set(p.toLowerCase(), p);
        }
        batches.push({
          paths: [relPath],
          prefixes: prefixMap,
          files: new Set([relPath.toLowerCase()]),
        });
      }
    }
    return batches.map((b) => b.paths);
  }

  /**
   * Write the fixture paths as files into temporary git repository batches,
   * run the real `sh scripts/lane-diff-check.sh <repo>`, and collect its
   * `protected: <path>` lines.
   */
  function runRealScriptProtectedSet(paths: readonly string[]): Set<string> {
    const scriptPath = path.join(repoRoot(), "scripts", "lane-diff-check.sh");
    const protectedSet = new Set<string>();
    for (const batch of partitionCaseSafe(paths)) {
      const tmpRepo = mkdtempSync(path.join(os.tmpdir(), "ldc-parity-"));
      try {
        execFileSync("git", ["init", "-q", "."], {
          cwd: tmpRepo,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "core.excludesFile", "/dev/null"], {
          cwd: tmpRepo,
          stdio: "ignore",
        });
        for (const relPath of batch) {
          const fullPath = path.join(tmpRepo, relPath);
          mkdirSync(path.dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, "x\n");
        }
        const res = spawnSync("sh", [scriptPath, tmpRepo], {
          encoding: "utf8",
        });
        expect([0, 1]).toContain(res.status);
        for (const outLine of (res.stdout ?? "").split("\n")) {
          const match = /^protected: (.+)$/.exec(outLine);
          if (match) {
            protectedSet.add(match[1]);
          }
        }
      } finally {
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    }
    return protectedSet;
  }

  /**
   * Shared fixture for the shell/domain parity: every protected rule against
   * root and nested paths, case variants, and non-protected look-alikes
   * (L1b item 4, fix-1).
   */
  const PROTECTED_FIXTURE: readonly [string, boolean][] = [
    // Yarn/npm/manifest at any depth, case-insensitively (L1b item 1, fix-1).
    [".yarnrc", true],
    ["packages/x/.yarnrc", true],
    [".yarnrc.yml", true],
    [".Yarnrc.yml", true],
    ["packages/app/.yarnrc.yml", true],
    [".npmrc", true],
    [".NPMRC", true],
    ["packages/x/.npmrc", true],
    [".yarn/plugins/plugin.js", true],
    [".Yarn/plugins/x", true],
    [".yarn/releases/yarn.cjs", true],
    [".yarn/patches/pkg.patch", true],
    [".pnp.cjs", true],
    [".PNP.cjs", true],
    [".pnp.loader.mjs", true],
    ["package.json", true],
    ["Package.json", true],
    ["packages/x/package.json", true],
    ["packages/a/b/c/package.json", true],
    ["node_modules/pkg/package.json", false],
    ["packages/x/node_modules/y/package.json", false],
    ["node_modules/AGENTS.md", true],
    ["packages/app/node_modules/.cursorrules", true],
    ["node_modules/x/.yarnrc", true],
    ["node_modules/x/.gitattributes", true],
    ["mypackage.jsonc", false],
    ["package.jsonc", false],
    ["yarn.lock", true],
    ["packages/x/yarn.lock", true],
    ["package-lock.json", true],
    ["packages/x/package-lock.json", true],
    ["pnpm-lock.yaml", true],
    // Agent instruction and tool files at any depth, case-insensitively (L1b item 2).
    ["AGENTS.md", true],
    ["packages/app/AGENTS.md", true],
    ["packages/app/agents.md", true],
    ["CLAUDE.md", true],
    ["packages/app/CLAUDE.md", true],
    ["CLAUDE.local.md", true],
    ["packages/app/claude.local.md", true],
    ["GEMINI.md", true],
    ["packages/app/gemini.md", true],
    [".mcp.json", true],
    ["packages/app/.mcp.json", true],
    [".cursor/rules.mdc", true],
    ["packages/app/.cursor/rules.mdc", true],
    [".cursorrules", true],
    ["packages/app/.cursorrules", true],
    [".windsurfrules", true],
    ["packages/app/.WindsurfRules", true],
    [".github/copilot-instructions.md", true],
    ["packages/app/.github/copilot-instructions.md", true],
    [".vscode/tasks.json", true],
    ["packages/app/.vscode/launch.json", true],
    [".envrc", true],
    ["packages/app/.envrc", false],
    [".husky/pre-commit", true],
    ["packages/app/.husky/pre-commit", false],
    ["Makefile", true],
    ["makefile", true],
    ["GNUmakefile", true],
    ["packages/app/Makefile", false],
    // Git plumbing and the existing root-only classes.
    [".gitattributes", true],
    ["packages/x/.gitattributes", true],
    [".gitmodules", true],
    ["packages/x/.gitmodules", true],
    [".github/workflows/ci.yml", true],
    ["packages/app/.github/workflows/ci.yml", false],
    [".claude/settings.json", true],
    ["packages/app/.claude/settings.json", true],
    [".opencode/opencode.json", true],
    ["opencode.json", true],
    ["opencode.jsonc", true],
    ["OpenCode.JSON5", true],
    [".gemini/settings.json", true],
    [".agents/x.json", true],
    [".agy/lane.txt", true],
    [".lane/brief.md", true],
    ["bin/tool.sh", true],
    ["scripts/tool.sh", true],
    [".architecture/manifest.yaml", true],
    ["deploy/x.yaml", true],
    ["installation/config.yaml", true],
    ["Dockerfile", true],
    ["packages/app/Dockerfile", false],
    // Look-alikes.
    ["docs/claude.md.txt", false],
    ["docs/claude.md", true],
    ["myAGENTS.md.bak", false],
    ["packages/app/CLAUDE.md.backup", false],
  ];

  it("the exported table matches scripts/lane-diff-check.protected row for row", () => {
    const ruleFile = path.join(
      repoRoot(),
      "scripts",
      "lane-diff-check.protected",
    );
    const rows = readFileSync(ruleFile, "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed !== "" && !trimmed.startsWith("#");
      })
      .map((line) => {
        const fields = line.split("\t");
        expect(fields).toHaveLength(3);
        const [pattern, anyDepth, caseInsensitive] = fields;
        expect(Number(caseInsensitive)).toBe(1);
        return [pattern, Number(anyDepth), Number(caseInsensitive)];
      });
    expect(rows.length).toBeGreaterThanOrEqual(35);
    expect(
      PROTECTED_PATH_RULES.map((rule) => [
        rule.pattern,
        rule.anyDepth ? 1 : 0,
        rule.caseInsensitive ? 1 : 0,
      ]),
    ).toEqual(rows);
  });

  it.skipIf(!hasShAndGit())(
    "shell and domain reach the same verdict on the shared fixture list (L1b item 4)",
    () => {
      expect(PROTECTED_FIXTURE.length).toBeGreaterThanOrEqual(40);
      const shellProtected = runRealScriptProtectedSet(
        PROTECTED_FIXTURE.map(([relPath]) => relPath),
      );
      for (const [relPath, expected] of PROTECTED_FIXTURE) {
        const ts = isFixedProtectedPath(relPath);
        const shell = shellProtected.has(relPath);
        expect({ path: relPath, ts, shell }).toEqual({
          path: relPath,
          ts: expected,
          shell: expected,
        });
      }
    },
    // It runs the real script over 40+ paths in a temporary repository: about 8 s under load.
    60_000,
  );

  it("also covers the plan's additions, case-variant yarn/npm/package rules, and non-package.json rules under node_modules", () => {
    for (const sample of [
      ".git/hooks/pre-commit",
      "installation/config.yaml",
      "package-lock.json",
      "pnpm-lock.yaml",
      ".lane/brief.md",
      ".Claude/settings.json",
      "packages/app/.claude/settings.json",
      "packages/app/.OpenCode/opencode.json",
      "opencode.jsonc",
      "packages/app/opencode.jsonc",
      "OpenCode.JSON5",
      "Package.json",
      ".Yarnrc.yml",
      ".NPMRC",
      ".PNP.cjs",
      ".Yarn/plugins/x",
      "node_modules/AGENTS.md",
      "packages/app/node_modules/.cursorrules",
      "node_modules/x/.yarnrc",
      "node_modules/x/.gitattributes",
    ]) {
      expect(isFixedProtectedPath(sample), sample).toBe(true);
    }
    for (const allowed of [
      // ASCII-only folding, as the shell's grep -i under LC_ALL=C: U+017F (long s) is not "s".
      ".hu\u017Fky/pre-commit",
      "foo/.git/config",
      "node_modules/pkg/package.json",
      "packages/x/node_modules/y/package.json",
    ]) {
      expect(isFixedProtectedPath(allowed), allowed).toBe(false);
    }
  });

  it("a supplied regex carrying the g flag still matches on every line", () => {
    // With `g` kept, lastIndex would survive across `.test()` calls and the
    // second line would silently be skipped.
    const verdict = check(
      [
        {
          path: "packages/x/src/a.ts",
          status: "modified",
          addedLines: [
            { line: 1, text: `const t = "${tok}";` },
            { line: 2, text: `const u = "${tok}";` },
          ],
        },
      ],
      {
        secretPatterns: [
          { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
        ],
      },
    );
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
      {
        path: "packages/x/src/a.ts",
        line: 2,
        rule: "secret-pattern:github-token",
      },
    ]);
  });
});

describe("checkLaneDiff (KF-27: base-line allowance, symlinks, helper config keys)", () => {
  it("a hit on a line the base already had is excused", () => {
    const fixture = `const fixture = "${tok}";`;
    // Without a known base the same content fails.
    const withoutBase = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [
          { line: 1, text: "export const a = 2;" },
          { line: 2, text: fixture },
        ],
      },
    ]);
    expect(withoutBase.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 2,
        rule: "secret-pattern:github-token",
      },
    ]);
    // The base already held that exact line: excused.
    const excused = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [
          { line: 1, text: "export const a = 2;" },
          { line: 2, text: fixture },
        ],
        baseLines: ["export const a = 1;", fixture],
      },
    ]);
    expect(excused).toEqual({ ok: true, findings: [] });
  });

  it("a second copy beyond the base count fails on the copy's line", () => {
    const fixture = `const fixture = "${tok}";`;
    const verdict = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [
          { line: 1, text: fixture },
          { line: 2, text: fixture },
        ],
        baseLines: [fixture],
      },
    ]);
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 2,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a changed line the base had in a different form is not excused", () => {
    const verdict = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [{ line: 1, text: `const t = "${tok}";` }],
        baseLines: [`const t = "${tok}" // different text`],
      },
    ]);
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("baseLines null excuses nothing (fail closed: unknown base)", () => {
    const fixture = `const fixture = "${tok}";`;
    const verdict = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [{ line: 1, text: fixture }],
        baseLines: null,
      },
    ]);
    expect(verdict.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 1,
        rule: "secret-pattern:github-token",
      },
    ]);
  });

  it("a line hit by two patterns is excused or not as one line", () => {
    // One line matching two patterns, base has it once: one excusal.
    // The password value is built at runtime so this file holds no credential-shaped literal.
    const pw = ["hunter2", "hunter2"].join("");
    const both = `const t = "${tok}"; password = "${pw}";`;
    const excused = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [{ line: 1, text: both }],
        baseLines: [both],
      },
    ]);
    expect(excused).toEqual({ ok: true, findings: [] });
    // The base has it once but the file carries it twice: the second copy
    // fails once per pattern, on the copy's line.
    const secondCopy = check([
      {
        path: "packages/x/src/a.ts",
        status: "modified",
        addedLines: [
          { line: 1, text: both },
          { line: 2, text: both },
        ],
        baseLines: [both],
      },
    ]);
    expect(secondCopy.findings).toEqual([
      {
        path: "packages/x/src/a.ts",
        line: 2,
        rule: "secret-pattern:github-token",
      },
      {
        path: "packages/x/src/a.ts",
        line: 2,
        rule: "secret-pattern:password-assignment",
      },
    ]);
  });

  it("a changed path that is a symbolic link is a symlink finding even when its target stays inside the worktree", () => {
    const verdict = check([
      {
        path: "packages/x/src/link.ts",
        status: "added",
        addedLines: [{ line: 1, text: "../other.ts" }],
        isSymlink: true,
      },
    ]);
    expect(verdict.findings).toEqual([
      { path: "packages/x/src/link.ts", rule: "symlink" },
    ]);
  });

  it("helper config keys produce one finding each, deduplicated, with no value", () => {
    const verdict = check([
      { path: "packages/x/src/a.ts", status: "modified" },
    ], {
      helperConfigKeys: [
        "credential.<sub>.helper",
        "core.fsmonitor",
        "credential.<sub>.helper",
      ],
    });
    expect(verdict.findings).toEqual([
      { path: ".git/config", rule: "git-config-helper:credential.<sub>.helper" },
      { path: ".git/config", rule: "git-config-helper:core.fsmonitor" },
    ]);
  });
});
