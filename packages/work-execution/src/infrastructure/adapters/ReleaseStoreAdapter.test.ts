import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReleaseStoreAdapter } from './ReleaseStoreAdapter.adapter.js';

const sha = (digit: string): string => digit.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');
const E = sha('e');
const at = (day: number): string => `2026-11-0${day}T09:00:00.000Z`;

describe('ReleaseStoreAdapter', () => {
  let tempDir: string;
  let root: string;
  let adapter: ReleaseStoreAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-store-test-'));
    root = path.join(tempDir, 'releases');
    adapter = new ReleaseStoreAdapter();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function verified(digit: string, day: number): Promise<string> {
    const id = sha(digit);
    expect(await adapter.prepare({ root, sha: id })).toEqual({ outcome: 'ok' });
    const entry = path.join(root, id, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    expect(await adapter.markVerified({ root, sha: id, builtAtIso: at(day) })).toEqual({ outcome: 'ok' });
    return id;
  }

  it('repoints current atomically to a verified build', async () => {
    await verified('a', 1);
    await verified('b', 2);
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'ok' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
    expect(await adapter.repoint({ root, sha: B })).toEqual({ outcome: 'ok' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
    expect(await adapter.repoint({ root, sha: B })).toEqual({ outcome: 'ok' });
    expect(await adapter.list({ root })).toMatchObject({ outcome: 'read', current: B });
    expect((await fs.readdir(root)).sort()).toEqual([A, B, 'current']);
    expect(await fs.readFile(path.join(root, 'current', 'apps', 'cli', 'dist', 'bin.js'), 'utf8')).toBe('// cli\n');
  });

  it('refuses to repoint to a sha that is not a kept build', async () => {
    await verified('a', 1);
    await fs.mkdir(path.join(root, B));
    expect(await adapter.repoint({ root, sha: B })).toEqual({ outcome: 'not-found' });
    expect(await adapter.repoint({ root, sha: C })).toEqual({ outcome: 'not-found' });
    expect(await adapter.repoint({ root, sha: '../etc' })).toEqual({ outcome: 'not-found' });
    await expect(fs.lstat(path.join(root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to repoint when current is not a symlink', async () => {
    await verified('a', 1);
    await fs.mkdir(path.join(root, 'current'));
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'unreadable' });
    expect((await fs.lstat(path.join(root, 'current'))).isDirectory()).toBe(true);
    expect(await adapter.list({ root })).toEqual({ outcome: 'unreadable' });
  });

  it('lists the kept builds oldest first and ignores an unverified build dir', async () => {
    await verified('c', 3);
    await verified('a', 1);
    await verified('b', 1);
    await fs.mkdir(path.join(root, D));
    await fs.mkdir(path.join(root, 'not-a-sha'));
    expect(await adapter.list({ root })).toEqual({
      outcome: 'read',
      current: null,
      builds: [
        { sha: A, builtAtIso: at(1) },
        { sha: B, builtAtIso: at(1) },
        { sha: C, builtAtIso: at(3) },
      ],
    });
    await fs.writeFile(path.join(root, B, '.fleet-release-verified'), '{not json');
    expect(await adapter.list({ root })).toEqual({ outcome: 'unreadable' });
  });

  it('lists a link that points outside the root as unreadable', async () => {
    await verified('a', 1);
    await fs.symlink(tempDir, path.join(root, 'current'));
    expect(await adapter.list({ root })).toEqual({ outcome: 'unreadable' });
  });

  it('reports an unreadable root as unreadable, never as an empty store', async () => {
    await fs.writeFile(root, 'not a directory');
    expect(await adapter.list({ root })).toEqual({ outcome: 'unreadable' });
    expect(await adapter.prune({ root, keep: 2 })).toEqual({ outcome: 'unreadable' });
    expect(await adapter.prepare({ root, sha: A })).toEqual({ outcome: 'unreadable' });
  });

  it('treats a missing root as an empty first-install store', async () => {
    expect(await adapter.list({ root })).toEqual({ outcome: 'read', current: null, builds: [] });
  });

  it('prunes to the keep count and never removes current or previous', async () => {
    for (const [digit, day] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) {
      await verified(digit, day);
    }
    await adapter.repoint({ root, sha: B });
    await fs.mkdir(path.join(root, sha('f')));
    expect(await adapter.prune({ root, keep: 2 })).toEqual({ outcome: 'pruned', removed: [C] });
    expect((await fs.readdir(root)).sort()).toEqual([A, B, 'current', D, E, sha('f')]);
    expect(await adapter.prune({ root, keep: 2 })).toEqual({ outcome: 'pruned', removed: [] });
    expect(await adapter.prune({ root, keep: 1 })).toEqual({ outcome: 'unreadable' });
  });

  it('removes the leftover archive file', async () => {
    await verified('a', 1);
    await fs.writeFile(path.join(root, `${B}.tar`), 'tar');
    await fs.writeFile(path.join(root, 'notes.tar'), 'keep');
    expect(await adapter.prune({ root, keep: 2 })).toEqual({ outcome: 'pruned', removed: [] });
    expect((await fs.readdir(root)).sort()).toEqual([A, 'notes.tar']);
  });

  it('markVerified refuses a build without the CLI entry', async () => {
    await adapter.prepare({ root, sha: A });
    expect(await adapter.markVerified({ root, sha: A, builtAtIso: at(1) })).toEqual({ outcome: 'not-verified' });
    await fs.mkdir(path.join(root, A, 'apps', 'cli', 'dist', 'bin.js'), { recursive: true });
    expect(await adapter.markVerified({ root, sha: A, builtAtIso: at(1) })).toEqual({ outcome: 'not-verified' });
    expect(await adapter.markVerified({ root, sha: B, builtAtIso: at(1) })).toEqual({ outcome: 'not-found' });
    expect(await adapter.list({ root })).toEqual({ outcome: 'read', current: null, builds: [] });
  });
});
