#!/usr/bin/env node
// HF1: static check that every relative import specifier in TypeScript
// source carries an explicit file extension, so plain Node ESM can resolve
// it after the build. Vitest resolves extensionless imports, unit tests
// miss this class of breakage; the built CLI does not.
//
// Usage:
//   node scripts/check-relative-import-extensions.mjs [--root <dir>]
//   node scripts/check-relative-import-extensions.mjs -h | --help
//
// Exit codes: 0 clean, 1 at least one extensionless relative import found,
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
// and bare-form imports. Block comments between `(` and the specifier
// (`import(/* webpackChunkName: "lazy" */ './lazy')`) are allowed through.
// Specifiers are single-line by syntax.
const FROM_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*(?:\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/\s*)*|\bimport\s+)(["'])((?:\.\.?)\/[^"']+)\1/g;
const HELP = `Usage: node ${NAME}.mjs [--root <dir>]
Checks every packages/*/src and apps/*/src TypeScript source for relative
imports missing an explicit file extension (plain Node ESM resolution).

Exit codes: 0 clean, 1 findings, 2 usage or unreadable input.`;

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

// Walk the tree depth-first; unreadable entries are usage errors (exit 2),
// never silent skips.
function collectSources(dir, root, out) {  let entries;
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

// Resolve whether a workspace's TypeScript is emitted (its tsconfig carries
// an outDir), following relative `extends` links. `extends` targets are
// resolved as relative paths only (package-specifier extends cannot be
// resolved with node:fs alone and end the chain). A config that exists but
// cannot be read or parsed is refused loudly (exit 2), never a silent skip;
// a missing link simply ends the chain, and a chain with no outDir anywhere
// means the workspace emits nothing under plain Node (out of scope).
function resolveOutDir(configPath, root) {
  let current = configPath;
  const visited = new Set();
  for (let depth = 0; depth < 32; depth++) {
    if (visited.has(current)) {
      console.error(`${NAME}: extends cycle at ${path.relative(root, current)}`);
      process.exit(2);
    }
    visited.add(current);
    let text;
    try {
      text = readFileSync(current, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      console.error(`${NAME}: cannot read tsconfig ${path.relative(root, current)}`);
      process.exit(2);
    }
    if (/"outDir"\s*:/.test(text)) return true;
    const extendsMatch = /"extends"\s*:\s*"([^"]+)"/.exec(text);
    if (!extendsMatch) return undefined;
    const target = extendsMatch[1];
    if (!target.startsWith(".")) return undefined;
    let next = path.resolve(path.dirname(current), target);
    if (path.extname(next) === "") next += ".json";
    if (path.extname(next) !== ".json") return undefined;
    current = next;
  }
  console.error(`${NAME}: extends chain too deep at ${path.relative(root, configPath)}`);
  process.exit(2);
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

  const files = [];
  for (const top of ["packages", "apps"]) {
    const topDir = path.join(root, top);
    let tops;
    try {
      tops = statSync(topDir).isDirectory() ? readdirSync(topDir) : [];
    } catch {
      tops = [];
    }
    for (const pkg of tops.sort()) {
      const src = path.join(topDir, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue; // no src directory in this workspace
      }
      // Only workspaces whose TypeScript is EMITTED (tsconfig outDir, found
      // locally or inherited through the relative `extends` chain) run their
      // built files under plain Node ESM; trees that are never emitted
      // (Next.js app, bundled server, component library) resolve through a
      // bundler and are out of scope for this check.
      const emitted = resolveOutDir(path.join(topDir, pkg, "tsconfig.json"), root);
      if (emitted) collectSources(src, root, files);
    }
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
