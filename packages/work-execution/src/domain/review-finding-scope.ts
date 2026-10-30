/**
 * KF-33a: the pure scope rule for a fix round's review findings. A finding is
 * in scope when it names no file (a general finding) or its file is one of the
 * paths the lane changed between the run's base and the prior attempt's head.
 * Fail closed: an unreadable changed-path set (null) keeps every finding in
 * scope, exactly as before the rule existed. Pure: no reads, no throws.
 */

/** A finding as the scope rule sees it: it may name no file at all. */
interface ScopedFinding {
  readonly filePath: string | null;
}

/**
 * Normalise a finding path for comparison against a `git diff --name-only`
 * entry: trim; strip ONE pair of surrounding backticks or single/double
 * quotes; when `worktreePath` is non-null, strip the worktree prefix from an
 * absolute path under it; strip one leading `./`; strip one trailing `/`.
 */
function normaliseFindingPath(filePath: string, worktreePath: string | null): string {
  let path = filePath.trim();
  const quoted = /^(?:`([^`]*)`|'([^']*)'|"([^"]*)")$/.exec(path);
  if (quoted !== null) {
    path = quoted[1] ?? quoted[2] ?? quoted[3]!;
  }
  if (worktreePath !== null && path.startsWith(worktreePath + '/')) {
    path = path.slice(worktreePath.length + 1);
  }
  if (path.startsWith('./')) {
    path = path.slice(2);
  }
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/** Unknown spellings (empty, absolute, or carrying a `..` segment) fail closed. */
function isUnrecognisedPath(path: string): boolean {
  return path === '' || path.startsWith('/') || path.split('/').includes('..');
}

/**
 * Partition findings into in-scope and out-of-scope against the changed-path
 * set, preserving order in both lists. `changedPaths === null` (the set could
 * not be read) puts every finding in scope. Each finding path is normalised
 * against the prior attempt's `worktreePath` (when given) before comparing;
 * only an exact match counts — a path that is merely a prefix of a changed
 * path is out of scope. A path that stays unrecognised after normalising
 * (empty, absolute, or with a `..` segment) stays in scope: unknown spellings
 * fail closed. Case variants are not matched — they would be dropped only if
 * they are clean relative paths that differ from git's spelling; the reviewer
 * prompt asks for repository paths.
 */
export function partitionFindingsByScope<T extends ScopedFinding>(
  findings: readonly T[],
  changedPaths: readonly string[] | null,
  worktreePath: string | null = null,
): { readonly inScope: readonly T[]; readonly outOfScope: readonly T[] } {
  if (changedPaths === null) {
    return { inScope: [...findings], outOfScope: [] };
  }
  const changed = new Set(changedPaths);
  const inScope: T[] = [];
  const outOfScope: T[] = [];
  for (const finding of findings) {
    if (finding.filePath === null) {
      inScope.push(finding);
      continue;
    }
    const normalised = normaliseFindingPath(finding.filePath, worktreePath);
    if (changed.has(normalised) || isUnrecognisedPath(normalised)) {
      inScope.push(finding);
    } else {
      outOfScope.push(finding);
    }
  }
  return { inScope, outOfScope };
}
