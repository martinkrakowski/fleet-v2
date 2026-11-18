#!/usr/bin/env node
// HF1: static check that every relative import specifier in TypeScript
// source carries an explicit file extension, so plain Node ESM can resolve
// it after the build. Vitest resolves extensionless imports, unit tests
// miss this class of breakage; the built CLI does not.
//
// Which workspaces are checked is an EXPLICIT workspace list, never inferred
// from tsconfig files: the workspaces are enumerated read-only from the root
// package.json `workspaces` globs, then classified as CHECKED or EXCLUDED.
// CHECKED: every `packages/*` workspace, plus `apps/cli`, `apps/api` and
// `apps/mcp` (the last is tsc-emitted like the CLI, not bundler-built).
// EXCLUDED: only bundler-built apps, each named with a one-line reason.
// Any enumerated workspace in neither list is an error, never a silent skip.
//
// Usage:
//   node scripts/check-relative-import-extensions.mjs [--root <dir>]
//   node scripts/check-relative-import-extensions.mjs -h | --help
//
// Exit codes: 0 clean, 1 at least one finding (or an unclassified workspace),
// 2 usage error or unreadable file/directory.
//
// Only node:fs and node:path are used; no shell, no child process.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const NAME = "check-relative-import-extensions";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
// Specifiers ending in one of these are resolvable by Node without change.
const OK_SUFFIXES = [".js", ".mjs", ".cjs", ".json", ".css", ".node"];
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const TEST_SUFFIX = /(\.test\.|\.spec\.)[^/]*$/;
// Static imports, re-exports and dynamic imports with a relative specifier.
// `from '<spec>'` covers `import ... from`, `import type ... from` and
// `export ... from`; `import( '<spec>'` and `import '<spec>'` cover dynamic
// and bare-form imports. Matching runs on comment-stripped source (see
// stripComments), so comments before or between the keywords and the
// specifier cannot hide one. Specifiers are single-line by syntax.
const FROM_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])((?:\.\.?)\/[^"']+)\1/g;
// Bundler-built workspaces, excluded with a reason each. This list is the
// only way out of the check; a workspace absent from both lists is an error.
const EXCLUDED = new Map([
  ["apps/web", "bundler-built Next.js app, never resolved by plain Node ESM"],
  [
    "packages/ui",
    "noEmit component library consumed only through the bundler-built apps/web",
  ],
]);
// Workspaces always checked, besides every `packages/*` workspace.
const CHECKED_APPS = new Set(["apps/cli", "apps/api", "apps/mcp"]);
const HELP = `Usage: node ${NAME}.mjs [--root <dir>]
Checks every CHECKED workspace's TypeScript source for relative imports
missing an explicit file extension (plain Node ESM resolution). CHECKED is
the explicit list in the script (every packages/* workspace plus the
tsc-emitted apps); only bundler-built apps are excluded by name.

Exit codes: 0 clean, 1 findings or unclassified workspace, 2 usage or
unreadable input.`;

function usageError(message) {
  console.error(`${NAME}: ${message}`);
  console.error(HELP);
  process.exit(2);
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        usageError("--root requires a directory argument");
      }
      root = value;
      i++;
    } else {
      usageError(`unknown argument ${arg}`);
    }
  }
  return root;
}

// Walk the tree depth-first; unreadable entries are errors (exit 2),
// never silent skips.
function collectSources(dir, root, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`${NAME}: cannot read directory ${path.relative(root, dir) || "."}`);
    process.exit(2);
  }
  for (const entry of entries.sort()) {
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      console.error(`${NAME}: cannot read ${path.relative(root, full)}`);
      process.exit(2);
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectSources(full, root, out);
    } else if (
      stats.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry)) &&
      !TEST_SUFFIX.test(entry)
    ) {
      out.push(full);
    }
  }
}

// Strip block and line comments from source while preserving every
// character position (comments become spaces, newlines are kept), so
// match indexes still map to the original line numbers. Strings are
// tracked so a quote inside a comment or a comment marker inside a
// string does not derail the scan.
//
// Known limitation, accepted deliberately: this is a string-aware single
// pass, not a parser. Comment markers (`//`, `/*`) that appear inside a
// string or template literal are handled (the string state consumes them),
// but a quote inside a comment is consumed as part of the comment, and a
// regular-expression literal containing a quote or a comment marker can
// still confuse the strip. Real source files that trip this would need a
// real parser; the check prefers loud over silent either way.
function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  // 0 code, 1 line comment, 2 block comment, 3 'string, 4 "string, 5 template
  let state = 0;
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : "";
    if (state === 0) {
      if (c === "/" && d === "/") {
        state = 1;
        out += "  ";
        i += 2;
      } else if (c === "/" && d === "*") {
        state = 2;
        out += "  ";
        i += 2;
      } else {
        if (c === "'" || c === '"' || c === "`") state = c === "'" ? 3 : c === '"' ? 4 : 5;
        out += c;
        i++;
      }
    } else if (state === 1) {
      if (c === "\n") {
        state = 0;
        out += c;
      } else {
        out += " ";
      }
      i++;
    } else if (state === 2) {
      if (c === "*" && d === "/") {
        state = 0;
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i++;
      }
    } else {
      // Inside a string: escapes skip the next character verbatim.
      if (c === "\\") {
        out += c + d;
        i += 2;
        continue;
      }
      const close = state === 3 ? "'" : state === 4 ? '"' : "`";
      if (c === close) state = 0;
      out += c;
      i++;
    }
  }
  return out;
}

