// Adapter scaffold — implemented for lane O14d1.
/**
 * LaneDiffCheckAdapter implements LaneDiffCheckPort over an injected
 * CommandExecutorPort: it collects the worktree's tracked and untracked
 * changed paths (`git status --porcelain=v1 -z --untracked-files=all`, the
 * name status against the base and the staged `--cached` name status), then
 * scans the WHOLE CONTENT of every changed path that is not deleted — the
 * worktree bytes (`cat --`) and the index blob (`git cat-file blob :<path>`,
 * which needs no diff, textconv or clean filter) — with the secret patterns,
 * and calls the pure `checkLaneDiff`. Content scanning, not added-line diff
 * parsing, is the reference approach: a filename with a space, a `* -diff`
 * attribute, a NUL byte or a textconv/clean filter cannot hide a secret,
 * because no diff is parsed at all. Like `scripts/lane-diff-check.sh`, whole
 * content scanning can flag a secret that already existed in a touched file;
 * the pure check then applies the script's base-line allowance (KF-27): the
 * adapter reads the base version of each changed path and passes its lines
 * in, so a line the base already had is excused, at most as many times as it
 * occurs there — never for a new or unreadable base, a NUL byte on either
 * side, or a copy beyond the base count. The base is trusted only after
 * every object on the way is verified: the base must be a commit that is an
 * ancestor of HEAD and whose bytes re-hash to its id, each tree on the path
 * is listed and round-tripped through `mktree` to re-derive its id, entries
 * come from the verified listing (only regular-file modes excuse), and the
 * blob's bytes re-hash to its id — git checks object hashes on transfer and
 * fsck, not on read, so a lane that can write the shared object store cannot
 * serve forged bytes for the real ids. The grafts override travels inside
 * the argv too, because a remote executor carries only the argv. The adapter also flags a changed
 * symbolic link and passes the repository's helper-shaped git config key
 * names (names only; no value is ever read) to the pure check. Git plumbing
 * never lists anything under `.git/`, so no
 * snapshot comparison exists there and the fixed `.git/` protected rule
 * stays as defense in depth. Detecting changes under `.git/` (hooks,
 * config) needs a snapshot taken at dispatch — that is lane O14d2's job and
 * is deliberately not implemented here. Every command failure, a base ref
 * outside the commit-shape or an unreadable changed path fails closed as
 * `error`; no file content is ever printed or carried in a finding.
 */

import type {
  LaneDiffCheckPort,
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from "../../application/ports/out/LaneDiffCheckPort.out-port.js";
import type { CommandExecutorPort } from "../../application/ports/out/CommandExecutorPort.out-port.js";
import { join } from "node:path";
import type {
  LaneDiffChangedPath,
  LaneDiffSecretPattern,
  LaneDiffFileStatus,
} from "../../domain/lane-diff-check.js";
import { checkLaneDiff } from "../../domain/lane-diff-check.js";
import { LANE_DIFF_SECRET_PATTERNS } from "@fleet/shared";
import { allowListedChildEnv } from "./spawn-run.js";

interface CommandOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly reason: string;
  /** The child's exit code when it reported one; null on a spawn failure. */
  readonly exitCode: number | null;
}

/** A base ref must be a plain commit object name: 40–64 lowercase hex digits. */
const BASE_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;

/** Per-read captured-output cap, matching the runner's reviewed 64 MiB. */
const MAX_SCAN_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Applied to every git command: the parser pin (no colors, no quoted paths,
 * no mnemonic or missing a/b prefixes) plus the hardening overrides — no
 * fsmonitor, no repository hooks, no attributes file, short submodule
 * summaries, no external diff driver and no lfs filter process — mirroring
 * GitShelfProvider's hardened prefix. Content is read with `cat` and
 * `git cat-file blob` anyway, neither of which consults these settings.
 */
const GIT_CONFIG_ARGS = [
  "-c",
  "color.ui=never",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.submodule=short",
  "-c",
  "diff.external=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
] as const;

/**
 * A grafts path that never exists: git then reads no grafts and prints no
 * deprecation hint (an existing file, even /dev/null, makes every call
 * warn). A lane that can write the shared clone must not be able to point
 * the check at a grafts file it controls.
 */
