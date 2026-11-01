#!/usr/bin/env node
// S4 of docs/planning/2026-10-30_tier2-speed-plan.md (SP-D5): fails when the lines a
// change adds contain a duplicated code block qualifying under SonarCloud's
// copy-paste-detection rule for JS/TS, run locally — at least MIN_TOKENS = 100
// successive duplicated tokens spread over at least MIN_LINES = 10 lines, with
// string literals normalised before comparison. SonarCloud blocked a reviewed PR on
// a 26-line copy; this check catches that in the lane gate instead of on the merge
// train.
//
// The thresholds and the exclusion patterns are SonarCloud's, not this script's:
// MIN_TOKENS, MIN_LINES and the literal normalisation are the rule's documented
// defaults, and the exclusions are read at run time from `.sonarcloud.properties`
// (`sonar.exclusions` and `sonar.cpd.exclusions`, comma-separated), so the two stay
// one source of truth. Nothing is ever printed but file names, line ranges and
// counts — never source text.
//
// Changed files are the added/modified/renamed files between the merge base of
// <base> and HEAD and the working tree, so an uncommitted lane is checked too,
// plus untracked non-ignored files; a block is reported only when at least one of
// its lines is one of those added lines.
//
// Usage:
//   node scripts/check-duplication.mjs --base <rev> [--root <dir>]
//   node scripts/check-duplication.mjs -h | --help
//
// Exit codes: 0 clean, 1 at least one duplicated block, 2 usage or setup error
// (not a git repo, unknown or unresolvable <base>, typescript not resolvable,
// unreadable .sonarcloud.properties, an unreadable eligible file).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "check-duplication";
const MIN_TOKENS = 100; // SonarCloud's duplicated-block threshold for JS/TS.
const MIN_LINES = 10;
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SKIP_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".output",
  "coverage",
]);
const LITERAL_TEXT = "LITERAL";
// Bytewise order, the same on every host and locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function usage(message) {
  console.error(
    `${NAME}: ${message}; usage: node scripts/${NAME}.mjs --base <rev> [--root <dir>]`,
  );
  process.exit(2);
}

let rootArg;
let baseArg;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    // Print this file's header comment, then stop.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    process.stdout.write(`${source.slice(0, source.indexOf("\nimport "))}\n`);
    process.exit(0);
  } else if (arg === "--base") {
    if (i + 1 >= process.argv.length) usage("--base needs a revision");
    i += 1;
    baseArg = process.argv[i];
  } else if (arg === "--root") {
    if (i + 1 >= process.argv.length) usage("--root needs a directory");
    i += 1;
    rootArg = process.argv[i];
  } else usage(`unexpected argument ${arg}`);
}
if (!baseArg) usage("--base <rev> is required");
// --base is a revision name only: never an option, never shell syntax. It is resolved to a
// commit sha (with --end-of-options) before any other git command sees it.
if (baseArg.startsWith("-") || !/^[A-Za-z0-9._/~^@{}-]{1,200}$/.test(baseArg)) {
  usage("--base must be a revision name");
}

