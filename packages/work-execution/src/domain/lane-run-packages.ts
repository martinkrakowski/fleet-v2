/**
 * The packages a lane run owns (K7-D5, owner decision of 2026-10-27): a
 * package is the repository plus the `packages/<x>` / `apps/<x>` prefixes of
 * a work order's `ownedPaths`. Pure: never throws, reads no clock and no
 * store; used by conductor admission to refuse while another active run
 * shares a package of the same repository.
 */

/** The first path segment, trimmed; blank and `..` segments are skipped. */
function firstSegmentOf(ownedPath: string): string | null {
  if (typeof ownedPath !== 'string') {
    return null;
  }
  const segments = ownedPath.split('/');
  const first = segments[0]?.trim() ?? '';
  if (first === '' || first === '..') {
    return null;
  }
  return first;
}

/**
 * The packages a work order owns (K7-D5): `packages/<x>` or `apps/<x>` when
 * a path starts so, else its first segment; deduplicated, sorted with a
 * compare function. A blank or `..` segment is skipped; never throws.
 */
export function laneRunPackageKeys(ownedPaths: readonly string[]): readonly string[] {
  const keys = new Set<string>();
  for (const ownedPath of ownedPaths) {
    const first = firstSegmentOf(ownedPath);
    if (first === null) {
      continue;
    }
    if (first === 'packages' || first === 'apps') {
      const second = ownedPath.split('/')[1]?.trim() ?? '';
      if (second !== '' && second !== '..') {
        keys.add(first + '/' + second);
      } else if (ownedPath.trim().replace(/\/+$/u, '') === first) {
        // Exactly `packages` / `apps` (a trailing slash allowed) owns the whole tree: its key overlaps every
        // `packages/<x>` / `apps/<x>` key. Any other blank or `..` second segment is still skipped.
        keys.add(first);
      }
      continue;
    }
    keys.add(first);
  }
  return [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Whether two package keys overlap: equal, or a bare tree key over its own children. */
function packageKeysOverlap(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a === 'packages' || a === 'apps') {
    return b.startsWith(a + '/');
  }
  if (b === 'packages' || b === 'apps') {
    return a.startsWith(b + '/');
  }
  return false;
}

/** Same repository and at least one shared package key. */
export function laneRunPackagesOverlap(
  a: { readonly repository: string; readonly ownedPaths: readonly string[] },
  b: { readonly repository: string; readonly ownedPaths: readonly string[] },
): boolean {
  if (a.repository !== b.repository) {
    return false;
  }
  const bKeys = laneRunPackageKeys(b.ownedPaths);
  return laneRunPackageKeys(a.ownedPaths).some((key) => bKeys.some((other) => packageKeysOverlap(key, other)));
}