const GIT_GRAFT_FILE_NEVER =
  "/nonexistent/fleet-v2-lane-diff-check-no-grafts";

/**
 * Applied to every git call as the child's environment: replace refs and
 * grafts in the shared clone cannot forge the base blob or hide a changed
 * file (KF-27 review), because replace-object lookup is off and the grafts
 * file points nowhere. The base is the local allow-list — these git calls
 * never touch a remote over git, so `SSH_AUTH_SOCK` is not needed — plus
 * the two overrides; the port takes a complete environment when given, so
 * the allow-list is rebuilt here rather than widened. The two overrides
 * also travel INSIDE the argv (below): a remote executor carries only the
 * argv to the remote shell, so an environment variable set here would never
 * reach the remote git.
 */
const GIT_HARDENED_ENV: Readonly<Record<string, string>> = {
  ...allowListedChildEnv("local"),
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: GIT_GRAFT_FILE_NEVER,
};

/**
 * The repository's own git config key names that make git run a helper
 * program (KF-27): the script's exact alternative list
 * (`scripts/lane-diff-check.sh`, `HELPER_KEYS=`), matched case-insensitively
 * against key NAMES only — no config value is ever read.
 */
const HELPER_KEYS =
  "^core\\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$|^diff\\.external$|^diff\\..+\\.(command|textconv)$|^merge\\..+\\.driver$|^credential\\.helper$|^credential\\..+\\.helper$|^gpg\\.program$|^gpg\\..+\\.program$|^sequence\\.editor$|^uploadpack\\.packobjectshook$|^remote\\..+\\.(uploadpack|receivepack)$|^pager\\..+$|^url\\..+\\.(insteadof|pushinsteadof)$|^include\\.path$|^includeif\\..+\\.path$";

const HELPER_KEY_PATTERN = new RegExp(HELPER_KEYS, "i");

/**
 * A key with a subsection is reported with the subsection masked as
 * `<sub>` (the script's `first.<sub>.last` form), and the whole key is
 * lowercased; the masking runs on the original case, the lowercase on the
 * masked result.
 */
function maskedHelperKey(key: string): string {
  const parts = key.split(".");
  if (parts.length >= 3) return `${parts[0]}.<sub>.${parts[parts.length - 1]}`;
  // A two-part key whose second segment is lane-chosen text — `pager.<cmd>`
  // is the one in the helper list — masks that segment too: the command
  // name is a subsection-like lane-chosen string and must not appear in a
  // finding. Two-part keys with a fixed second segment (`diff.external`,
  // `core.pager`, `credential.helper`, `include.path`) stay readable.
  if (parts.length === 2 && parts[0].toLowerCase() === "pager") {
    return `${parts[0]}.<sub>`;
  }
  return key;
}

/** The distinct masked, lowercased helper key names among the config keys. */
function helperConfigKeys(configList: string): string[] {
  const keys = new Set<string>();
  for (const field of configList.split("\0")) {
    if (field === "") continue;
    if (!HELPER_KEY_PATTERN.test(field)) continue;
    keys.add(maskedHelperKey(field).toLowerCase());
  }
  return [...keys];
}

/** Whole content as 1-based numbered lines; line 1 is the first line. */
function contentLines(content: string): { line: number; text: string }[] {
  return content.split("\n").map((text, index) => ({ line: index + 1, text }));
}

/**
 * The worktree and index scans of one path both number lines from 1, so a
 * (line, text) pair seen in both scans is kept once. Different texts at the
 * same line — the worktree changed since staging — are all kept, so a secret
 * in either version is scanned.
 */
function mergeContentLines(
  merged: Map<number, Set<string>>,
  content: string,
): void {
  for (const { line, text } of contentLines(content)) {
    const texts = merged.get(line) ?? new Set<string>();
    texts.add(text);
    merged.set(line, texts);
  }
}

