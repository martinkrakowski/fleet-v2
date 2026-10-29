// Shared helper for git top-level checks: macOS reports symlinked directories
// under their physical form (`/var/folders/...` → `/private/var/folders/...`),
// so `git rev-parse --show-toplevel` prints a path that differs from the one a
// profile holds for the same directory. The physical form is asked for on the
// same host the git command runs on — through the same `CommandExecutorPort`,
// so an ssh host resolves it remotely, never locally.

import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';

/**
 * The exact argv of the physical-path question. The path travels as the
 * operand of `sh`'s `$1`, never interpolated into the script text.
 */
export function physicalPathArgv(path: string): string[] {
  return ['sh', '-c', 'cd -- "$1" && pwd -P', 'sh', path];
}

/**
 * The physical path of `path` on the executor's host, or null when the
 * question does not answer with an exit-0 stdout (spawn failure, timeout,
 * non-zero exit, empty output). Null means "fall back to the path as given".
 */
export async function resolvePhysicalPath(
  executor: CommandExecutorPort,
  path: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const run = await executor.run(physicalPathArgv(path), { timeoutMs });
    if (run.error !== undefined || run.exitCode === null || run.exitCode !== 0) return null;
    const physical = run.stdout.trim();
    return physical === '' ? null : physical;
  } catch {
    return null;
  }
}
