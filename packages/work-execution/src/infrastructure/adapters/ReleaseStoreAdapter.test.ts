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

/** lstat that returns null when nothing exists; mirrors the adapter's own read of a path. */
async function lstatOrNullForTest(target: string): Promise<boolean | null> {
  try {
    return (await fs.lstat(target)).isDirectory();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

describe('ReleaseStoreAdapter', () => {
  let tempDir: string;
  let root: string;
  let adapter: ReleaseStoreAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-store-test-'));
    root = path.join(tempDir, 'releases');
    // The store never creates the release root; tests that stage inside it create it via `staged`.
    adapter = new ReleaseStoreAdapter();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function staged(
    id: string,
  ): Promise<{ buildId: string; buildDir: string; archivePath: string; homeDir: string }> {
    // The adapter never creates the release root, so the test fixture does.
    await fs.mkdir(root, { recursive: true });
    const prepared = await adapter.prepare({ root, sha: id });
    if (prepared.outcome !== 'prepared') {
      throw new Error(`prepare refused for ${id}`);
    }
    return prepared;
  }

  async function verified(digit: string, day: number): Promise<string> {
    const id = sha(digit);
    const { buildId, buildDir } = await staged(id);
    const entry = path.join(buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    expect(await adapter.markVerified({ root, sha: id, buildId, builtAtIso: at(day) })).toEqual({ outcome: 'ok' });
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

  it('repoints only when the fence passes, and leaves current untouched otherwise', async () => {
    await verified('a', 1);
    await verified('b', 2);
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'ok' });
    let calls = 0;
    expect(
      await adapter.repoint({
        root,
        sha: B,
        fence: async () => {
          calls += 1;
          return false;
        },
      }),
    ).toEqual({ outcome: 'fenced' });
    expect(
      await adapter.repoint({
        root,
        sha: B,
        fence: async () => {
          throw new Error('lease unreadable');
        },
      }),
    ).toEqual({ outcome: 'fenced' });
    expect(calls).toBe(1);
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
    expect((await fs.readdir(root)).sort()).toEqual([A, B, 'current']);
    expect(await adapter.repoint({ root, sha: B, fence: async () => true })).toEqual({ outcome: 'ok' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
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

  it('reports a dangling symlink root as unreadable, never as an empty store', async () => {
    await fs.symlink(path.join(tempDir, 'gone'), root);
    expect(await adapter.list({ root })).toEqual({ outcome: 'unreadable' });
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

  it('stops pruning when current moved after the snapshot and never removes the new current', async () => {
    for (const [digit, day] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) {
      await verified(digit, day);
    }
    await adapter.repoint({ root, sha: D });
    // A concurrent repoint to B lands right after the prune listed the store.
    const realList = adapter.list.bind(adapter);
    adapter.list = async (input) => {
      const listing = await realList(input);
      await fs.symlink(B, path.join(root, '.current.race.tmp'));
      await fs.rename(path.join(root, '.current.race.tmp'), path.join(root, 'current'));
      return listing;
    };
    expect(await adapter.prune({ root, keep: 2 })).toEqual({ outcome: 'unreadable', removed: [] });
    expect((await fs.lstat(path.join(root, B))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(root, 'current', 'apps', 'cli', 'dist', 'bin.js'), 'utf8')).toBe('// cli\n');
  });

  it('prunes nothing more once the fence fails, and leaves no build half-removed', async () => {
    for (const [digit, day] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) {
      await verified(digit, day);
    }
    await adapter.repoint({ root, sha: E });
    let calls = 0;
    const fence = async (): Promise<boolean> => {
      calls += 1;
      return calls === 1;
    };
    expect(await adapter.prune({ root, keep: 2, fence })).toEqual({ outcome: 'unreadable', removed: [A] });
    expect(calls).toBe(2);
    expect((await fs.readdir(root)).sort()).toEqual([B, C, D, E, 'current'].sort());
    expect(await adapter.prune({ root, keep: 2, fence: async () => true })).toEqual({ outcome: 'pruned', removed: [B, C] });
    expect((await fs.readdir(root)).sort()).toEqual([D, E, 'current'].sort());
  });

  it('awaits the prune fence after the current re-read, as the last step before each rename', async () => {
    for (const [digit, day] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) {
      await verified(digit, day);
    }
    await adapter.repoint({ root, sha: D });
    const seen: string[] = [];
    const realReadlink = fs.readlink;
    fs.readlink = (async (...args: Parameters<typeof fs.readlink>) => {
      seen.push('read current');
      return realReadlink(...args);
    }) as typeof fs.readlink;
    try {
      const result = await adapter.prune({
        root,
        keep: 2,
        fence: async () => {
          seen.push('fence');
          return true;
        },
      });
      expect(result).toEqual({ outcome: 'pruned', removed: [A, B] });
    } finally {
      fs.readlink = realReadlink;
    }
    const removals = seen.slice(seen.indexOf('fence') - 1);
    expect(removals).toEqual(['read current', 'fence', 'read current', 'fence']);
  });

  it('removes only an orphan archive file and an orphan home', async () => {
    await verified('a', 1);
    const orphan = `.staging-${B}-${'0'.repeat(16)}`;
    await fs.writeFile(path.join(root, `${orphan}.tar`), 'tar');
    await fs.mkdir(path.join(root, `${orphan}.home`, '.yarn'), { recursive: true });
    await fs.mkdir(path.join(root, `.trash-${B}-${'1'.repeat(16)}`, 'apps'), { recursive: true });
    const live = await staged(C);
    await fs.writeFile(live.archivePath, 'tar');
    await fs.writeFile(path.join(root, 'notes.tar'), 'keep');
    expect(await adapter.prune({ root, keep: 2 })).toEqual({ outcome: 'pruned', removed: [] });
    expect((await fs.readdir(root)).sort()).toEqual(
      [A, path.basename(live.buildDir), path.basename(live.archivePath), path.basename(live.homeDir), 'notes.tar'].sort(),
    );
  });

  it('markVerified refuses a build without the CLI entry', async () => {
    const { buildId, buildDir } = await staged(A);
    expect(await adapter.markVerified({ root, sha: A, buildId, builtAtIso: at(1) })).toEqual({ outcome: 'not-verified' });
    await fs.mkdir(path.join(buildDir, 'apps', 'cli', 'dist', 'bin.js'), { recursive: true });
    expect(await adapter.markVerified({ root, sha: A, buildId, builtAtIso: at(1) })).toEqual({ outcome: 'not-verified' });
    expect(await adapter.list({ root })).toEqual({ outcome: 'read', current: null, builds: [] });
  });

  it('prepare creates a fresh, uniquely named staging directory each time', async () => {
    const first = await staged(A);
    const second = await staged(A);
    expect(first.buildId).not.toBe(second.buildId);
    expect(first.buildId.startsWith(`${A}-`)).toBe(true);
    expect((await fs.lstat(first.buildDir)).isDirectory()).toBe(true);
    expect(await fs.readdir(first.homeDir)).toEqual([]);
    expect(first.homeDir).not.toBe(second.homeDir);
    expect((await fs.lstat(second.buildDir)).isDirectory()).toBe(true);
    expect(await fs.readdir(second.buildDir)).toEqual([]);
    expect(await adapter.list({ root })).toEqual({ outcome: 'read', current: null, builds: [] });
  });

  it('prepare refuses and creates nothing when the root is missing', async () => {
    expect(await adapter.prepare({ root, sha: A })).toEqual({ outcome: 'unreadable' });
    // Neither the root nor any ancestor of it exists afterwards.
    expect(await lstatOrNullForTest(root)).toBeNull();
    expect(await lstatOrNullForTest(tempDir)).not.toBeNull();
  });

  it('prepare refuses when the root is a symlink to a real directory', async () => {
    const real = path.join(tempDir, 'real-releases');
    await fs.mkdir(real);
    await fs.symlink(real, root);
    expect(await adapter.prepare({ root, sha: A })).toEqual({ outcome: 'unreadable' });
    expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(real)).toEqual([]);
  });

  // CO14c fix round 4: after a swap the staging paths resolve into an
  // ATTACKER-CHOSEN directory, so cleanup must remove only names it can prove
  // are the very directories this call created (dev/ino match), and it must
  // report what it left. The swap target below is a DIFFERENT directory from
  // the moved-away root.
  interface SwapFixture {
    readonly moved: string;
    readonly target: string;
    readonly rmdirCalls: string[];
    /** A second mkdir that ran through the swapped-in target instead of failing. */
    throughTarget: boolean;
  }

  /**
   * The real filesystem, except the mkdir that creates the `.home` staging
   * directory is preceded by the swap: the root is renamed to `moved`, a
   * symlink replaces it at `root` pointing at `target`, and `plant` runs
   * inside `target` before that second mkdir. The first staging mkdir (and
   * the adapter's identity recording right after it) still happens on the
   * real root, so the recorded dev/ino belongs to the moved-away directory.
   */
  async function swappingAdapter(plant?: (target: string, stagingName: string) => Promise<void>): Promise<{
    adapter: ReleaseStoreAdapter;
    fixture: SwapFixture;
  }> {
    const moved = path.join(tempDir, 'moved');
    const target = path.join(tempDir, 'target');
    const fixture: SwapFixture = { moved, target, rmdirCalls: [], throughTarget: false };
    let swapped = false;
    const swapping: typeof fs = {
      ...fs,
      mkdir: async (pathOrDir, options) => {
        const dir = pathOrDir.toString();
        const base = path.basename(dir);
        if (!swapped && base.endsWith('.home') && base.startsWith(`.staging-${A}-`)) {
          swapped = true;
          const stagingName = base.slice(0, -'.home'.length);
          await fs.rename(root, moved);
          await fs.writeFile(path.join(moved, 'sentinel.txt'), 'untouched');
          await fs.symlink(target, root);
          if (plant !== undefined) {
            await plant(target, stagingName);
          }
        }
        await fs.mkdir(pathOrDir as never, options);
        if (swapped && base.endsWith('.home')) {
          // The second mkdir landed inside the swapped-in target.
          fixture.throughTarget = true;
        }
        return undefined;
      },
      rmdir: async (pathOrDir) => {
        fixture.rmdirCalls.push(pathOrDir.toString());
        return fs.rmdir(pathOrDir as never);
      },
    } as typeof fs;
    return { adapter: new ReleaseStoreAdapter(swapping), fixture };
  }

  /** The staging names left in the moved-away root (this call's real directories). */
  async function movedStagingNames(moved: string): Promise<string[]> {
    return (await fs.readdir(moved)).filter((n) => n.startsWith('.staging-'));
  }

  it('prepare re-verifies the root after the mkdirs, removes only its own verified staging dirs, and reports leftovers on a swap', async () => {
    // Nothing foreign exists in the swap target: leftovers must be empty.
    const { adapter: swapped, fixture } = await swappingAdapter();
    await fs.mkdir(fixture.target, { recursive: true });
    await fs.writeFile(path.join(fixture.target, 'sentinel.txt'), 'untouched');
    const before = (await fs.readdir(fixture.target)).slice().sort();
    await fs.mkdir(root, { recursive: true });
    const result = await swapped.prepare({ root, sha: A });
    if (result.outcome !== 'root-changed') {
      throw new Error(`expected root-changed, got ${result.outcome}`);
    }
    expect(result.leftovers).toEqual([]);
    // The cleanup loop is not vacuous: it attempted at least one rmdir.
    expect(fixture.rmdirCalls.length).toBeGreaterThanOrEqual(1);
    // Our empty staging directory stays behind in the moved-away root — the
    // ruling accepts that — and nothing of ours is reachable at the root
    // paths any more.
    for (const name of await movedStagingNames(fixture.moved)) {
      expect(await lstatOrNullForTest(path.join(fixture.moved, name))).toBe(true);
      expect(await lstatOrNullForTest(path.join(root, name))).toBeNull();
    }
    // The swap is in place and nothing else in the target was removed.
    expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(fixture.target, 'sentinel.txt'), 'utf8')).toBe('untouched');
    expect((await fs.readdir(fixture.target)).sort()).toEqual(before);
  });

  it('prepare never removes a non-empty planted .home in the swapped-in target and reports it as a leftover', async () => {
    const { adapter: swapped, fixture } = await swappingAdapter(async (target, stagingName) => {
      // A NON-EMPTY directory under our `.home` name, planted in the target.
      const planted = path.join(target, `${stagingName}.home`);
      await fs.mkdir(planted);
      await fs.writeFile(path.join(planted, 'planted.txt'), 'not ours');
    });
    await fs.mkdir(fixture.target, { recursive: true });
    await fs.writeFile(path.join(fixture.target, 'sentinel.txt'), 'untouched');
    const before = (await fs.readdir(fixture.target)).slice().sort();
    await fs.mkdir(root, { recursive: true });
    const result = await swapped.prepare({ root, sha: A });
    if (result.outcome !== 'root-changed') {
      throw new Error(`expected root-changed, got ${result.outcome}`);
    }
    const stagingNames = await movedStagingNames(fixture.moved);
    expect(stagingNames.length).toBeGreaterThanOrEqual(1);
    const plantedPath = path.join(root, `${stagingNames[0]}.home`);
    expect(result.leftovers).toEqual([plantedPath]);
    // The planted directory and its content survive untouched.
    expect(await fs.readFile(path.join(plantedPath, 'planted.txt'), 'utf8')).toBe('not ours');
    expect(await fs.readFile(path.join(fixture.target, 'sentinel.txt'), 'utf8')).toBe('untouched');
    // Nothing in the target was removed; the only new entry is the planted
    // directory this call refused to touch.
    const after = (await fs.readdir(fixture.target)).sort();
    for (const entry of before) {
      expect(after).toContain(entry);
    }
    expect(fixture.throughTarget).toBe(false);
  });

  it('prepare leaves an empty planted staging dir in the swapped-in target and reports it as a leftover', async () => {
    const { adapter: swapped, fixture } = await swappingAdapter(async (target, stagingName) => {
      // An EMPTY directory under exactly the name this call used, planted in the target.
      await fs.mkdir(path.join(target, stagingName));
    });
    await fs.mkdir(fixture.target, { recursive: true });
    await fs.mkdir(root, { recursive: true });
    const result = await swapped.prepare({ root, sha: A });
    if (result.outcome !== 'root-changed') {
      throw new Error(`expected root-changed, got ${result.outcome}`);
    }
    const stagingNames = await movedStagingNames(fixture.moved);
    expect(stagingNames.length).toBeGreaterThanOrEqual(1);
    const plantedPath = path.join(root, stagingNames[0]);
    // The planted name fails the dev/ino match, so it is left and reported.
    expect(result.leftovers).toEqual([plantedPath]);
    expect(await lstatOrNullForTest(plantedPath)).toBe(true);
    // Our own empty `.home` (created through the target symlink) is still ours and removed.
    expect(await lstatOrNullForTest(path.join(root, `${stagingNames[0]}.home`))).toBeNull();
    expect((await fs.readdir(fixture.target)).sort()).toEqual([stagingNames[0]]);
  });

  it('prepare refuses when the root is a file rather than a directory', async () => {
    await fs.writeFile(root, 'not a directory');
    expect(await adapter.prepare({ root, sha: A })).toEqual({ outcome: 'unreadable' });
    expect((await fs.lstat(root)).isFile()).toBe(true);
  });

  it('prepare refuses when a stale unverified tree already sits at the sha', async () => {
    await fs.mkdir(path.join(root, A), { recursive: true });
    await fs.writeFile(path.join(root, A, 'partial.txt'), 'stale');
    expect(await adapter.prepare({ root, sha: A })).toEqual({ outcome: 'unreadable' });
    expect(await fs.readdir(path.join(root, A))).toEqual(['partial.txt']);
  });

  it('markVerified verifies only a staging directory this store created for that sha', async () => {
    const { buildId, buildDir } = await staged(A);
    await fs.mkdir(path.join(buildDir, 'apps', 'cli', 'dist'), { recursive: true });
    await fs.writeFile(path.join(buildDir, 'apps', 'cli', 'dist', 'bin.js'), '// cli\n');
    expect(await adapter.markVerified({ root, sha: A, buildId: `${A}-${'f'.repeat(16)}`, builtAtIso: at(1) })).toEqual({
      outcome: 'not-found',
    });
    expect(await adapter.markVerified({ root, sha: B, buildId, builtAtIso: at(1) })).toEqual({ outcome: 'unreadable' });
    expect(await adapter.markVerified({ root, sha: A, buildId: '../x', builtAtIso: at(1) })).toEqual({ outcome: 'unreadable' });
    // A tree that appeared at the sha meanwhile is never overwritten.
    await fs.mkdir(path.join(root, A));
    await fs.writeFile(path.join(root, A, 'other.txt'), 'other');
    expect(await adapter.markVerified({ root, sha: A, buildId, builtAtIso: at(1) })).toEqual({ outcome: 'unreadable' });
    expect(await fs.readdir(path.join(root, A))).toEqual(['other.txt']);
    await fs.rm(path.join(root, A), { recursive: true });
    expect(await adapter.markVerified({ root, sha: A, buildId, builtAtIso: at(1) })).toEqual({ outcome: 'ok' });
    expect(await adapter.list({ root })).toEqual({ outcome: 'read', current: null, builds: [{ sha: A, builtAtIso: at(1) }] });
    await expect(fs.lstat(buildDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('discards an incomplete staging dir and its archive', async () => {
    const { buildId, buildDir, archivePath, homeDir } = await staged(A);
    await fs.writeFile(path.join(buildDir, 'partial.txt'), 'stale');
    await fs.writeFile(path.join(homeDir, '.npmrc'), 'cache');
    await fs.writeFile(archivePath, 'tar');
    expect(await adapter.discard({ root, buildId })).toEqual({ outcome: 'ok' });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await adapter.discard({ root, buildId })).toEqual({ outcome: 'ok' });
    expect(await adapter.discard({ root, buildId: 'nothex' })).toEqual({ outcome: 'unreadable' });
    expect(await adapter.discard({ root, buildId: `${A}/../../x` })).toEqual({ outcome: 'unreadable' });
  });
});
