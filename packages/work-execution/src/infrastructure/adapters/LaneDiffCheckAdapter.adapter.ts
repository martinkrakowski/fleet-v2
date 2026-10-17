// Adapter scaffold — implemented for lane O14d1.
/**
 * LaneDiffCheckAdapter implements LaneDiffCheckPort over an injected
 * CommandExecutorPort: it collects the worktree's tracked and untracked
 * changes (`git status --porcelain=v1 -z --untracked-files=all`,
 * `git diff --no-ext-diff -U0 <base>` plus the committed delta since the
 * base, mirroring `scripts/lane-diff-check.sh`), then calls the pure
 * `checkLaneDiff`. It mirrors the script's collection: git plumbing never
 * lists anything under `.git/`, so no snapshot comparison exists there
 * and the fixed `.git/` protected rule stays as defense in depth. Every command
 * failure fails closed as `error`; no file content is ever printed or
 * carried in a finding.
 */

import type {
  LaneDiffCheckPort,
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from '../../application/ports/out/LaneDiffCheckPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  LaneDiffChangedPath,
  LaneDiffSecretPattern,
  LaneDiffFileStatus,
} from '../../domain/lane-diff-check.js';
import { checkLaneDiff } from '../../domain/lane-diff-check.js';
import { namedSecretPatterns } from '@fleet/shared';

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

  async checkLaneDiff(request: LaneDiffCheckRequest): Promise<LaneDiffCheckResult> {
    const git = async (argv: readonly string[], what: string): Promise<CommandOutcome> => {
      const run = await this.commandExecutor.run(
        ['git', '-c', 'core.quotePath=false', ...argv],
        { cwd: request.worktreePath },
      );
      if (run.error !== undefined || run.exitCode !== 0) {
        return { ok: false, stdout: '', reason: `lane diff check: could not ${what}` };
      }
      return { ok: true, stdout: run.stdout, reason: '' };
    };

    const status = await git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      'list the changed files',
    );
    if (!status.ok) return { outcome: 'error', reason: status.reason };

    const changed = new Map<string, LaneDiffChangedPath>();
    const untracked: string[] = [];
    this.collectStatusEntries(status.stdout, changed, untracked);

    const addedLines = new Map<string, { line: number; text: string }[]>();

    const diff = await git(
      ['diff', '--no-ext-diff', '-U0', '--no-renames', request.baseCommit],
      'read the added lines',
    );
    if (!diff.ok) return { outcome: 'error', reason: diff.reason };
    this.collectAddedLines(diff.stdout, addedLines);

    // Committed changes since the base are still reviewed, like the script's
    // `base...HEAD` collection. HEAD-unchanged-since-dispatch is the caller's
    // step 1; this keeps the verdicts identical if the caller defers it.
    const committed = await git(
      ['diff', '--no-ext-diff', '-U0', '--no-renames', `${request.baseCommit}...HEAD`],
      'read the committed added lines',
    );
    if (!committed.ok) return { outcome: 'error', reason: committed.reason };
    this.collectAddedLines(committed.stdout, addedLines);

    // An untracked file's whole content is added lines.
    for (const path of untracked) {
      const run = await this.commandExecutor.run(['cat', '--', path], { cwd: request.worktreePath });
      if (run.error !== undefined || run.exitCode !== 0) {
        return { outcome: 'error', reason: 'lane diff check: could not read an untracked file' };
      }
      addedLines.set(
        path,
        run.stdout.split('\n').map((text, index) => ({ line: index + 1, text })),
      );
    }

    const changedPaths: LaneDiffChangedPath[] = [...changed.values()].map((entry) => ({
      ...entry,
      ...(addedLines.has(entry.path) ? { addedLines: addedLines.get(entry.path) } : {}),
    }));

    const verdict = checkLaneDiff({
      changedPaths,
      allowedPathPrefixes: request.allowedPathPrefixes,
      ...(request.policyProtectedPaths !== undefined
        ? { policyProtectedPaths: request.policyProtectedPaths }
        : {}),
      ...(request.secretPatterns !== undefined
        ? { secretPatterns: request.secretPatterns }
        : { secretPatterns: this.options?.secretPatterns ?? defaultSecretPatterns() }),
    });
    return verdict.ok ? { outcome: 'clean' } : { outcome: 'findings', findings: verdict.findings };
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
    const fields = stdout.split('\0');
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index];
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const path = entry.slice(3);
      if (x === '?' && y === '?') {
        untracked.push(path);
        changed.set(path, { path, status: 'untracked' });
        continue;
      }
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        const original = fields[index + 1] ?? '';
        index += 1;
        if (original !== '') {
          changed.set(original, { path: original, status: 'deleted' });
        }
        changed.set(path, { path, status: 'added' });
        continue;
      }
      const status: LaneDiffFileStatus = x === 'A' || y === 'A' ? 'added' : y === 'D' || x === 'D' ? 'deleted' : 'modified';
      changed.set(path, { path, status });
    }
  }

  /**
   * Parse a `-U0` unified diff: the `+++ b/<path>` header names the file and
   * each `@@ -a,b +m,n @@` hunk header sets the next 1-based new-file line
   * number for the `+` lines that follow.
   */
  private collectAddedLines(diff: string, addedLines: Map<string, { line: number; text: string }[]>): void {
    let current: string | null = null;
    let nextLine = 1;
    for (const rawLine of diff.split('\n')) {
      if (rawLine.startsWith('+++ ')) {
        current = rawLine === '+++ /dev/null' ? null : rawLine.slice(4).replace(/^b\//, '');
        continue;
      }
      if (rawLine.startsWith('@@')) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(rawLine);
        nextLine = match === null ? nextLine : Number(match[1]);
        continue;
      }
      if (rawLine.startsWith('+') && current !== null) {
        const lines = addedLines.get(current) ?? [];
        lines.push({ line: nextLine, text: rawLine.slice(1) });
        addedLines.set(current, lines);
        nextLine += 1;
        continue;
      }
      if (rawLine.startsWith(' ')) nextLine += 1;
    }
  }
}

/** The shared registry (Q0) with rule names; imported lazily to stay injected. */
function defaultSecretPatterns(): readonly LaneDiffSecretPattern[] {
  return namedSecretPatterns().map((entry) => ({ name: entry.name, regex: entry.regex }));
}
