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

// Lexicographic comparator so no `.sort()` runs without an explicit
// compare function (S2871).
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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
  for (const entry of entries.sort(compareStrings)) {
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

// The character that closes the given string state: 3 single, 4 double,
// 5 template.
function closeState(state) {
  if (state === 3) return "'";
  if (state === 4) return '"';
  return "`";
}

// Strip block and line comments from source while preserving every
// character position (comments become spaces, newlines are kept), so
// match indexes still map to the original line numbers. String and
// template-static-text contents are blanked to spaces (newlines kept,
// character count preserved) while the quote and backtick delimiters are
// kept, so an `import(...)` or `from '...'` written inside a string
// literal or static template text is never matched by FROM_SPECIFIER.
// The one exception: a quoted string that is itself the specifier of a
// `from`/`import` (recognised by the collapsed code context before its
// opening quote) keeps its content, so real findings stay matchable.
// Template `${...}` interpolations stay code: `${` pushes a frame onto
// ctx.templateStack and returns to the code state, and the matching `}`
// (counted with brace depth, nested templates included) pops the frame
// and returns to the template.
//
// Cost: O(n) time and O(n) space in the input length n — a single pass
// building one output string; the interpolation stack holds at most one
// frame per unclosed `${`.
//
// The scanner is split into one handler per lexer state (code, line
// comment, block comment, string, template), each small enough to audit
// on its own; stripComments only runs the state loop and dispatches
// through a lookup table indexed by state.
//
// Known limitation, accepted deliberately: this is a string-aware single
// pass, not a parser. Comment markers (`//`, `/*`) that appear inside a
// string or template literal are handled (the string state consumes them),
// but a quote inside a comment is consumed as part of the comment, and a
// regular-expression literal containing a quote or a comment marker can
// still confuse the strip. Real source files that trip this would need a
// real parser; the check prefers loud over silent either way.
function stripComments(text) {
  const ctx = { text, out: "", i: 0, state: 0, templateStack: [], buf: "", tail: "" };
  const handlers = [
    handleCode,
    handleLineComment,
    handleBlockComment,
    handleString,
    handleString,
    handleTemplate,
  ];
  while (ctx.i < text.length) handlers[ctx.state](ctx);
  return ctx.out;
}

// Upper bound on the collapsed code-context tail kept in ctx.tail; the
// longest token run a specifier can follow (`import (`) is far below it.
const TAIL_LIMIT = 24;
// A quoted string whose immediately preceding collapsed code context
// ends like this is the specifier of a `from`/`import`: its content is
// kept instead of blanked so real findings stay matchable. Whitespace
// runs (real, or comment-blanked) have collapsed to one space.
const SPECIFIER_BEFORE = /(?:\bfrom |\bimport \(|\bimport\(|\bimport )\s*$/;

// Append emitted code text to the collapsed tail: whitespace runs become
// one space and only the last TAIL_LIMIT characters are kept, so the
// update is O(1) per emitted character.
function pushTail(ctx, s) {
  ctx.tail = (ctx.tail + s).replace(/\s+/g, " ").slice(-TAIL_LIMIT);
}

// Lexer state 0: code. A comment marker enters its state; a quote enters
// the string state for that quote. Inside a template interpolation
// (ctx.templateStack non-empty) braces are counted: `{` deepens the
// interpolation, and a `}` at depth 0 closes it and returns to the
// template literal state.
function handleCode(ctx) {
  const c = ctx.text[ctx.i];
  const d = ctx.i + 1 < ctx.text.length ? ctx.text[ctx.i + 1] : "";
  if (c === "/" && d === "/") {
    ctx.state = 1;
    ctx.out += "  ";
    ctx.i += 2;
    return; // a comment is whitespace to the tail: pushTail untouched
  }
  if (c === "/" && d === "*") {
    ctx.state = 2;
    ctx.out += "  ";
    ctx.i += 2;
    return; // a comment is whitespace to the tail: pushTail untouched
  }
  if (c === "'") {
    ctx.state = 3;
    ctx.buf = "";
    ctx.out += c;
    ctx.i += 1;
    return; // the opening quote never enters the tail: the specifier
            // decision at close must see the context before it
  }
  if (c === '"') {
    ctx.state = 4;
    ctx.buf = "";
    ctx.out += c;
    ctx.i += 1;
    return;
  }
  if (c === "`") {
    ctx.state = 5;
    ctx.out += c;
    ctx.i += 1;
    return;
  }
  if (ctx.templateStack.length > 0 && (c === "{" || c === "}")) {
    const top = ctx.templateStack.length - 1;
    if (c === "{") {
      ctx.templateStack[top] += 1;
    } else if (ctx.templateStack[top] === 0) {
      ctx.templateStack.pop();
      ctx.state = 5;
    } else {
      ctx.templateStack[top] -= 1;
    }
  }
  pushTail(ctx, c);
  ctx.out += c;
  ctx.i += 1;
}

// Lexer state 1: inside a line comment. The newline ends it.
function handleLineComment(ctx) {
  const c = ctx.text[ctx.i];
  if (c === "\n") {
    ctx.state = 0;
    ctx.out += c;
  } else {
    ctx.out += " ";
  }
  ctx.i += 1;
}

// Lexer state 2: inside a block comment. `*/` ends it; newlines are kept
// so line numbers still match the original.
function handleBlockComment(ctx) {
  const c = ctx.text[ctx.i];
  const d = ctx.i + 1 < ctx.text.length ? ctx.text[ctx.i + 1] : "";
  if (c === "*" && d === "/") {
    ctx.state = 0;
    ctx.out += "  ";
    ctx.i += 2;
    return;
  }
  if (c === "\n") {
    ctx.out += "\n";
  } else {
    ctx.out += " ";
  }
  ctx.i += 1;
}

// Lexer states 3–4: inside a quoted string. The content is buffered;
// escapes consume the escaped character so an escaped quote cannot close
// the string. On the closing quote the buffered content is either kept
// verbatim (the string is a from/import specifier, recognised by the
// collapsed code context before its opening quote) or replaced with
// spaces (newlines kept, character count preserved), so an `import(...)`
// or `from '...'` written inside a string literal is never matched. The
// closing quote is kept verbatim and returns to code.
function handleString(ctx) {
  const c = ctx.text[ctx.i];
  const d = ctx.i + 1 < ctx.text.length ? ctx.text[ctx.i + 1] : "";
  if (c === "\\") {
    ctx.buf += c + d;
    ctx.i += 2;
    return;
  }
  if (c === closeState(ctx.state)) {
    ctx.state = 0;
    ctx.out += SPECIFIER_BEFORE.test(ctx.tail) ? ctx.buf : ctx.buf.replace(/[^\n]/g, " ");
    ctx.buf = "";
    ctx.out += c;
    ctx.tail = ""; // the code before the string is consumed by it
    ctx.i += 1;
    return;
  }
  ctx.buf += c;
  ctx.i += 1;
}

// Lexer state 5: inside a template literal. Static text is replaced with
// spaces (newlines kept); the closing backtick is kept verbatim and
// returns to code; `${` opens an interpolation — it is kept, a 0 depth
// frame is pushed onto ctx.templateStack, and the scan returns to the
// code state until the matching `}` pops the frame (handleCode).
function handleTemplate(ctx) {
  const c = ctx.text[ctx.i];
  const d = ctx.i + 1 < ctx.text.length ? ctx.text[ctx.i + 1] : "";
  if (c === "\\") {
    ctx.out += " " + (d === "\n" ? "\n" : " ");
    ctx.i += 2;
    return;
  }
  if (c === "`") {
    ctx.state = 0;
    ctx.out += c;
    ctx.tail = ""; // the code before the template is consumed by it
    ctx.i += 1;
    return;
  }
  if (c === "$" && d === "{") {
    ctx.templateStack.push(0);
    ctx.state = 0;
    ctx.out += "${";
    pushTail(ctx, "${");
    ctx.i += 2;
    return;
  }
  ctx.out += c === "\n" ? "\n" : " ";
  ctx.i += 1;
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

// Read and parse the root package.json, or exit 2 naming the failure.
function readManifest(root) {
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
  return manifest;
}

// Require and return the `workspaces` array from the manifest.
function workspacesGlobs(manifest, root) {
  const globs = manifest?.workspaces;
  if (!Array.isArray(globs)) {
    console.error(`${NAME}: package.json has no workspaces array under --root ${root}`);
    process.exit(2);
  }
  return globs;
}

// Only `<dir>/*` globs are supported; anything else is refused loudly
// rather than guessed at.
function globBase(glob) {
  const star = glob.indexOf("/*");
  if (star === -1 || star !== glob.length - 2) {
    console.error(`${NAME}: unsupported workspaces glob ${glob} (only <dir>/* is supported)`);
    process.exit(2);
  }
  return glob.slice(0, star);
}

// Read the base directory's entries; null means the glob matched nothing.
function readEntries(base, root) {
  let entries;
  try {
    entries = readdirSync(base);
  } catch (error) {
    if (error?.code === "ENOENT") return null; // glob matches nothing
    console.error(`${NAME}: cannot read workspaces directory ${path.relative(root, base)}`);
    process.exit(2);
  }
  return entries;
}

// The base directory's immediate subdirectories as `<base>/<name>` names.
function subdirectories(base, prefix, root) {
  const dirs = [];
  const entries = readEntries(base, root);
  if (entries === null) return dirs;
  for (const entry of entries.sort(compareStrings)) {
    try {
      if (statSync(path.join(base, entry)).isDirectory()) {
        dirs.push(`${prefix}/${entry}`);
      }
    } catch {
      console.error(`${NAME}: cannot read ${path.relative(root, path.join(base, entry))}`);
      process.exit(2);
    }
  }
  return dirs;
}

// Enumerate the workspaces named by the root package.json `workspaces`
// globs, read-only.
function enumerateWorkspaces(root) {
  const globs = workspacesGlobs(readManifest(root), root);
  const workspaces = [];
  for (const glob of globs) {
    if (typeof glob !== "string") continue;
    const prefix = globBase(glob);
    workspaces.push(...subdirectories(path.join(root, prefix), prefix, root));
  }
  return workspaces;
}

// Every workspace is either checked or explicitly excluded; anything
// else fails loudly and names the workspace.
function classifyWorkspaces(workspaces) {
  const checked = [];
  for (const workspace of workspaces) {
    if (EXCLUDED.has(workspace)) continue;
    if (workspace.startsWith("packages/") || CHECKED_APPS.has(workspace)) {
      checked.push(workspace);
      continue;
    }
    console.error(
      `${NAME}: unclassified workspace ${workspace}: add it to CHECKED or EXCLUDED with a reason`
    );
    process.exit(1);
  }
  return checked;
}

// TypeScript sources of every checked workspace that has a src directory.
function collectCheckedSources(root, checked) {
  const files = [];
  for (const workspace of checked) {
    const src = path.join(root, workspace, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch (error) {
      if (error?.code === "ENOENT") continue; // no src directory in this workspace
      console.error(`${NAME}: cannot read ${path.relative(root, src)}`);
      process.exit(2);
    }
    // A listed workspace is checked regardless of its tsconfig: emission is
    // decided by the explicit list above, never inferred from tsconfig.
    collectSources(src, root, files);
  }
  return files;
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

  const checked = classifyWorkspaces(enumerateWorkspaces(root));
  const files = collectCheckedSources(root, checked);

  const findings = [];
  for (const file of files.sort(compareStrings)) scanFile(file, root, findings);
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
