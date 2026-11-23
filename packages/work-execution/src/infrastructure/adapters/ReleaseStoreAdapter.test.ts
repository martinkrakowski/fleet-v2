import { promises as fs, type RmOptions } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReleaseStoreAdapter, type ReleaseStoreFs } from './ReleaseStoreAdapter.adapter.js';

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

  async function staged(
    id: string,
  ): Promise<{ buildId: string; buildDir: string; archivePath: string; homeDir: string }> {
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
    expect((await fs.readdir(root)).sort()).toEqual(['.release-ops', A, B, 'current']);
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
    expect((await fs.readdir(root)).sort()).toEqual(['.release-ops', A, B, 'current']);
    // Fix round 1: a refused or throwing fence must not leave the marker
    // claiming the failed repoint; the marker still names the operation that
    // last actually wrote `current` (the repoint to A above).
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId: null });
    await adapter.repoint({ root, sha: A, opId: 'a'.repeat(32) });
    expect(
      await adapter.repoint({
        root,
        sha: B,
        fence: async () => {
          throw new Error('lease unreadable');
        },
      }),
    ).toEqual({ outcome: 'fenced' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId: 'a'.repeat(32) });
    expect(await adapter.repoint({ root, sha: B, fence: async () => true })).toEqual({ outcome: 'ok' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: B, opId: null });
  });

  it('reports a typed restore-failed, and no current-op marker claiming the new operation, when the rename fails and restoring the previous marker fails too', async () => {
    await verified('a', 1);
    await verified('b', 2);
    // A prior marker naming an earlier operation is present before the failing repoint.
    expect(await adapter.repoint({ root, sha: A, opId: 'a'.repeat(32) })).toEqual({ outcome: 'ok' });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId: 'a'.repeat(32) });
    const markerPath = path.join(root, '.release-ops', 'current-op.json');
    const sabotage = async () => {
      // The rename cannot land: `current` becomes a non-empty directory.
      await fs.unlink(path.join(root, 'current'));
      await fs.mkdir(path.join(root, 'current'));
      await fs.mkdir(path.join(root, 'current', 'kept'));
      // The restore write cannot land either: the marker path is a directory,
      // so writing the previous marker over it fails (EISDIR on the atomic
      // write's rename step).
      await fs.rm(markerPath);
      await fs.mkdir(markerPath);
      return true;
    };
    // The new marker was already written when the rename failed; the restore
    // of the previous marker then fails too. The result must be the distinct
    // typed failure, never success, and the marker must not claim the new
    // operation afterwards.
    expect(await adapter.repoint({ root, sha: B, opId: 'b'.repeat(32), fence: sabotage })).toEqual({
      outcome: 'restore-failed',
    });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'none' });
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
    expect((await fs.readdir(root)).sort()).toEqual(['.release-ops', A, B, 'current', D, E, sha('f')]);
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
    expect((await fs.readdir(root)).sort()).toEqual(['.release-ops', B, C, D, E, 'current'].sort());
    expect(await adapter.prune({ root, keep: 2, fence: async () => true })).toEqual({ outcome: 'pruned', removed: [B, C] });
    expect((await fs.readdir(root)).sort()).toEqual(['.release-ops', D, E, 'current'].sort());
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

  it('markRepointed flips repointed only for the exact opId that owns the intent (CO14b round 10)', async () => {
    const opId = 'a'.repeat(32);
    const begun = await adapter.beginOperation({ root, action: 'rollback', sha: B, opId, nowIso: at(1) });
    expect(begun).toEqual({ outcome: 'started', opId });
    expect(await adapter.peekAnyOpenOperation({ root, action: 'rollback' })).toEqual({
      outcome: 'open',
      opId,
      sha: B,
      repointed: false,
    });

    // A missing intent is `not-found`, never a write.
    expect(await adapter.markRepointed({ root, action: 'rollback', sha: C, opId })).toEqual({ outcome: 'not-found' });
    // A mismatched opId never rewrites someone else's intent.
    const otherOpId = 'b'.repeat(32);
    expect(await adapter.markRepointed({ root, action: 'rollback', sha: B, opId: otherOpId })).toEqual({
      outcome: 'unreadable',
    });
    expect(await adapter.peekAnyOpenOperation({ root, action: 'rollback' })).toEqual({
      outcome: 'open',
      opId,
      sha: B,
      repointed: false,
    });

    expect(await adapter.markRepointed({ root, action: 'rollback', sha: B, opId })).toEqual({ outcome: 'ok' });
    expect(await adapter.peekAnyOpenOperation({ root, action: 'rollback' })).toEqual({
      outcome: 'open',
      opId,
      sha: B,
      repointed: true,
    });

    // A genuine resume (same opId, EEXIST branch) never loses the flag or
    // the intent's own recorded createdAtIso.
    const resumed = await adapter.beginOperation({ root, action: 'rollback', sha: B, opId, nowIso: at(2) });
    expect(resumed).toEqual({ outcome: 'resumed', opId });
    expect(await adapter.peekAnyOpenOperation({ root, action: 'rollback' })).toEqual({
      outcome: 'open',
      opId,
      sha: B,
      repointed: true,
    });

    expect(await adapter.completeOperation({ root, action: 'rollback', sha: B, opId })).toEqual({ outcome: 'ok' });
    expect(await adapter.peekAnyOpenOperation({ root, action: 'rollback' })).toEqual({ outcome: 'none' });
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

  it('repoint records the operation that last wrote current and readLastCurrentOp reads it back (CO14b #4c)', async () => {
    await verified('a', 1);
    await verified('b', 2);
    const opId = '1'.repeat(32);
    expect(await adapter.repoint({ root, sha: A, opId })).toEqual({ outcome: 'ok' });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId });
    expect(await adapter.repoint({ root, sha: B })).toEqual({ outcome: 'ok' });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: B, opId: null });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: B, opId: null });
  });

  it('repoint refuses an invalid opId without moving current', async () => {
    await verified('a', 1);
    for (const badOpId of ['not-hex', 'a'.repeat(31), 'a'.repeat(33), 42, null, { opId: 'a'.repeat(32) }]) {
      expect(await adapter.repoint({ root, sha: A, opId: badOpId as unknown as string })).toEqual({
        outcome: 'unreadable',
      });
    }
    await expect(fs.lstat(path.join(root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'none' });
    expect(await adapter.repoint({ root, sha: A, opId: 'a'.repeat(32) })).toEqual({ outcome: 'ok' });
  });

  it('repoint refuses without renaming when writing current-op.json fails', async () => {
    await verified('a', 1);
    await verified('b', 2);
    expect(await adapter.repoint({ root, sha: A, opId: 'a'.repeat(32) })).toEqual({ outcome: 'ok' });
    // A file where the marker's directory must be blocks both the mkdir and
    // the marker write: the repoint is refused and `current` stays at A.
    await fs.rm(path.join(root, '.release-ops'), { recursive: true });
    await fs.writeFile(path.join(root, '.release-ops'), 'not a directory');
    expect(await adapter.repoint({ root, sha: B, opId: 'b'.repeat(32) })).toEqual({ outcome: 'unreadable' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
    expect((await fs.readdir(root)).filter((name) => name.startsWith('.current.'))).toEqual([]);
    expect((await fs.readdir(path.join(root, B))).includes('.fleet-release-verified')).toBe(true);
    expect((await fs.readdir(path.join(root, A))).includes('.fleet-release-verified')).toBe(true);
  });

  it('repoint restores the previous current-op.json marker when the rename fails', async () => {
    const blockingFence = async () => {
      // Replace `current` with a non-empty directory so the pre-rename
      // `list`/`lstatOrNull` checks pass but `fs.rename` fails.
      await fs.rm(path.join(targetRoot, 'current'), { force: true });
      await fs.mkdir(path.join(targetRoot, 'current', 'nested'), { recursive: true });
      return true;
    };
    // Case 1: a previous marker exists and must be restored.
    let targetRoot = root;
    await verified('a', 1);
    await verified('b', 2);
    expect(await adapter.repoint({ root, sha: A, opId: 'a'.repeat(32) })).toEqual({ outcome: 'ok' });
    expect(await adapter.repoint({ root, sha: B, opId: 'b'.repeat(32), fence: blockingFence })).toEqual({
      outcome: 'unreadable',
    });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({
      outcome: 'read',
      sha: A,
      opId: 'a'.repeat(32),
    });
    // Case 2: no previous marker exists, so the new marker must be removed.
    const root2 = path.join(tempDir, 'releases-2');
    targetRoot = root2;
    const prepared2 = await adapter.prepare({ root: root2, sha: A });
    if (prepared2.outcome !== 'prepared') {
      throw new Error('prepare refused for root2');
    }
    const entry2 = path.join(prepared2.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry2, { recursive: true });
    await fs.writeFile(path.join(entry2, 'bin.js'), '// cli\n');
    expect(
      await adapter.markVerified({ root: root2, sha: A, buildId: prepared2.buildId, builtAtIso: at(1) }),
    ).toEqual({ outcome: 'ok' });
    expect(
      await adapter.repoint({ root: root2, sha: A, opId: 'a'.repeat(32), fence: blockingFence }),
    ).toEqual({ outcome: 'unreadable' });
    expect(await adapter.readLastCurrentOp({ root: root2 })).toEqual({ outcome: 'none' });
    expect(
      await adapter.repoint({ root: root2, sha: A, opId: 'a'.repeat(32), fence: blockingFence }),
    ).toEqual({ outcome: 'unreadable' });
    expect(await adapter.readLastCurrentOp({ root: root2 })).toEqual({ outcome: 'none' });
  });

  it('repoint returns restore-failed when fence rejects with no previous marker and removing the new marker fails', async () => {
    await verified('a', 1);
    const markerPath = path.join(root, '.release-ops', 'current-op.json');
    // Only the marker removal fails; every other fs call delegates to the real
    // node:fs/promises (the temp-link cleanup must still work).
    const removingMarkerFails: Partial<ReleaseStoreFs> = {
      rm: async (target: Parameters<typeof fs.rm>[0], options?: RmOptions): Promise<void> => {
        if (target === markerPath) {
          throw new Error('forced rm failure');
        }
        return fs.rm(target, options);
      },
    };
    const fenced = new ReleaseStoreAdapter(removingMarkerFails);
    // No previous marker: this is the first repoint, the fence refuses, and the
    // marker written before the fence must be removed. A failed removal means
    // the store may claim an operation that never landed.
    expect(await fenced.repoint({ root, sha: A, fence: async () => false })).toEqual({
      outcome: 'restore-failed',
    });
    // The fence refused before the rename, so `current` was never repointed.
    expect(await fs.lstat(path.join(root, 'current')).then(() => true, () => false)).toBe(false);
  });

  it('repoint returns restore-failed when rename fails with no previous marker and removing the new marker fails', async () => {
    await verified('a', 1);
    const markerPath = path.join(root, '.release-ops', 'current-op.json');
    const removingMarkerFails: Partial<ReleaseStoreFs> = {
      rm: async (target: Parameters<typeof fs.rm>[0], options?: RmOptions): Promise<void> => {
        if (target === markerPath) {
          throw new Error('forced rm failure');
        }
        return fs.rm(target, options);
      },
    };
    const broken = new ReleaseStoreAdapter(removingMarkerFails);
    const renameFails = async (): Promise<boolean> => {
      // The rename cannot land: `current` becomes a non-empty directory.
      await fs.mkdir(path.join(root, 'current', 'kept'), { recursive: true });
      return true;
    };
    expect(await broken.repoint({ root, sha: A, fence: renameFails })).toEqual({
      outcome: 'restore-failed',
    });
    // The failed removal cannot guarantee the marker's absence (the documented
    // residual): the stale marker still names the sha it was written for, but
    // the typed failure is what the caller refuses on.
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId: null });
  });

  it('repoint returns restore-failed on triple failure when rename, marker restore, and marker removal all fail', async () => {
    await verified('a', 1);
    await verified('b', 2);
    expect(await adapter.repoint({ root, sha: A, opId: 'a'.repeat(32) })).toEqual({ outcome: 'ok' });
    const markerPath = path.join(root, '.release-ops', 'current-op.json');
    let currentOpRenames = 0;
    const failing: Partial<ReleaseStoreFs> = {
      rename: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]): Promise<void> => {
        // The first rename onto the marker (the new marker's atomic write)
        // must succeed; only the SECOND one -- the restore of the previous
        // marker after the failed rename onto `current` -- fails.
        if (to === markerPath) {
          currentOpRenames += 1;
          if (currentOpRenames === 2) {
            throw new Error('forced restore rename failure');
          }
        }
        return fs.rename(from, to);
      },
      rm: async (target: Parameters<typeof fs.rm>[0], options?: RmOptions): Promise<void> => {
        if (target === markerPath) {
          throw new Error('forced rm failure');
        }
        return fs.rm(target, options);
      },
    };
    const broken = new ReleaseStoreAdapter(failing);
    const renameFails = async (): Promise<boolean> => {
      // The rename cannot land: `current` becomes a non-empty directory.
      await fs.rm(path.join(root, 'current'), { force: true });
      await fs.mkdir(path.join(root, 'current', 'kept'), { recursive: true });
      return true;
    };
    expect(await broken.repoint({ root, sha: B, opId: 'b'.repeat(32), fence: renameFails })).toEqual({
      outcome: 'restore-failed',
    });
  });

  it('repoint returns unreadable when readlink on current fails before any write', async () => {
    await verified('a', 1);
    expect(await adapter.repoint({ root, sha: A })).toEqual({ outcome: 'ok' });
    const readlinkFails: Partial<ReleaseStoreFs> = {
      readlink: async () => {
        throw new Error('forced readlink failure');
      },
    };
    const broken = new ReleaseStoreAdapter(readlinkFails);
    // The read failure happens in the pre-write `list`, before the temp link
    // or the marker is written, so `unreadable` is the intended reading of
    // scope here.
    expect(await broken.repoint({ root, sha: B })).toEqual({ outcome: 'unreadable' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
  });

  it('readLastCurrentOp returns none when no marker exists', async () => {
    await verified('a', 1);
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'none' });
    expect(await adapter.readLastCurrentOp({ root: path.join(tempDir, 'absent') })).toEqual({ outcome: 'none' });
  });

  it('readLastCurrentOp returns unreadable for a malformed or unknown-version marker', async () => {
    await verified('a', 1);
    const marker = path.join(root, '.release-ops', 'current-op.json');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    for (const content of [
      '{not json',
      'null',
      '"text"',
      '[1,2]',
      JSON.stringify({ version: 2, sha: A, opId: null }),
      JSON.stringify({ version: 1, sha: 'nothex', opId: null }),
      JSON.stringify({ version: 1, sha: A, opId: 'nothex' }),
      JSON.stringify({ version: 1, sha: A, opId: 'a'.repeat(31) }),
      JSON.stringify({ version: 1, sha: A, opId: null, extra: true }),
      JSON.stringify({ version: 1, sha: A }),
      JSON.stringify({ version: 1, sha: A, opId: null, get extra() { return 1; } }),
    ]) {
      await fs.writeFile(marker, content);
      expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'unreadable' });
    }
    await fs.writeFile(marker, JSON.stringify({ version: 1, sha: A, opId: 'a'.repeat(32) }));
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId: 'a'.repeat(32) });
    await fs.rm(path.dirname(marker), { recursive: true });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'none' });
  });

  it('readLastCurrentOp never throws on hostile input, and no getter ever runs', async () => {
    expect(await adapter.readLastCurrentOp(null)).toEqual({ outcome: 'unreadable' });
    expect(await adapter.readLastCurrentOp(undefined)).toEqual({ outcome: 'unreadable' });
    expect(await adapter.readLastCurrentOp(42)).toEqual({ outcome: 'unreadable' });
    expect(await adapter.readLastCurrentOp('root')).toEqual({ outcome: 'unreadable' });
    expect(await adapter.readLastCurrentOp(['x'])).toEqual({ outcome: 'unreadable' });
    let getterRuns = 0;
    const hostile = {
      get root(): string {
        getterRuns += 1;
        return '/srv/whatever';
      },
    };
    expect(await adapter.readLastCurrentOp(hostile)).toEqual({ outcome: 'unreadable' });
    expect(getterRuns).toBe(0);
    const valid = { root };
    let getTraps = 0;
    const proxied = new Proxy(valid, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    await verified('a', 1);
    expect(await adapter.readLastCurrentOp(proxied)).toEqual({ outcome: 'none' });
    expect(getTraps).toBe(0);
    // An unreadable root (a file where the directory must be) is unreadable, never none.
    await fs.writeFile(path.join(root, '.release-ops'), 'not a directory');
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'unreadable' });
  });

  it('a constant verdict or an identity echo would fail these readLastCurrentOp tests', async () => {
    await verified('a', 1);
    // A constant `none` would miss the real marker; a constant `read` would
    // miss the absent one; an echo of the input could never produce these.
    await fs.mkdir(path.join(root, '.release-ops'), { recursive: true });
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'none' });
    await fs.writeFile(
      path.join(root, '.release-ops', 'current-op.json'),
      JSON.stringify({ version: 1, sha: A, opId: 'a'.repeat(32) }),
    );
    expect(await adapter.readLastCurrentOp({ root })).toEqual({ outcome: 'read', sha: A, opId: 'a'.repeat(32) });
    expect(await adapter.readLastCurrentOp({ root })).not.toEqual({ outcome: 'read', sha: A, opId: 'a'.repeat(31) });
  });
});
