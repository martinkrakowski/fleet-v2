/**
 * PT1a: the screen for the repo-relative file a failing check names. A
 * verification receipt carries it as `failingFile` so the conductor can tell
 * a park caused outside the work order's owned paths from one inside them.
 * Pure: no I/O; the producing side also applies the secret detectors. An unusable value reads as null, never a repaired guess, and
 * is never echoed.
 */

/** The longest file path a receipt carries. */
export const FAILING_FILE_MAX_LENGTH = 200;

/** A repo-relative path: no leading separator, no control or space character, only path-safe characters. */
const FAILING_FILE_PATTERN = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+/-]*$/;

/** A Windows drive prefix (`C:`) the path pattern would otherwise let through as a segment. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * The value when it is a bounded, repo-relative path, else null.
 * Refused: a non-string, empty or over-long value, an absolute path, a
 * backslash, any `..` and a drive prefix.
 */
export function screenFailingFile(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > FAILING_FILE_MAX_LENGTH) {
    return null;
  }
  if (value.includes('..') || DRIVE_PREFIX.test(value) || !FAILING_FILE_PATTERN.test(value)) {
    return null;
  }
  if (value.endsWith('/') || value.includes('//')) {
    return null;
  }
  return value;
}
