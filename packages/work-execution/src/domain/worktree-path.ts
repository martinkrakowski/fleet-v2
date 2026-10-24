// Domain (pure): validation of worktree-relative file paths. A valid path is
// a non-empty relative string that never escapes the worktree root and never
// names the worktree itself. No filesystem, no subprocess, no Node builtins:
// the check only shapes the string. ADR-0054 forbids Node builtins
// (including `node:path`) in the domain, so the posix-style normalisation
// below is a local, pure normaliser of relative paths; it matches
// `path.posix.normalize` on the `..` verdict only, which is the sole verdict
// the validation relies on.

/**
 * Pure posix-style normalisation of a relative path: resolves `.` and `..`
 * segments and collapses duplicate and trailing slashes. This is NOT
 * equivalent to `path.posix.normalize` in general: `path.posix.normalize`
 * keeps a trailing slash and preserves interior `./` segments, while this
 * function drops both. The only guarantee it makes — and the only thing any
 * caller may rely on — is the `..` verdict: the result contains a `..`
 * segment exactly when the input escapes the worktree root, and an empty or
 * `.` result means the input names the worktree root itself, never a file.
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
 * is acceptable, otherwise a reason string. The check targets POSIX hosts:
 * backslashes anywhere and drive-letter forms (with or without a following
 * separator) are refused outright, as are absolute POSIX paths, NUL bytes
 * and `..` escapes, so a caller can safely join the path under a worktree
 * root.
 */
export function validateWorktreeRelativePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return 'worktree-relative path must be a non-empty string';
  }
  if (path.includes('\0')) {
    return 'worktree-relative path must not contain NUL bytes';
  }
  if (path.includes('\\')) {
    return 'worktree-relative path must not contain backslashes';
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return 'worktree-relative path must be relative';
  }
  const normalized = normalizeRelativePosixPath(path);
  if (normalized === '..' || normalized.startsWith('../')) {
    return 'worktree-relative path must not escape the worktree root';
  }
  // A path that normalises to `.` (or to empty) names the worktree itself,
  // which is not a file: reading it (`cat /wt`) is refused, not performed.
  if (normalized === '.' || normalized === '') {
    return 'worktree-relative path must name a file inside the worktree, not the worktree itself';
  }
  return null;
}
