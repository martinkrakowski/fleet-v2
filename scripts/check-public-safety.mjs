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
// Every tracked file is scanned no matter how large, so no tracked text file
// is a blind spot; only files whose first 8 KiB contain a NUL byte (binary)
// are skipped. A tracked symlink is scanned by its own tracked text — the
// link target path — and the link is never followed or opened. It is only
// accepted when it resolves to a regular file inside the repository (that
// file is scanned on its own when tracked); a dangling link, a loop, a link
// leaving the repository, or a link to a directory is an unreadable tracked
// entry (exit 2). Directory and submodule entries are refused the same way.
// The list file itself is skipped whenever it lives inside the scanned tree,
// so it never flags itself. Untracked files are never read.
//
// Tracked PATH NAMES are matched too: every tracked entry (file, symlink,
// gitlink) has its full repository path checked against the list, so a file
// or directory named after a listed name is a finding, reported as
// `<path>:0 entry #<n>` (line 0 marks a path-name hit). That finding line
// necessarily prints the path, which contains the match.
//
// STATUS: this script is NOT wired into CI or any package script yet; nothing
// invokes it. Without a list (no --list, no FLEET_PUBLIC_SAFETY_LIST) it
// checks NOTHING and exits 0 after printing "NO LIST CONFIGURED, NOTHING WAS
// CHECKED" on stderr; --require-list turns a missing list into exit 2. Any
// future gate must pass --require-list.
//
// A tracked path with a symlinked or missing ancestor directory is refused
// (exit 2) before anything is opened, so nothing outside the repository is read.
//
// A tracked file that is missing from the working tree is an unreadable
// tracked entry (exit 2), never silently skipped. Binary files (NUL in the
// first 8 KiB) are skipped but counted: one stderr summary line gives the
// count.
//
// Known limits (not implemented): no unicode normalisation (composed and
// decomposed forms differ); `re:` entries are case-sensitive; a name split
// across two lines is missed; UTF-16 files are skipped as binary (they
// contain NUL); a tracked list file inside the repository is skipped, so its
// own content and name are never checked.
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
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "check-public-safety";
const CHUNK = 1 << 16; // Streaming read size; no tracked file is skipped for size.
const BINARY_WINDOW = 8192; // 8 KiB: a NUL byte within this prefix marks a binary file.
// Bytewise order, the same on every host and locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const cannotRead = (name) => {
  console.error(`${NAME}: cannot read tracked file ${name}`);
  process.exit(2);
};

// One list entry against one decoded line; a hit names the file, the 1-based
// line and the 1-based entry — never the entry text or the matched text.
function matchLine(name, lineNo, line, entries, findings) {
  const folded = line.toLowerCase();
  for (const entry of entries) {
    const hit = entry.regex
      ? entry.regex.test(line)
      : folded.includes(entry.literal);
    if (hit) findings.push(`${NAME}: ${name}:${lineNo} entry #${entry.n}`);
  }
}

// A tracked path against every entry: line 0 marks a path-name finding.
function matchPath(name, entries, findings) {
  const folded = name.toLowerCase();
  for (const entry of entries) {
    const hit = entry.regex ? entry.regex.test(name) : folded.includes(entry.literal);
    if (hit) findings.push(`${NAME}: ${name}:0 entry #${entry.n}`);
  }
}

// No ancestor directory of a tracked path may be a symlink (or missing): a
// parent replaced by a link would make a later open read outside the
// repository. Checked with lstat per component, before anything is opened.
function checkParents(root, name) {
  const parts = name.split("/");
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      cannotRead(name);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) cannotRead(name);
  }
}

function scanTextBytes(name, bytes, entries, findings) {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i += 1) {
    matchLine(name, i + 1, lines[i].replace(/\r$/, ""), entries, findings);
  }
}