// One pass per source file: every static `import ... from`, `export ... from`
// and `import(...)` whose specifier starts with `./` or `../` and carries no
// resolvable suffix is a finding. Linear in the file length.
function scanFile(file, root, findings) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`${NAME}: cannot read file ${path.relative(root, file)}`);
    process.exit(2);
  }
  text = stripComments(text);
  const rel = path.relative(root, file);
  const lines = text.split("\n");
  const hits = [];
  let match;
  FROM_SPECIFIER.lastIndex = 0;
  while ((match = FROM_SPECIFIER.exec(text)) !== null) {
    hits.push({ specifier: match[2], index: match.index + match[0].length - match[2].length - 1 });
  }
  for (const { specifier, index } of hits) {
    if (!OK_SUFFIXES.some((suffix) => specifier.endsWith(suffix))) {
      // The 1-based line of the specifier's closing quote; specifiers are
      // single-line by syntax.
      let lineNo = 1;
      let offset = 0;
      for (let i = 0; i < lines.length && offset <= index; i++) {
        lineNo = i + 1;
        offset += lines[i].length + 1;
      }
      findings.push(`${rel}:${lineNo} ${specifier}`);
    }
  }
}

// Enumerate the workspaces named by the root package.json `workspaces`
// globs, read-only. Only `<dir>/*` globs are supported; anything else is
// refused loudly rather than guessed at.
function enumerateWorkspaces(root) {
  let text;
  try {
    text = readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    console.error(`${NAME}: cannot read ${path.join("package.json")} under --root ${root}`);
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    console.error(`${NAME}: cannot parse package.json under --root ${root}`);
    process.exit(2);
  }
  const globs = manifest?.workspaces;
  if (!Array.isArray(globs)) {
    console.error(`${NAME}: package.json has no workspaces array under --root ${root}`);
    process.exit(2);
  }
  const workspaces = [];
  for (const glob of globs) {
    if (typeof glob !== "string") continue;
    const star = glob.indexOf("/*");
    if (star === -1 || star !== glob.length - 2) {
      console.error(`${NAME}: unsupported workspaces glob ${glob} (only <dir>/* is supported)`);
      process.exit(2);
    }
    const base = path.join(root, glob.slice(0, star));
    let entries;
    try {
      entries = readdirSync(base);
    } catch (error) {
      if (error && error.code === "ENOENT") continue; // glob matches nothing
      console.error(`${NAME}: cannot read workspaces directory ${path.relative(root, base)}`);
      process.exit(2);
    }
    for (const entry of entries.sort()) {
      try {
        if (statSync(path.join(base, entry)).isDirectory()) {
          workspaces.push(`${glob.slice(0, star)}/${entry}`);
        }
      } catch {
        console.error(`${NAME}: cannot read ${path.relative(root, path.join(base, entry))}`);
        process.exit(2);
      }
    }
  }
  return workspaces;
}

function main() {
  const root = parseArgs(process.argv.slice(2));
  let rootStats;
  try {
    rootStats = statSync(root);
  } catch {
    usageError(`cannot read --root directory ${root}`);
  }
  if (!rootStats.isDirectory()) {
    usageError(`--root ${root} is not a directory`);
  }

  const workspaces = enumerateWorkspaces(root);
  const checked = [];
  for (const workspace of workspaces) {
    if (EXCLUDED.has(workspace)) continue;
    if (workspace.startsWith("packages/") || CHECKED_APPS.has(workspace)) {
      checked.push(workspace);
      continue;
    }
    // Neither checked nor excluded: fail loudly, name the workspace.
    console.error(
      `${NAME}: unclassified workspace ${workspace}: add it to CHECKED or EXCLUDED with a reason`
    );
    process.exit(1);
  }

  const files = [];
  for (const workspace of checked) {
    const src = path.join(root, workspace, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue; // no src directory in this workspace
    }
    // A listed workspace is checked regardless of its tsconfig: emission is
    // decided by the explicit list above, never inferred from tsconfig.
    collectSources(src, root, files);
  }

  const findings = [];
  for (const file of files.sort()) scanFile(file, root, findings);
  for (const finding of findings) console.log(finding);
  if (findings.length > 0) {
    console.error(
      `${NAME}: ${findings.length} extensionless relative import${findings.length === 1 ? "" : "s"}`
    );
    process.exit(1);
  }
  process.exit(0);
}

main();
