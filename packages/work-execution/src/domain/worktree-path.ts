// Domain (pure): validation of worktree-relative file paths. A valid path is
// a non-empty relative string that never escapes the worktree root. No
// filesystem, no subprocess: the check only shapes the string.

import { posix } from 'node:path';

/**
 * Validate one candidate worktree-relative path. Returns null when the path
 * is acceptable, otherwise a reason string. Absolute paths (POSIX leading
 * separators and Windows drive forms), NUL bytes and `..` escapes are refused
 * so a caller can safely join the path under a worktree root.
 */
export function validateWorktreeRelativePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return 'worktree-relative path must be a non-empty string';
  }
  if (path.includes('\0')) {
    return 'worktree-relative path must not contain NUL bytes';
  }
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
    return 'worktree-relative path must be relative';
  }
  const normalized = posix.normalize(path);
  if (normalized === '..' || normalized.startsWith('../')) {
    return 'worktree-relative path must not escape the worktree root';
  }
  return null;
}
