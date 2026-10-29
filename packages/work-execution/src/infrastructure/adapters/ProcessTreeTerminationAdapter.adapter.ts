// Lane PK-1a: run the bundled bin/kill-worktree-tree on the attempt's
// recorded host through the ExecutorForHost helper, so the stop, cancel and
// collect paths can clear a worktree's orphaned process tree.
/**
 * ProcessTreeTerminationAdapter executes the bundled kill-worktree-tree
 * script on the host the attempt actually ran on. The script walks /proc on
 * that host and TERMs, then KILLs after a grace period, every process whose
 * working directory is inside the attempt's worktree — and nothing else.
 * A legacy record (no recorded host name) is refused, never killed locally;
 * the worktree path travels only as its own argv element, never inside a
 * command string.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProcessTreeTerminationPort } from '../../application/ports/out/ProcessTreeTerminationPort.out-port.js';
import type {
  TerminateWorktreeProcessesRequest,
  TerminateWorktreeProcessesResult,
} from '../../application/ports/out/ProcessTreeTerminationPort.out-port.js';
import type { ExecutorForHost } from './ExecutorForHost.helper.js';
import { hasRecordedHostName } from './ConfirmRecordedHost.js';

export type {
  TerminateWorktreeProcessesRequest,
  TerminateWorktreeProcessesResult,
} from '../../application/ports/out/ProcessTreeTerminationPort.out-port.js';

/** The maximum grace period the port accepts, in whole seconds. */
const MAX_GRACE_SECONDS = 600;

/** The bundled kill script at the repository's `bin/kill-worktree-tree`. */
function resolveBundledKillWorktreeTreeText(): string | null {
  // Works from both the compiled dist tree and vitest's src tree.
  let current = dirname(fileURLToPath(import.meta.url));
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, 'bin', 'kill-worktree-tree');
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, 'utf8');
      } catch {
        return null;
      }
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

export interface ProcessTreeTerminationAdapterOptions {
  /** The per-recorded-host executor helper the composition root wired. */
  readonly executorForHost: Pick<ExecutorForHost, 'executorForRecordedHost'>;
  /**
   * The test seam: the script text to run instead of the bundled file.
   * An explicit `null` simulates the bundled file being missing, so the
   * every-call-`unavailable` behaviour is testable without the filesystem.
   */
  readonly scriptText?: string | null;
}

export class ProcessTreeTerminationAdapter implements ProcessTreeTerminationPort {
  /** The bundled script's text, read once at construction (null when absent). */
  private readonly defaultScriptText: string | null;

  constructor(private readonly options: ProcessTreeTerminationAdapterOptions) {
    this.defaultScriptText = options.scriptText === undefined
      ? resolveBundledKillWorktreeTreeText()
      : (options.scriptText ?? null);
  }

  async terminateWorktreeProcesses(
    request: TerminateWorktreeProcessesRequest,
  ): Promise<TerminateWorktreeProcessesResult> {
    if (!hasRecordedHostName(request.runner)) {
      return {
        outcome: 'refused',
        reason: 'attempt has no recorded host',
      };
    }
    const resolved = this.options.executorForHost.executorForRecordedHost(
      request.runner,
    );
    if (!resolved.ok) {
      return { outcome: 'refused', reason: resolved.reason };
    }
    if (!isAbsoluteWorktreePath(request.worktreePath)) {
      return {
        outcome: 'refused',
        reason: 'worktree path is not absolute',
      };
    }
    const grace = request.gracePeriodSeconds;
    if (
      !Number.isInteger(grace) ||
      grace < 0 ||
      grace > MAX_GRACE_SECONDS
    ) {
      return {
        outcome: 'refused',
        reason: 'grace period must be an integer between 0 and 600 seconds',
      };
    }
    const scriptText = this.options.scriptText ?? this.defaultScriptText;
    if (scriptText === null || scriptText === undefined) {
      return {
        outcome: 'unavailable',
        reason: 'kill-worktree-tree script not found',
      };
    }
    // The worktree path and grace travel as their own argv elements; the
    // script text is the single `sh -c` script argument.
    const result = await resolved.executor.run(
      [
        'sh',
        '-c',
        scriptText,
        'kill-worktree-tree',
        request.worktreePath,
        String(grace),
      ],
      { timeoutMs: (grace + 20) * 1000, killProcessTree: true },
    );
    if (result.exitCode === 0 && result.error === undefined) {
      const killed = parseKilledCount(result.stdout);
      if (killed === null) {
        return {
          outcome: 'unavailable',
          reason: 'script printed no kill count',
        };
      }
      return { outcome: 'terminated', killed };
    }
    if (result.exitCode === 3 && result.error === undefined) {
      const unavailable = parseUnavailableReason(result.stdout);
      if (unavailable !== null) {
        return { outcome: 'unavailable', reason: unavailable };
      }
    }
    const how = result.exitCode !== null ? String(result.exitCode) : (result.signal ?? 'unknown');
    return {
      outcome: 'unavailable',
      reason: `kill-worktree-tree failed (exit ${how})`,
    };
  }
}

/** The `killed=<n>` count from the last non-blank stdout line, or null. */
function parseKilledCount(stdout: string): number | null {
  const last = lastNonBlankLine(stdout);
  if (last === null) return null;
  const match = /^killed=([0-9]+)$/.exec(last);
  return match === null ? null : Number(match[1]);
}

/** The `unavailable=<word>` line from the stdout, or null. */
function parseUnavailableReason(stdout: string): string | null {
  const lines = stdout.split('\n');
  let found: string | null = null;
  for (const line of lines) {
    if (line.startsWith('unavailable=')) found = line;
  }
  return found;
}

function lastNonBlankLine(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return null;
}

/** An absolute path with no newline and no NUL character. */
function isAbsoluteWorktreePath(worktreePath: string): boolean {
  return (
    worktreePath.startsWith('/') &&
    !worktreePath.includes('\n') &&
    !worktreePath.includes('\0')
  );
}