function flattenContentLines(
  merged: Map<number, Set<string>>,
): { line: number; text: string }[] {
  const lines: { line: number; text: string }[] = [];
  for (const [line, texts] of [...merged.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    for (const text of texts) lines.push({ line, text });
  }
  return lines;
}

export interface LaneDiffCheckAdapterOptions {
  /** Secret shapes to scan with; absent is the shared registry. */
  readonly secretPatterns?: readonly LaneDiffSecretPattern[];
}

export class LaneDiffCheckAdapter implements LaneDiffCheckPort {
  constructor(
    private readonly commandExecutor: CommandExecutorPort,
    private readonly options?: LaneDiffCheckAdapterOptions,
  ) {}

  async checkLaneDiff(
    request: LaneDiffCheckRequest,
  ): Promise<LaneDiffCheckResult> {
    // Fail closed before any git call: the base ref must be a plain commit
    // object name. Anything else — an option-looking value like
    // `--output=/tmp/x`, a refspeed shortcut — is refused outright.
    if (!BASE_COMMIT_PATTERN.test(request.baseCommit)) {
      return { outcome: "error", reason: "invalid-base-commit" };
    }

    const git = async (
      argv: readonly string[],
      what: string,
      input?: string,
    ): Promise<CommandOutcome> => {
      // The config overrides pin every command against the lane's local git
      // config: no colors, no quoted paths, no mnemonic or missing a/b
      // prefixes, no fsmonitor, no hooks, no attributes file, short submodule
      // summaries, no external diff driver and no clean/smudge filter
      // process — mirroring GitShelfProvider's hardened prefix. Content is
      // read with `cat` and `git cat-file blob` anyway, neither of which
      // consults any of these settings.
      // `-C <worktreePath>` anchors every git command at the worktree: the
      // executor may ignore `cwd` (batch-mode ssh runs in the remote home
      // directory), so the flag, not the option, is the source of truth.
      // `cwd` is kept too; it is harmless locally.
      // `--no-replace-objects` and the hardened environment (above) keep
      // replace refs and grafts the lane could have planted in the shared
      // clone from forging the base blob or hiding a changed file: a
      // transport that drops the environment still runs the flag.
      // `env GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=<never-existing path>`
      // prefixes the command itself: an ssh executor carries only the argv
      // to the remote shell, so the grafts override must travel inside the
      // remote command (every word single-quoted by the remote executor) to
      // reach the remote git at all. Locally the same prefix is harmless.
      const run = await this.commandExecutor.run(
        [
          "env",
          "GIT_NO_REPLACE_OBJECTS=1",
          `GIT_GRAFT_FILE=${GIT_GRAFT_FILE_NEVER}`,
          "git",
          "--no-replace-objects",
          "-C",
          request.worktreePath,
          ...GIT_CONFIG_ARGS,
          ...argv,
        ],
        {
          cwd: request.worktreePath,
          env: GIT_HARDENED_ENV,
          ...(input !== undefined ? { input } : {}),
        },
      );
      if (run.error !== undefined || run.exitCode !== 0) {
        return {
          ok: false,
          stdout: "",
          reason: `lane diff check: could not ${what}`,
          exitCode: run.exitCode,
        };
      }
      return { ok: true, stdout: run.stdout, reason: "", exitCode: 0 };
    };

    // The base-line allowance trusts only a base that (a) is a commit object,
    // (b) is an ancestor of HEAD and (c) whose bytes re-hash to the base id —
    // checked once per check (the script's TRUSTED_BASE). On any failure the
    // allowance is simply off: every baseLines stays null, never an error.
    let baseTreeId: string | null = null;
    const baseType = await git(
      ["cat-file", "-t", request.baseCommit],
      "check the base object's type",
    );
    if (baseType.ok && baseType.stdout.trim() === "commit") {
      const ancestor = await git(
        ["merge-base", "--is-ancestor", request.baseCommit, "HEAD"],
        "check the base is an ancestor of HEAD",
      );
      if (ancestor.ok) {
        const commitRead = await git(
          ["cat-file", "commit", request.baseCommit],
          "read the base commit",
        );
        if (commitRead.ok) {
          // Git does not check object hashes on read, so the commit's bytes
          // are re-hashed before anything from it is trusted.
          const commitHash = await git(
            ["hash-object", "--no-filters", "-t", "commit", "--stdin"],
            "verify the base commit's hash",
            commitRead.stdout,
          );
          const treeMatch = commitRead.stdout.match(
            /^tree ([0-9a-f]{40,64})(?:\n|$)/,
          );
          if (
            commitHash.ok &&
            commitHash.stdout.trim() === request.baseCommit &&
            treeMatch !== null
          ) {
            baseTreeId = treeMatch[1];
          }
        }
      }
    }

    /**
     * Read object `id` of a text-safe type and re-hash its bytes: 0 only
     * when they hash to `id`. Git checks object hashes on transfer and
     * fsck, not on cat-file, so a lane that can write the shared object
     * store (a loose file, alternates) could otherwise serve forged bytes
     * for the real id. Any read error or mismatch is a null, never an
     * error and never a trust.
     */
    const readVerifiedObject = async (
      id: string,
      type: "commit" | "blob",
    ): Promise<string | null> => {
      const read = await git(
        ["cat-file", type, id],
        `read a base ${type}`,
      );
      if (!read.ok) return null;
      const hash = await git(
        ["hash-object", "--no-filters", "-t", type, "--stdin"],
        `verify a base ${type}'s hash`,
        read.stdout,
      );
      if (!hash.ok || hash.stdout.trim() !== id) return null;
      return read.stdout;
    };

    /**
     * List tree `id` NUL-separated and verify the id by round-tripping the
     * listing through `mktree -z --missing` — it must print the same id.
     * Tree bytes are binary, so the listing (text) is what is verified, not
     * a hash of decoded bytes. Returns the parsed entries, or null.
     */
    const verifiedTreeEntries = async (
      id: string,
    ): Promise<Map<string, { mode: string; id: string }> | null> => {
      const listing = await git(["ls-tree", "-z", id], "list a base tree");
      if (!listing.ok) return null;
      const roundTrip = await git(
        ["mktree", "-z", "--missing"],
        "verify a base tree's hash",
        listing.stdout,
      );
      if (!roundTrip.ok || roundTrip.stdout.trim() !== id) return null;
      const entries = new Map<string, { mode: string; id: string }>();
      for (const field of listing.stdout.split("\0")) {
        if (field === "") continue;
        const tab = field.indexOf("\t");
        if (tab < 0) return null;
        const meta = field.slice(0, tab).split(" ");
        if (meta.length !== 3) return null;
        entries.set(field.slice(tab + 1), { mode: meta[0], id: meta[2] });
      }
      return entries;
    };

    /**
     * The verified base blob of one path: commit tree → each tree on the
     * way (every one re-verified) → the entry taken from the VERIFIED
     * listing, and finally the blob itself re-hashed. A tree on the way
     * must be mode 040000; the final entry must be a regular file
     * (100644 or 100755) — a symlink, submodule or tree at the path
     * excuses nothing. Any mismatch, read error or missing entry is null.
     */
    const verifiedBaseBlob = async (path: string): Promise<string | null> => {
      if (baseTreeId === null) return null;
      let id = baseTreeId;
      const components = path.split("/");
      for (let index = 0; index < components.length; index += 1) {
        const entries = await verifiedTreeEntries(id);
        if (entries === null) return null;
        const entry = entries.get(components[index]);
        if (entry === undefined) return null;
        if (index === components.length - 1) {
          if (entry.mode !== "100644" && entry.mode !== "100755") return null;
          return readVerifiedObject(entry.id, "blob");
        }
        if (entry.mode !== "040000") return null;
        id = entry.id;
      }
      return null;
    };

    const status = await git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "list the changed files",
    );
    if (!status.ok) return { outcome: "error", reason: status.reason };

    const changed = new Map<string, LaneDiffChangedPath>();
    // Paths whose worktree file is gone (porcelain Y is `D`): they are
    // scanned from the index blob alone, which is not an error.
    const worktreeDeleted = new Set<string>();
    this.collectStatusEntries(status.stdout, changed, worktreeDeleted);

    const addedLines = new Map<string, { line: number; text: string }[]>();
    // The base version's lines per path (null = unknown: no base blob, a
    // read failure, or a NUL byte in the base blob or the scanned content —
    // excuse nothing, fail closed).
    const baseLinesByPath = new Map<string, readonly string[] | null>();
    // Whether each worktree path is a symbolic link.
    const isSymlinkByPath = new Map<string, boolean>();

    // Committed changes since the base are still reviewed: the name status
    // against the base lists every path the base..worktree and base..HEAD
    // deltas touch, including committed deletions and mode-only changes.
    const nameStatus = await git(
      [
        "diff",
        "--no-color",
        "--no-renames",
        "--name-status",
        "-z",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        request.baseCommit,
      ],
      "list the committed and staged files",
    );
    if (!nameStatus.ok) return { outcome: "error", reason: nameStatus.reason };
    this.collectNameStatusEntries(nameStatus.stdout, changed);

    // A secret that is staged and then reverted in the worktree never shows
    // in the worktree content; the index blob still has to be scanned.
    const cachedNames = await git(
      ["diff", "--cached", "--no-color", "--no-renames", "--name-status", "-z"],
      "list the staged files",
    );
    if (!cachedNames.ok)
      return { outcome: "error", reason: cachedNames.reason };
    this.collectNameStatusEntries(cachedNames.stdout, changed);

    // Fail closed on paths the content scan cannot handle, without echoing
    // the path anywhere.
    for (const path of changed.keys()) {
      if (hasUnsupportedPathCharacters(path)) {
        return { outcome: "error", reason: "unsupported-path-characters" };
      }
    }

    // Scan the WHOLE CONTENT of every changed path that is not deleted: the
    // worktree bytes (`cat --`) and, whenever the index has the path, the
    // index blob (`git cat-file blob :<path>` — stage 0, no diff, no
    // textconv, no filter). `deleted` means the INDEX no longer has the
    // path (porcelain X is `D`); a staged change whose worktree copy was
    // then removed (porcelain `MD` or `AD`) still has its index blob —
    // exactly the blob `write-tree` would commit — so it is scanned from
    // the index alone, which is not an error. No binary heuristic is
    // applied: the raw bytes travel as text, so a NUL byte cannot stop the
    // scan (the executor decodes as UTF-8, which preserves NUL as U+0000
    // and maps every ASCII byte to itself, so no ASCII pattern can be
    // hidden by the decoding). A directory, an embedded repository or any
    // other unreadable non-file path fails the read and the check gives an
    // error. The 64 MiB cap applies per read; exceeding it is an error,
    // never a silent truncation.
    for (const entry of changed.values()) {
      if (entry.status === "deleted") continue;
      const merged = new Map<number, Set<string>>();
      // The raw scanned content and the raw base blob, kept only to detect a
      // NUL byte: some line splitters cut a line at a NUL, so two different
      // lines could compare equal and a NUL on either side excuses nothing.
      let scannedHasNul = false;
      let baseRaw: string | null = null;
      if (!worktreeDeleted.has(entry.path)) {
        // The worktree copy is read only when it exists, and always by its
        // absolute path: the executor may ignore `cwd`, so `cat --` gets
        // `<worktreePath>/<path>` rather than relying on the working
        // directory (`cwd` is kept; it is harmless locally).
        // `cat` follows symbolic links, so a link to a FIFO could stall the
        // check and a link to another file would scan the target instead of
        // what git commits for a link (its target text). A link is read
        // with `readlink`; any other path must be a regular file, or the
        // check fails closed.
        const absolutePath = join(request.worktreePath, entry.path);
        const isLink = await this.commandExecutor.run(
          ["test", "-L", absolutePath],
          { cwd: request.worktreePath },
        );
        // `test -L` answers 0 (a link) or 1 (not a link); anything else —
        // an ssh transport failure is 255 — is no answer and fails closed,
        // or a link could be followed and its target scanned instead.
        // A link is also a finding in itself (KF-27), even when its target
        // stays inside the worktree.
        isSymlinkByPath.set(entry.path, isLink.exitCode === 0);
        if (
          isLink.error !== undefined ||
          (isLink.exitCode !== 0 && isLink.exitCode !== 1)
        ) {
          return {
            outcome: "error",
            reason:
              "lane diff check: could not inspect a changed file's worktree path",
          };
        }
        if (isLink.exitCode !== 0) {
          const isFile = await this.commandExecutor.run(
            ["test", "-f", absolutePath],
            { cwd: request.worktreePath },
          );
          if (isFile.error !== undefined || isFile.exitCode !== 0) {
            return {
              outcome: "error",
              reason:
                "lane diff check: a changed worktree path is not a regular file or a symbolic link",
            };
          }
        }
        const worktree = await this.commandExecutor.run(
          isLink.exitCode === 0
            ? ["readlink", "--", absolutePath]
            : ["cat", "--", absolutePath],
          {
            cwd: request.worktreePath,
            maxBufferBytes: MAX_SCAN_BUFFER_BYTES,
          },
        );
        if (worktree.error !== undefined || worktree.exitCode !== 0) {
          return {
            outcome: "error",
            reason:
              "lane diff check: could not read a changed file's worktree content",
          };
        }
        mergeContentLines(merged, worktree.stdout);
        scannedHasNul = worktree.stdout.includes("\u0000");
      }
      if (entry.status !== "untracked") {
        // Scan the index blob whenever the index has the path; `cat-file -e`
        // is the existence probe, and its failure fails closed.
        const probe = await git(
          ["cat-file", "-e", `:${entry.path}`],
          "probe a changed file's index blob",
        );
        if (!probe.ok)
          return {
            outcome: "error",
            reason:
              "lane diff check: could not probe a changed file's index blob",
          };
        const index = await git(
          ["cat-file", "blob", `:${entry.path}`],
          "read a changed file's index blob",
        );
        if (!index.ok) return { outcome: "error", reason: index.reason };
        mergeContentLines(merged, index.stdout);
        if (index.stdout.includes("\u0000")) scannedHasNul = true;
        // The base version of the same path, for the base-line allowance:
        // the probe answers 0 (a base blob exists) or 128 (none — a new or
        // untracked-in-base path excuses nothing); any other exit is no
        // answer and fails closed.
        const baseProbe = await git(
          ["cat-file", "-e", `${request.baseCommit}:${entry.path}`],
          "probe a changed file's base blob",
        );
        if (!baseProbe.ok) {
          if (baseProbe.exitCode !== 128) {
            return {
              outcome: "error",
              reason:
                "lane diff check: could not probe a changed file's base blob",
            };
          }
        } else {
          // The verified base blob: commit → each tree → blob, every object
          // re-hashed and every entry taken from a verified tree listing.
          // Any verification failure, read error or a non-regular-file mode
          // at the path is a null (nothing excused for that file), never an
          // error and never a trust of unverified bytes.
          baseRaw = await verifiedBaseBlob(entry.path);
        }
      }
      addedLines.set(entry.path, flattenContentLines(merged));
      baseLinesByPath.set(
        entry.path,
        baseRaw !== null && !baseRaw.includes("\u0000") && !scannedHasNul
          ? baseRaw.split("\n")
          : null,
      );
    }

    // The repository's own config keys, read once per check: names only,
    // NUL-separated, so no value is ever read. Both the local scope and the
    // worktree scope (lane-writable when `extensions.worktreeConfig` is on)
    // are read, like the script; a failed worktree-scope read is tolerated
    // as empty (the script's `|| true`), a failed local-scope read is an
    // error (fail closed), never a silent pass.
    const configKeys = await git(
      ["config", "-z", "--local", "--includes", "--name-only", "--list"],
      "read the repository's config key names",
    );
    if (!configKeys.ok) return { outcome: "error", reason: configKeys.reason };
    const worktreeKeys = await git(
      ["config", "-z", "--worktree", "--includes", "--name-only", "--list"],
      "read the repository's worktree config key names",
    );
    const combinedConfigKeys = worktreeKeys.ok
      ? `${configKeys.stdout}\0${worktreeKeys.stdout}`
      : configKeys.stdout;

    const changedPaths: LaneDiffChangedPath[] = [...changed.values()].map(
      (entry) => ({
        ...entry,
        ...(addedLines.has(entry.path)
          ? { addedLines: addedLines.get(entry.path) }
          : {}),
        ...(baseLinesByPath.has(entry.path)
          ? { baseLines: baseLinesByPath.get(entry.path) }
          : {}),
        ...(isSymlinkByPath.get(entry.path) === true
          ? { isSymlink: true }
          : {}),
      }),
    );

    const verdict = checkLaneDiff({
      changedPaths,
      allowedPathPrefixes: request.allowedPathPrefixes,
      ...(request.policyProtectedPaths !== undefined
        ? { policyProtectedPaths: request.policyProtectedPaths }
        : {}),
      helperConfigKeys: helperConfigKeys(combinedConfigKeys),
      ...(request.secretPatterns !== undefined
        ? { secretPatterns: request.secretPatterns }
        : {
            secretPatterns:
              this.options?.secretPatterns ?? defaultSecretPatterns(),
          }),
    });
    // Both content scans of a path can yield the same (line, text) pair;
    // the domain already merges identical (line, text) pairs, and identical
    // (path, line, rule) findings — the same secret shape matched by two
    // scans of different text at one line — collapse here. Findings carry
    // path, line and rule only, never a matched value.
    if (verdict.ok) return { outcome: "clean" };
    const seen = new Set<string>();
    const findings = verdict.findings.filter((finding) => {
      const key = `${finding.path}\u0000${finding.rule}\u0000${String(
        finding.line ?? "",
      )}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { outcome: "findings", findings };
  }

  /**
   * Parse `git status --porcelain=v1 -z`: NUL-separated entries of two status
   * letters, a space and the path. Renames carry the original path as a
   * second NUL-separated field and are split into delete + add so a protected
   * source path is seen, exactly like the script. `deleted` means the INDEX
   * no longer has the path (porcelain X is `D`): a staged change whose
   * worktree copy was then removed (`MD`, `AD`) stays scannable from its
   * index blob, so it is classified by the index letter and its missing
   * worktree file is recorded in `worktreeDeleted`.
   */
  private collectStatusEntries(
    stdout: string,
    changed: Map<string, LaneDiffChangedPath>,
    worktreeDeleted: Set<string>,
  ): void {
    const fields = stdout.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index];
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const path = entry.slice(3);
      if (x === "?" && y === "?") {
        changed.set(path, { path, status: "untracked" });
        continue;
      }
      if (x === "R" || x === "C" || y === "R" || y === "C") {
        const original = fields[index + 1] ?? "";
        index += 1;
        if (original !== "") {
          changed.set(original, { path: original, status: "deleted" });
        }
        changed.set(path, { path, status: "added" });
        continue;
      }
      if (y === "D") worktreeDeleted.add(path);
      const status: LaneDiffFileStatus =
        x === "D" ? "deleted" : x === "A" || y === "A" ? "added" : "modified";
      changed.set(path, { path, status });
    }
  }

  /**
   * Parse `git diff --name-status -z`: NUL-separated status letters then
   * paths. With `--no-renames` a rename arrives as a delete/add pair; a
   * copy still carries a second path and is split the same way. Paths are
   * merged into the changed set without overriding an entry the status
   * already named.
   */
  private collectNameStatusEntries(
    stdout: string,
    changed: Map<string, LaneDiffChangedPath>,
  ): void {
    const fields = stdout.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const statusField = fields[index];
      if (statusField === "") continue;
      const x = statusField[0];
      const path = fields[index + 1] ?? "";
      index += 1;
      if (path === "") continue;
      if (x === "C") {
        const copied = fields[index + 1] ?? "";
        index += 1;
        if (copied !== "") {
          changed.set(copied, { path: copied, status: "added" });
        }
      }
      const status: LaneDiffFileStatus =
        x === "A" ? "added" : x === "D" ? "deleted" : "modified";
      if (!changed.has(path)) {
        changed.set(path, { path, status });
      }
    }
  }
}

/**
 * Fail closed: a path with a double quote, a backslash or any control
 * character (tab, newline, …) cannot be reviewed line by line safely.
 */
function hasUnsupportedPathCharacters(path: string): boolean {
  for (const character of path) {
    if (
      character === '"' ||
      character === "\\" ||
      character.codePointAt(0)! < 0x20
    ) {
      return true;
    }
  }
  return false;
}

/** The complete script registry (all 17 patterns) with rule names. */
function defaultSecretPatterns(): readonly LaneDiffSecretPattern[] {
  return LANE_DIFF_SECRET_PATTERNS;
}
