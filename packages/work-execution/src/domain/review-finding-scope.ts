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

/** Strip one leading `./`; no other rewriting. */
function normaliseFindingPath(filePath: string): string {
  return filePath.startsWith('./') ? filePath.slice(2) : filePath;
}

/**
 * Partition findings into in-scope and out-of-scope against the changed-path
 * set, preserving order in both lists. `changedPaths === null` (the set could
 * not be read) puts every finding in scope. Only an exact match — after
 * stripping one leading `./` from the finding path — counts; a path that is
 * merely a prefix of a changed path is out of scope.
 */
export function partitionFindingsByScope<T extends ScopedFinding>(
  findings: readonly T[],
  changedPaths: readonly string[] | null,
): { readonly inScope: readonly T[]; readonly outOfScope: readonly T[] } {
  if (changedPaths === null) {
    return { inScope: [...findings], outOfScope: [] };
  }
  const changed = new Set(changedPaths);
  const inScope: T[] = [];
  const outOfScope: T[] = [];
  for (const finding of findings) {
    if (finding.filePath === null || changed.has(normaliseFindingPath(finding.filePath))) {
      inScope.push(finding);
    } else {
      outOfScope.push(finding);
    }
  }
  return { inScope, outOfScope };
}