try {
  let root;
  const gitDir = () => (rootArg ? path.resolve(rootArg) : process.cwd());
  function gitOrDie(args) {
    try {
      return execFileSync("git", ["-C", gitDir(), ...args], {
        maxBuffer: 1 << 28,
        encoding: "utf8",
      }).trim();
    } catch {
      console.error(`${NAME}: git ${args[0]} failed under ${gitDir()}`);
      process.exit(2);
    }
  }
  const top = gitOrDie(["rev-parse", "--show-toplevel"]);
  if (rootArg) {
    // --root must name the top of a git worktree, so no path outside it is ever read.
    let real;
    try {
      real = realpathSync(path.resolve(rootArg));
    } catch {
      usage("--root must be an existing directory");
    }
    if (real !== realpathSync(top)) usage("--root must be the top of a git worktree");
  }
  root = top;

  const baseSha = gitOrDie(["rev-parse", "--verify", "--end-of-options", `${baseArg}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) usage("--base did not resolve to a commit");
  const mergeBase = gitOrDie(["merge-base", baseSha, "HEAD"]).trim();
  const nulNames = (args) => gitOrDie(args).split("\0").filter(Boolean);
  // Added, modified and renamed files between the merge base and the working tree,
  // plus untracked non-ignored files.
  const changedNames = new Set([
    ...nulNames(["diff", "--name-only", "-z", "--diff-filter=AMR", mergeBase]),
    ...nulNames(["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  // An untracked file's lines are all added; git diff says nothing about it.
  const untracked = new Set(
    nulNames(["ls-files", "-z", "--others", "--exclude-standard"]),
  );
  const corpusNames = nulNames(["ls-files", "-z", "-co", "--exclude-standard"]);

  // Exclusions come from SonarCloud's own settings, one source of truth.
  let properties;
  try {
    properties = readFileSync(path.join(root, ".sonarcloud.properties"), "utf8");
  } catch {
    console.error(`${NAME}: cannot read .sonarcloud.properties under ${root}`);
    process.exit(2);
  }
  const property = (key) => {
    const line = properties.split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : "";
  };
  // Glob to RegExp: `**/` is zero or more directories, `**` anything, `*` within
  // one segment, `?` one non-slash character; anchored to the repository root.
  const globToRegExp = (glob) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\/|\*\*|\*|\?/g, (m) =>
          m === "**/"
            ? "(?:.*/)?"
            : m === "**"
              ? ".*"
              : m === "*"
                ? "[^/]*"
                : "[^/]",
        )}$`,
    );
  const excluded = `${property("sonar.exclusions")},${property("sonar.cpd.exclusions")}`
    .split(",")
    .filter(Boolean)
    .map(globToRegExp);

  const wanted = (rel) =>
    EXTENSIONS.has(path.extname(rel)) &&
    !rel.split("/").some((segment) => SKIP_SEGMENTS.has(segment)) &&
    !excluded.some((re) => re.test(rel));

  // TypeScript comes from the checked tree, so a trusted copy of this script
  // outside the worktree still uses the worktree's install.
  let ts;
  try {
    ts = createRequire(path.join(root, "package.json"))("typescript");
  } catch {
    console.error(`${NAME}: typescript is not resolvable from ${root}`);
    process.exit(2);
  }
  // Literal normalisation compares numeric SyntaxKind values: the reverse map
  // ts.SyntaxKind[kind] can return an alias (NoSubstitutionTemplateLiteral is
  // FirstTemplateToken, TemplateTail is LastTemplateToken), so string names
  // would miss template literal tokens.
  const literalKinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ]);
  const scriptKind = (rel) => {
    const ext = path.extname(rel);
    if (ext === ".tsx") return ts.ScriptKind.TSX;
    if (ext === ".jsx") return ts.ScriptKind.JSX;
    if (ext === ".ts" || ext === ".mts" || ext === ".cts")
      return ts.ScriptKind.TS;
    return ts.ScriptKind.JS;
  };

  // Leaf nodes (no children) other than EndOfFileToken are tokens; JSDoc nodes are
  // skipped. A file that fails to parse is still tokenised as far as the parser
  // goes — one bad file never crashes the check.
  function tokenNodes(node, sf, out) {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push(node);
      return out;
    }
    for (const child of children) {
      if (
        child.kind >= ts.SyntaxKind.FirstJSDocNode &&
        child.kind <= ts.SyntaxKind.LastJSDocNode
      )
        continue;
      tokenNodes(child, sf, out);
    }
    return out;
  }

  const cache = new Map(); // rel -> [{ text, line }]
  function tokens(rel) {
    const known = cache.get(rel);
    if (known) return known;
    const found = [];
    try {
      const text = readFileSync(path.join(root, rel), "utf8");
      const sf = ts.createSourceFile(
        rel,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        scriptKind(rel),
      );
      for (const node of tokenNodes(sf, sf, []))
        found.push({
          text: literalKinds.has(node.kind)
            ? LITERAL_TEXT
            : node.getText(sf),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
    } catch {
      // An eligible file that cannot be read is a scan failure, never an
      // empty token list: report it and refuse the scan.
      console.error(`${NAME}: cannot read ${rel} under ${root}`);
      process.exit(2);
    }
    cache.set(rel, found);
    return found;
  }

  const windowHash = (list, start) =>
    createHash("sha256")
      .update(
        list
          .slice(start, start + MIN_TOKENS)
          .map((t) => t.text)
          .join("\u0000"),
      )
      .digest("hex");

  const changed = [...changedNames].filter(wanted).sort(byCodeUnit);
  const corpus = [...new Set([...corpusNames, ...changed])]
    .filter(wanted)
    .sort(byCodeUnit);

  // Only changed-file window hashes go in the lookup set, so memory stays bounded.
  const hashes = new Set();
  for (const rel of changed) {
    const list = tokens(rel);
    for (let start = 0; start + MIN_TOKENS <= list.length; start += 1)
      hashes.add(windowHash(list, start));
  }

  // Corpus occurrences (file, window start) whose hash is in the lookup set; each
  // one is verified token by token later — a hash match alone never reports.
  const occurrences = []; // { rel, start }
  const occurrencesByHash = new Map(); // window hash -> [{ rel, start }]
  for (const rel of corpus) {
    const list = tokens(rel);
    for (let start = 0; start + MIN_TOKENS <= list.length; start += 1)
      {
        const hash = windowHash(list, start);
        if (hashes.has(hash)) {
          occurrences.push({ rel, start });
          const bucket = occurrencesByHash.get(hash);
          if (bucket) bucket.push({ rel, start });
          else occurrencesByHash.set(hash, [{ rel, start }]);
        }
      }
  }

  // Added lines per changed file, from the `+start,count` of the -U0 hunk headers.
  const addedLines = new Map(); // rel -> Set of 1-based line numbers
  for (const rel of changed) {
    const lines = new Set();
    for (const hunk of gitOrDie(["diff", "-U0", mergeBase, "--", rel])
      .split("\n")
      .filter((l) => l.startsWith("@@"))) {
      const m = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let n = start; n < start + count; n += 1) lines.add(n);
    }
    addedLines.set(rel, lines);
  }

  function equalWindows(a, aStart, b, bStart) {
    for (let i = 0; i < MIN_TOKENS; i += 1)
      if (a[aStart + i].text !== b[bStart + i].text) return false;
    return true;
  }

  // A changed window is duplicated when an equal window exists in another file, or
  // in the same file starting at least MIN_TOKENS tokens away.
  const matchesAt = new Map(); // changed rel -> Map window start -> occurrences
  for (const rel of changed) {
    const list = tokens(rel);
    const here = new Map();
    for (let start = 0; start + MIN_TOKENS <= list.length; start += 1) {
      const hash = windowHash(list, start);
      const valid = (occurrencesByHash.get(hash) ?? []).filter(
        (o) =>
          (o.rel !== rel || Math.abs(o.start - start) >= MIN_TOKENS) &&
          equalWindows(list, start, tokens(o.rel), o.start),
      );
      if (valid.length > 0) here.set(start, valid);
    }
    if (here.size > 0) matchesAt.set(rel, here);
  }

  // Each duplicated block is a continuous run of matched windows that all
  // match the same counterpart file at the same constant offset; a window
  // matching a different counterpart (or a different offset) never joins the
  // run, so one block's line count always comes from one counterpart only. A
  // block is reported only when it covers at least MIN_LINES distinct lines
  // and at least one of those lines is an added line.
  const runsOf = (sorted) => {
    const runs = [];
    let run = [];
    for (const s of sorted) {
      if (run.length > 0 && s !== run[run.length - 1] + 1) {
        runs.push(run);
        run = [];
      }
      run.push(s);
    }
    if (run.length > 0) runs.push(run);
    return runs;
  };
  const blocks = [];
  for (const [rel, windows] of matchesAt) {
    const list = tokens(rel);
    const added = addedLines.get(rel);
    const untrackedHere = untracked.has(rel);
    const byKey = new Map(); // "other rel\0offset" -> matched window starts
    for (const [start, occurrences] of windows)
      for (const o of occurrences) {
        const key = `${o.rel}\u0000${o.start - start}`;
        const set = byKey.get(key);
        if (set) set.add(start);
        else byKey.set(key, new Set([start]));
      }
    for (const [key, startSet] of byKey) {
      const sep = key.indexOf("\u0000");
      const otherRel = key.slice(0, sep);
      const offset = Number(key.slice(sep + 1));
      const otherTokens = tokens(otherRel);
      for (const run of runsOf([...startSet].sort(byCodeUnit))) {
        const lo = run[0];
        const hi = run[run.length - 1];
        const otherStart = lo + offset;
        const end = otherStart + (hi - lo) + MIN_TOKENS - 1;
        // A shifted span outside the other file is invalid, never clamped.
        if (otherStart < 0 || end >= otherTokens.length) continue;
        const blockLines = new Set(
          list.slice(lo, hi + MIN_TOKENS).map((t) => t.line),
        );
        if (blockLines.size < MIN_LINES) continue;
        const addedHere =
          untrackedHere || [...blockLines].some((line) => added.has(line));
        if (!addedHere) continue;
        blocks.push(
          `${NAME}: ${rel}:${list[lo].line}-${list[hi + MIN_TOKENS - 1].line}` +
            ` duplicates ${otherRel}:` +
            `${otherTokens[otherStart].line}-${otherTokens[end].line}` +
            ` (${blockLines.size} lines)`,
        );
      }
    }
  }

  if (blocks.length === 0) {
    console.log(`${NAME}: clean`);
    process.exit(0);
  }
  for (const line of [...blocks].sort(byCodeUnit)) console.log(line);
  console.log(`${NAME}: ${blocks.length} duplicated block(s)`);
  process.exit(1);
} catch {
  console.error(`${NAME}: internal error`);
  process.exit(2);
}
