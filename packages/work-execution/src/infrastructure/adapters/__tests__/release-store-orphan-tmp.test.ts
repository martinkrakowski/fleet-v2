/**
 * CO14 follow-up, item 4.4: an interrupted repoint can leave
 * `<root>/.current.<something>.tmp` links. The cleanup pass removes only
 * entries that are links whose name matches that temp pattern — never the
 * `current` link, never a build directory, never an entry that is not a link
 * (that entry is reported as a finding). It is idempotent, and an unreadable
 * root is reported as unknown, never as empty.
 */

import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReleaseStoreAdapter } from '../ReleaseStoreAdapter.adapter.js';

const SHA = 'a'.repeat(40);

let root = '';
let store: ReleaseStoreAdapter;

async function verifiedBuild(sha: string): Promise<void> {
  const build = join(root, sha);
  await mkdir(join(build, 'apps', 'cli', 'dist'), { recursive: true });
  await writeFile(join(build, 'apps', 'cli', 'dist', 'bin.js'), '// built\n');
  await writeFile(join(build, '.fleet-release-verified'), JSON.stringify({ version: 1, sha, builtAtIso: '2026-11-10T10:00:00.000Z' }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'co14b-orphans-'));
  store = new ReleaseStoreAdapter();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('orphaned .current temp links (CO14 follow-up)', () => {
  it('an interrupted repoint\'s orphan temp link is removed and the current link survives', async () => {
    await verifiedBuild(SHA);
    await symlink(SHA, join(root, 'current'));
    await symlink(SHA, join(root, '.current.1234.abc.tmp'));
    const result = await store.removeOrphanCurrentTemps({ root });
    expect(result).toEqual({ outcome: 'cleaned', removed: 1, findings: 0 });
    expect(await lstat(join(root, 'current'))).toBeTruthy();
    expect(await lstat(join(root, SHA))).toBeTruthy();
    expect(await readdir(root)).toEqual([SHA, 'current']);
  });

  it('a build directory and the current link are never removed; a temp-named directory is reported, not removed', async () => {
    await verifiedBuild(SHA);
    await symlink(SHA, join(root, 'current'));
    // A temp-named directory (not a link) is a finding: reported, never removed.
    await mkdir(join(root, '.current.5678.def.tmp'));
    const result = await store.removeOrphanCurrentTemps({ root });
    expect(result).toEqual({ outcome: 'cleaned', removed: 0, findings: 1 });
    expect(await lstat(join(root, 'current'))).toBeTruthy();
    expect(await lstat(join(root, SHA))).toBeTruthy();
    expect(await lstat(join(root, '.current.5678.def.tmp'))).toBeTruthy();
  });

  it('an unreadable root is reported as unknown, never as empty', async () => {
    // A root that is a file, not a directory: the read fails, the result is unknown.
    const filePath = join(root, 'not-a-directory');
    await writeFile(filePath, 'x');
    expect(await store.removeOrphanCurrentTemps({ root: filePath })).toEqual({ outcome: 'unknown' });
  });

  it('the cleanup is idempotent', async () => {
    await verifiedBuild(SHA);
    await symlink(SHA, join(root, 'current'));
    await symlink(SHA, join(root, '.current.1111.111111.tmp'));
    const first = await store.removeOrphanCurrentTemps({ root });
    expect(first).toEqual({ outcome: 'cleaned', removed: 1, findings: 0 });
    const second = await store.removeOrphanCurrentTemps({ root });
    expect(second).toEqual({ outcome: 'cleaned', removed: 0, findings: 0 });
    expect(await readdir(root)).toEqual([SHA, 'current']);
  });

  it('a failed or throwing fence stops the pass and removes nothing (an in-flight link is never deleted)', async () => {
    await verifiedBuild(SHA);
    await symlink(SHA, join(root, 'current'));
    await symlink(SHA, join(root, '.current.inflight.tmp'));
    expect(await store.removeOrphanCurrentTemps({ root, fence: async () => false })).toEqual({ outcome: 'unknown' });
    expect(
      await store.removeOrphanCurrentTemps({
        root,
        fence: async () => {
          throw new Error('lease lost');
        },
      }),
    ).toEqual({ outcome: 'unknown' });
    expect(await readdir(root)).toEqual(['.current.inflight.tmp', SHA, 'current']);
    expect(await store.removeOrphanCurrentTemps({ root, fence: async () => true })).toEqual({
      outcome: 'cleaned',
      removed: 1,
      findings: 0,
    });
  });
});
