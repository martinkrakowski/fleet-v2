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
 * that is intended. Git plumbing never lists anything under `.git/`, so no
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

interface CommandOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly reason: string;
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
      const run = await this.commandExecutor.run(
        ["git", "-C", request.worktreePath, ...GIT_CONFIG_ARGS, ...argv],
        { cwd: request.worktreePath },
      );
      if (run.error !== undefined || run.exitCode !== 0) {
        return {
          ok: false,
          stdout: "",
          reason: `lane diff check: could not ${what}`,
        };
      }
      return { ok: true, stdout: run.stdout, reason: "" };
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
      if (!worktreeDeleted.has(entry.path)) {
        // The worktree copy is read only when it exists, and always by its
        // absolute path: the executor may ignore `cwd`, so `cat --` gets
        // `<worktreePath>/<path>` rather than relying on the working
        // directory (`cwd` is kept; it is harmless locally).
        const worktree = await this.commandExecutor.run(
          ["cat", "--", join(request.worktreePath, entry.path)],
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
      }
      addedLines.set(entry.path, flattenContentLines(merged));
    }

    const changedPaths: LaneDiffChangedPath[] = [...changed.values()].map(
      (entry) => ({
        ...entry,
        ...(addedLines.has(entry.path)
          ? { addedLines: addedLines.get(entry.path) }
          : {}),
      }),
    );

    const verdict = checkLaneDiff({
      changedPaths,
      allowedPathPrefixes: request.allowedPathPrefixes,
      ...(request.policyProtectedPaths !== undefined
        ? { policyProtectedPaths: request.policyProtectedPaths }
        : {}),
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
