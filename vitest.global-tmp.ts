// One run-scoped temp root per vitest run.
//
// `globalSetup` creates a single `fleet-vitest-` directory under the incoming
// `os.tmpdir()` and points `TMPDIR` at it, so setup code, workers and child
// processes resolve `os.tmpdir()` to the run directory. The returned teardown
// restores the previous `TMPDIR` and removes the run directory, refusing any
// path that is not contained in the parent the setup created. Teardown never
// throws: a failed removal is reported on stderr only.
import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Remove `dir` only when it is contained inside `parentDir` (and is not
 * `parentDir` itself). Refusal, and any removal error, are each reported with
 * a single stderr line; this function never throws. Cost bound: O(1) — two
 * `path.resolve` calls and one string prefix comparison, no traversal.
 */
export function removeRunTmpDir(dir: string, parentDir: string): void {
  const resolvedDir = resolve(dir);
  const resolvedParent = resolve(parentDir);
  const prefix = resolvedParent.endsWith(sep) ? resolvedParent : resolvedParent + sep;
  if (resolvedDir === resolvedParent || !resolvedDir.startsWith(prefix)) {
    process.stderr.write(
      `vitest.global-tmp: refusing to remove ${resolvedDir}: outside the run temp parent ${resolvedParent}\n`,
    );
    return;
  }
  try {
    rmSync(resolvedDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `vitest.global-tmp: failed to remove run temp directory ${resolvedDir}: ${message}\n`,
    );
  }
}

/**
 * Create the run temp root and redirect `TMPDIR` at it. Returns the teardown
 * function vitest runs after the suite.
 */
export default function globalSetup(): () => void {
  const parentTmp = tmpdir();
  const hadTmpdir = Object.prototype.hasOwnProperty.call(process.env, 'TMPDIR');
  const prevTmpdir = process.env.TMPDIR;

  const runDir = mkdtempSync(join(parentTmp, 'fleet-vitest-'));
  process.env.TMPDIR = runDir;

  return () => {
    if (hadTmpdir) {
      process.env.TMPDIR = prevTmpdir;
    } else {
      delete process.env.TMPDIR;
    }
    removeRunTmpDir(runDir, parentTmp);
  };
}
