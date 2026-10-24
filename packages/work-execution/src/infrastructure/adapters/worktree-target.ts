/**
 * Adapter-layer helper for resolving one caller-supplied path against a
 * worktree root. This is the single containment point for every worktree
 * target path built from caller input: the worktree must be an absolute
 * path that is not the filesystem root, an absolute candidate is accepted
 * only when it lies inside the worktree itself, and the resulting relative
 * candidate must pass the domain check before anything is joined and run.
 */

import * as path from 'node:path';

import { WorktreePathRefusedError } from '../../application/ports/out/WorkspacePort.out-port.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';

/**
 * Resolve one target path under `worktreePath`. Returns the absolute target
 * path, or throws `WorktreePathRefusedError` before any command runs.
 *
 * - The worktree root is stripped of trailing slashes; an empty result
 *   (`/`, `//`, `''`) or a relative worktree path is refused.
 * - An absolute candidate is rewritten to its worktree-relative form when it
 *   starts with `root + '/'`; any other absolute candidate is refused.
 * - The relative candidate must pass `validateWorktreeRelativePath`.
 */
export function resolveWorktreeTarget(worktreePath: string, candidate: string): string {
  const trimmedWorktreeRoot = worktreePath.replace(/\/+$/, '');
  if (trimmedWorktreeRoot === '' || !worktreePath.startsWith('/')) {
    throw new WorktreePathRefusedError(
      candidate,
      'worktree path must be an absolute path that is not the filesystem root',
    );
  }
  let relative = candidate;
  if (relative.startsWith('/') && relative.startsWith(`${trimmedWorktreeRoot}/`)) {
    relative = relative.slice(trimmedWorktreeRoot.length + 1);
  }
  const refusedReason = validateWorktreeRelativePath(relative);
  if (refusedReason !== null) {
    throw new WorktreePathRefusedError(candidate, refusedReason);
  }
  return path.join(worktreePath, relative);
}
