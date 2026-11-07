/**
 * CO14b 4.4: orphaned `.current.*.tmp` links left by an interrupted repoint
 * are removed safely — never the `current` link, never a build directory, and
 * never any entry that is not a link. An unreadable root is unknown
 * (`release-unknown-state`), never "no orphans". The cleanup is idempotent.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReleaseStoreAdapter } from '../ReleaseStoreAdapter.adapter.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const at = (day: number): string => `2026-11-0${day}T09:00:00.000Z`;

describe('ReleaseStoreAdapter orphan temp-link cleanup', () => {
  let tempDir: string;
  let root: string;
  let adapter: ReleaseStoreAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-orphan-test-'));
    root = path.join(tempDir, 'releases');
    adapter = new ReleaseStoreAdapter();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Seed one verified build `<root>/<sha>` (the same fixture CO14's store tests use). */
  async function verified(digit: string, day: number): Promise<string> {
    const id = sha(digit);
    const prepared = await adapter.prepare({ root, sha: id });
    if (prepared.outcome !== 'prepared') {
      throw new Error(`prepare refused for ${id}`);
    }
    const entry = path.join(prepared.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    expect(await adapter.markVerified({ root, sha: id, buildId: prepared.buildId, builtAtIso: at(day) })).toEqual({
      outcome: 'ok',
    });
    return id;
  }

  function sha(digit: string): string {
    return digit.repeat(40);
  }

  it('an interrupted repoint’s orphan temp link is removed and the current link survives', async () => {
    await verified('a', 1);
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'ok' });
    const orphan = path.join(root, '.current.1234.abc123.tmp');
    await fs.symlink(A, orphan);

    const result = await adapter.cleanupOrphanTmpLinks({ root });

    expect(result).toEqual({ outcome: 'cleaned', removed: 1, findings: [] });
    await expect(fs.lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
    expect(await adapter.list({ root })).toMatchObject({ outcome: 'read', current: A });
  });

  it('a build directory and the current link are never removed (a matching directory is reported)', async () => {
    await verified('a', 1);
    await verified('b', 2);
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'ok' });
    // A directory whose name matches the temp pattern: reported, never removed.
    const pseudoTmpDir = path.join(root, '.current.leftover.tmp');
    await fs.mkdir(pseudoTmpDir);

    const result = await adapter.cleanupOrphanTmpLinks({ root });

    expect(result).toEqual({ outcome: 'cleaned', removed: 0, findings: ['.current.leftover.tmp'] });
    await expect(fs.lstat(pseudoTmpDir)).resolves.toBeDefined();
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
    expect(await fs.stat(path.join(root, A))).toBeDefined();
    expect(await fs.stat(path.join(root, B))).toBeDefined();
    expect(await adapter.list({ root })).toMatchObject({ outcome: 'read', current: A });
  });

  it('an unreadable root is reported as unknown, never as empty', async () => {
    // The root path is a regular file, so any directory read throws: the
    // cleanup reports unreadable, never "no orphans" and never a pass.
    await fs.writeFile(root, 'not a directory');
    expect(await adapter.cleanupOrphanTmpLinks({ root })).toEqual({ outcome: 'unreadable' });
  });

  it('the cleanup is idempotent', async () => {
    await verified('a', 1);
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'ok' });
    const orphan = path.join(root, '.current.99.deadbeef.tmp');
    await fs.symlink(A, orphan);

    expect(await adapter.cleanupOrphanTmpLinks({ root })).toEqual({ outcome: 'cleaned', removed: 1, findings: [] });
    // A second pass over the now-clean root removes nothing.
    expect(await adapter.cleanupOrphanTmpLinks({ root })).toEqual({ outcome: 'cleaned', removed: 0, findings: [] });
  });
});
