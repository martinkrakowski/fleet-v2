// Adapter scaffold — implemented for lane O14d1.
/**
 * LaneDiffCheckAdapter implements LaneDiffCheckPort over an injected
 * CommandExecutorPort: it collects the worktree's tracked and untracked
 * changes (`git status --porcelain=v1 -z --untracked-files=all`, the name
 * status and `-U0` added-line diffs against the base (which include the
 * committed and staged delta since the base), the committed `base...HEAD`
 * delta and the staged `--cached` delta, mirroring
 * `scripts/lane-diff-check.sh`), then calls the pure `checkLaneDiff`. It
 * mirrors the script's collection: git plumbing never lists anything under
 * `.git/`, so no snapshot comparison exists there and the fixed `.git/`
 * protected rule stays as defense in depth. Detecting changes under `.git/`
 * (hooks, config) needs a snapshot taken at dispatch — that is lane O14d2's
 * job and is deliberately not implemented here. Every command failure fails
 * closed as `error`; no file content is ever printed or carried in a finding.
 */

import type {
  LaneDiffCheckPort,
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from "../../application/ports/out/LaneDiffCheckPort.out-port.js";
import type { CommandExecutorPort } from "../../application/ports/out/CommandExecutorPort.out-port.js";
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
    const git = async (
      argv: readonly string[],
      what: string,
    ): Promise<CommandOutcome> => {
      // The config overrides pin the parser input against the lane's local
      // git config: no colors, no quoted paths, no mnemonic or missing
      // a/b prefixes. `--no-color` and explicit prefixes are passed again on
      // every diff for the same reason.
      const run = await this.commandExecutor.run(
        [
          "git",
          "-c",
          "color.ui=never",
          "-c",
          "core.quotePath=false",
          "-c",
          "diff.mnemonicPrefix=false",
          "-c",
          "diff.noprefix=false",
          ...argv,
        ],
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
    const untracked: string[] = [];
    this.collectStatusEntries(status.stdout, changed, untracked);

    const addedLines = new Map<string, { line: number; text: string }[]>();

    // Committed changes since the base are still reviewed: the worktree diff
    // against the base carries them (plus the staged and unstaged delta), and
    // its name status lists paths a `-U0` diff cannot name, such as committed
    // deletions and mode-only changes.
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

    const diff = await git(
      [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--no-renames",
        "-U0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        request.baseCommit,
      ],
      "read the added lines",
    );
    if (!diff.ok) return { outcome: "error", reason: diff.reason };
    this.collectAddedLines(diff.stdout, addedLines);

    // The committed delta since the base, like the script's `base...HEAD`
    // collection. HEAD-unchanged-since-dispatch is the caller's step 1; this
    // keeps the verdicts identical if the caller defers it.
    const committed = await git(
      [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--no-renames",
        "-U0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `${request.baseCommit}...HEAD`,
      ],
      "read the committed added lines",
    );
    if (!committed.ok) return { outcome: "error", reason: committed.reason };
    this.collectAddedLines(committed.stdout, addedLines);

    // A secret that is staged and then reverted in the worktree never shows
    // in a worktree diff; the staged delta still has to be reviewed.
    const cached = await git(
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-color",
        "--no-renames",
        "-U0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ],
      "read the staged added lines",
    );
    if (!cached.ok) return { outcome: "error", reason: cached.reason };
    this.collectAddedLines(cached.stdout, addedLines);
    const cachedNames = await git(
      ["diff", "--cached", "--no-color", "--no-renames", "--name-status", "-z"],
      "list the staged files",
    );
    if (!cachedNames.ok)
      return { outcome: "error", reason: cachedNames.reason };
    this.collectNameStatusEntries(cachedNames.stdout, changed);

    // Fail closed on paths the line-by-line review cannot handle, without
    // echoing the path anywhere.
    for (const path of changed.keys()) {
      if (hasUnsupportedPathCharacters(path)) {
        return { outcome: "error", reason: "unsupported-path-characters" };
      }
    }

    // An untracked file's whole content is added lines.
    for (const path of untracked) {
      const run = await this.commandExecutor.run(["cat", "--", path], {
        cwd: request.worktreePath,
      });
      if (run.error !== undefined || run.exitCode !== 0) {
        return {
          outcome: "error",
          reason: "lane diff check: could not read an untracked file",
        };
      }
      addedLines.set(
        path,
        run.stdout
          .split("\n")
          .map((text, index) => ({ line: index + 1, text })),
      );
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
    return verdict.ok
      ? { outcome: "clean" }
      : { outcome: "findings", findings: verdict.findings };
  }

  /**
   * Parse `git status --porcelain=v1 -z`: NUL-separated entries of two status
   * letters, a space and the path. Renames carry the original path as a
   * second NUL-separated field and are split into delete + add so a protected
   * source path is seen, exactly like the script.
   */
  private collectStatusEntries(
    stdout: string,
    changed: Map<string, LaneDiffChangedPath>,
    untracked: string[],
  ): void {
    const fields = stdout.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index];
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const path = entry.slice(3);
      if (x === "?" && y === "?") {
        untracked.push(path);
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
      const status: LaneDiffFileStatus =
        x === "A" || y === "A"
          ? "added"
          : y === "D" || x === "D"
            ? "deleted"
            : "modified";
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

  /**
   * Parse a `-U0` unified diff with explicit a/ and b/ prefixes. A
   * `+++ b/<path>` header names the file only on the line directly after a
   * `--- ` header, inside the file's header block; everything after the
   * first `@@` of a file is content, so an added line whose own text starts
   * with `++ ` (rendered `+++ ...` by git) can never be mistaken for a
   * header. Each `@@ -a,b +m,n @@` hunk header sets the next 1-based
   * new-file line number for the `+` lines that follow.
   */
  private collectAddedLines(
    diff: string,
    addedLines: Map<string, { line: number; text: string }[]>,
  ): void {
    let current: string | null = null;
    let nextLine = 1;
    let inHeader = false;
    let sawMinusHeader = false;
    for (const rawLine of diff.split("\n")) {
      if (rawLine.startsWith("diff --git ")) {
        current = null;
        nextLine = 1;
        inHeader = true;
        sawMinusHeader = false;
        continue;
      }
      if (inHeader) {
        if (rawLine.startsWith("--- ")) {
          sawMinusHeader = true;
          continue;
        }
        if (rawLine.startsWith("+++ ")) {
          if (sawMinusHeader) {
            current =
              rawLine === "+++ /dev/null"
                ? null
                : rawLine.slice(4).replace(/^b\//, "");
          }
          continue;
        }
        if (rawLine.startsWith("@@")) {
          inHeader = false;
        } else {
          continue;
        }
      }
      if (rawLine.startsWith("@@")) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(rawLine);
        nextLine = match === null ? nextLine : Number(match[1]);
        continue;
      }
      if (rawLine.startsWith("+") && current !== null) {
        const lines = addedLines.get(current) ?? [];
        lines.push({ line: nextLine, text: rawLine.slice(1) });
        addedLines.set(current, lines);
        nextLine += 1;
        continue;
      }
      if (rawLine.startsWith(" ")) nextLine += 1;
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
