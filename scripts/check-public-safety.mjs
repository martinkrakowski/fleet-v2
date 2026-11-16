#!/usr/bin/env node
// OG-18: fails when any git-tracked file contains a string or regular
// expression from the owner-maintained public-safety list, run locally.
//
// The list is external to this repository: `--list <file>` or
// FLEET_PUBLIC_SAFETY_LIST selects it, one entry per line. A line starting
// with `re:` is a regular expression (no flags); any other non-blank,
// non-comment line is a case-insensitive literal substring. Blank lines and
// `#` comment lines are ignored, and active entries are numbered 1, 2, ...
// in file order.
//
// Nothing sensitive is ever printed: a finding names only the tracked file,
// its 1-based line number and the 1-based entry number — never a list entry,
// its pattern, or the matched line text. List parse errors name the entry
// number, never the pattern.
//
// Every tracked file under 1 MiB whose first 8 KiB contain no NUL byte is
// scanned; oversized and binary files are skipped, and the list file itself
// is skipped whenever it lives inside the scanned tree, so it never flags
// itself. Untracked files are never read.
//
// Usage:
//   node scripts/check-public-safety.mjs [--root <dir>] [--list <file>] [--require-list]
//   node scripts/check-public-safety.mjs -h | --help
//
// Exit codes: 0 clean (or no list configured without --require-list),
// 1 at least one entry matched, 2 usage or setup error (unknown flag,
// --root not the top of a git worktree, --require-list without a list,
// unreadable list file, invalid list entry, failed git command, unreadable
// tracked file, internal error).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "check-public-safety";
const MAX_BYTES = 1048576; // 1 MiB: files this size or larger are skipped.
const BINARY_WINDOW = 8192; // 8 KiB: a NUL byte within this prefix marks a binary file.
// Bytewise order, the same on every host and locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function usage(message) {
  console.error(
    `${NAME}: ${message}; usage: node scripts/${NAME}.mjs [--root <dir>] [--list <file>] [--require-list]`,
  );
  process.exit(2);
}

let rootArg;
let listArg;
let requireList = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    // Print this file's header comment, then stop.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    process.stdout.write(`${source.slice(0, source.indexOf("\nimport "))}\n`);
    process.exit(0);
  } else if (arg === "--root") {
    if (i + 1 >= process.argv.length) usage("--root needs a directory");
    i += 1;
    rootArg = process.argv[i];
  } else if (arg === "--list") {
    if (i + 1 >= process.argv.length) usage("--list needs a file");
    i += 1;
    listArg = process.argv[i];
  } else if (arg === "--require-list") {
    requireList = true;
  } else usage(`unexpected argument ${arg}`);
}
// The environment fallback is trimmed, and an empty value counts as unset.
const envList = process.env.FLEET_PUBLIC_SAFETY_LIST;
const envListPath =
  envList === undefined ? undefined : envList.trim() === "" ? undefined : envList.trim();
const listPath = listArg ?? envListPath;
if (!listPath) {
  if (requireList) {
    console.error(
      `${NAME}: --require-list needs --list <file> or FLEET_PUBLIC_SAFETY_LIST`,
    );
    process.exit(2);
  }
  // Explicitly a no-op: no list means nothing was checked, never a clean bill.
  console.log(`${NAME}: no list configured, nothing checked`);
  process.exit(0);
}

try {
  let listText;
  try {
    listText = readFileSync(listPath, "utf8");
  } catch {
    console.error(`${NAME}: cannot read list ${listPath}`);
    process.exit(2);
  }
  const entries = [];
  let n = 0;
  for (const rawLine of listText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    n += 1;
    if (line.startsWith("re:")) {
      const pattern = line.slice(3);
      if (pattern === "") {
        console.error(`${NAME}: list entry #${n} has an empty re: pattern`);
        process.exit(2);
      }
      let regex;
      try {
        regex = new RegExp(pattern);
      } catch {
        // The RegExp error message echoes the pattern: never forward it.
        console.error(
          `${NAME}: list entry #${n} is not a valid regular expression`,
        );
        process.exit(2);
      }
      entries.push({ n, regex });
    } else {
      entries.push({ n, literal: line.toLowerCase() });
    }
  }

  const gitDir = () => (rootArg ? path.resolve(rootArg) : DEFAULT_ROOT);
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
  const root = top;

  const nulNames = (args) => gitOrDie(args).split("\0").filter(Boolean);
  // Tracked files minus the ones deleted from the working tree without staging.
  const deleted = new Set(nulNames(["ls-files", "-z", "--deleted"]));
  const tracked = nulNames(["ls-files", "-z"])
    .filter((name) => !deleted.has(name))
    .sort(byCodeUnit);

  let realList;
  try {
    realList = realpathSync(listPath);
  } catch {
    console.error(`${NAME}: cannot read list ${listPath}`);
    process.exit(2);
  }

  const findings = [];
  let scanned = 0;
  for (const name of tracked) {
    const full = path.join(root, name);
    // The list never scans itself when it lives inside the scanned tree.
    let realFile = null;
    try {
      realFile = realpathSync(full);
    } catch {
      realFile = null;
    }
    if (realFile !== null && realFile === realList) continue;
    let bytes;
    try {
      if (statSync(full).size > MAX_BYTES) continue;
      bytes = readFileSync(full);
    } catch {
      console.error(`${NAME}: cannot read tracked file ${name}`);
      process.exit(2);
    }
    if (bytes.subarray(0, BINARY_WINDOW).includes(0)) continue;
    scanned += 1;
    const lines = bytes.toString("utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].replace(/\r$/, "");
      for (const entry of entries) {
        const hit = entry.regex
          ? entry.regex.test(line)
          : line.toLowerCase().includes(entry.literal);
        if (hit) findings.push(`${NAME}: ${name}:${i + 1} entry #${entry.n}`);
      }
    }
  }
  if (findings.length > 0) {
    for (const line of findings) console.log(line);
    process.exit(1);
  }
  console.log(`${NAME}: ok, ${scanned} files, ${entries.length} entries`);
  process.exit(0);
} catch {
  console.error(`${NAME}: internal error`);
  process.exit(2);
}