// Streams the tracked bytes, so file size is never a blind spot, and never
// follows a symlink: a tracked symlink's own tracked text is its link target
// path, and that text is what gets scanned.
function scanTracked(name, full, realRoot, entries, findings) {
  let st;
  try {
    st = lstatSync(full);
  } catch {
    cannotRead(name);
  }
  if (st.isSymbolicLink()) {
    let target;
    let resolved;
    let rst;
    try {
      target = readlinkSync(full, "buffer");
      resolved = realpathSync(full); // Throws on dangling links and loops.
      rst = lstatSync(resolved); // Metadata only: the target is never opened.
    } catch {
      cannotRead(name);
    }
    const rel = path.relative(realRoot, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || !rst.isFile()) {
      cannotRead(name);
    }
    scanTextBytes(name, target, entries, findings);
    return 1;
  }
  if (!st.isFile()) cannotRead(name); // Directory or submodule entry.
  let fd;
  try {
    fd = openSync(full, "r");
  } catch {
    cannotRead(name);
  }
  try {
    const chunk = Buffer.alloc(CHUNK);
    // A read failure (EISDIR, EIO) is an unreadable tracked file, not a pass.
    let pending = Buffer.alloc(0); // Bytes of the line still without its newline.
    let prefix = Buffer.alloc(0); // The first BINARY_WINDOW bytes of the file.
    let lineNo = 0;
    const flushLine = (bytes) => {
      lineNo += 1;
      let text = bytes.toString("utf8");
      if (text.endsWith("\r")) text = text.slice(0, -1);
      matchLine(name, lineNo, text, entries, findings);
    };
    for (;;) {
      let read;
      try {
        read = readSync(fd, chunk, 0, CHUNK, null);
      } catch {
        cannotRead(name);
      }
      if (read === 0) break;
      const data = chunk.subarray(0, read);
      if (prefix.length < BINARY_WINDOW) {
        const need = Math.min(BINARY_WINDOW - prefix.length, data.length);
        prefix = Buffer.concat([prefix, data.subarray(0, need)]);
        // A NUL within the window marks a binary file, skipped entirely.
        if (prefix.includes(0)) return -1;
      }
      const carry = pending.length === 0 ? data : Buffer.concat([pending, data]);
      let start = 0;
      for (;;) {
        const nl = carry.indexOf(10, start);
        if (nl === -1) break;
        flushLine(carry.subarray(start, nl));
        start = nl + 1;
      }
      pending = carry.subarray(start);
    }
    // A file not ending in a newline still has its last line scanned.
    if (pending.length > 0) flushLine(pending);
  } finally {
    closeSync(fd);
  }
  return 1;
}

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
  console.error(`${NAME}: NO LIST CONFIGURED, NOTHING WAS CHECKED`);
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
  // Every tracked entry; one missing from the working tree is refused in the loop.
  const tracked = nulNames(["ls-files", "-z"]).sort(byCodeUnit);

  let realList;
  try {
    realList = realpathSync(listPath);
  } catch {
    console.error(`${NAME}: cannot read list ${listPath}`);
    process.exit(2);
  }

  const realRoot = realpathSync(root);
  const findings = [];
  let scanned = 0;
  let skippedBinary = 0;
  for (const name of tracked) {
    const full = path.join(root, name);
    checkParents(root, name);
    // The list never scans itself when it lives inside the scanned tree.
    // A symlink is never skipped as the list: it is validated and scanned.
    let isLink = false;
    try {
      isLink = lstatSync(full).isSymbolicLink();
    } catch {
      cannotRead(name);
    }
    if (!isLink) {
      let realFile = null;
      try {
        realFile = realpathSync(full);
      } catch {
        realFile = null;
      }
      if (realFile !== null && realFile === realList) continue;
    }
    matchPath(name, entries, findings);
    const got = scanTracked(name, full, realRoot, entries, findings);
    if (got < 0) skippedBinary += 1;
    else scanned += got;
  }
  if (skippedBinary > 0) {
    console.error(
      `${NAME}: skipped ${skippedBinary} binary file(s) (NUL in the first 8 KiB), not scanned`,
    );
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
