// Domain (pure): validation of worktree-relative file paths. A valid path is
// a non-empty relative string that never escapes the worktree root. No
// filesystem, no subprocess, no Node builtins: the check only shapes the
// string. ADR-0054 forbids Node builtins (including `node:path`) in the
// domain, so the posix-style normalisation below is a local, pure twin of
// `path.posix.normalize` restricted to relative paths; it yields the same
// verdicts for every input that reaches it.

/**
 * Pure posix-style normalisation of a relative path: resolves `.` and `..`
 * segments, collapses duplicate slashes and maps an empty result to `.`.
 * Equivalent to `path.posix.normalize` for relative inputs.
 */
function normalizeRelativePosixPath(input: string): string {
  const segments = input.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else {
        out.push(segment);
      }
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? '.' : out.join('/');
}

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
  const normalized = normalizeRelativePosixPath(path);
  if (normalized === '..' || normalized.startsWith('../')) {
    return 'worktree-relative path must not escape the worktree root';
  }
  return null;
}
