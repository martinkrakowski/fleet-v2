/**
 * CO14 round 5: the release operation record. One durable intent per
 * (action, sha) carries a unique operation id; only an intent without a
 * recorded result resumes, only a live claim makes a second run busy, and a
 * completed operation is never resumed. The driver binding of a root.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseStoreAdapter } from '../ReleaseStoreAdapter.adapter.js';

const SHA = 'a'.repeat(40);
const T0 = '2026-11-10T10:00:00.000Z';
const T_FRESH = '2026-11-10T10:30:00.000Z';
const T_STALE = '2026-11-10T13:00:00.000Z';

let root = '';
let store: ReleaseStoreAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'co14b-ops-'));
  store = new ReleaseStoreAdapter();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Proposes the open intent's id when there is one, as the use case does, else a fresh id. */
const begin = async (nowIso = T0, action: 'install' | 'swap' | 'rollback' = 'swap') => {
  const open = await store.peekOperation({ root, action, sha: SHA });
  const opId = open.outcome === 'open' ? open.opId : store.newOperationId();
  return store.beginOperation({ root, action, sha: SHA, opId, nowIso });
};

describe('release operation record', () => {
  it('starts with a unique id that is not derivable from action and sha', async () => {
    const first = await begin();
    expect(first).toMatchObject({ outcome: 'started' });
    const other = await store.beginOperation({
      root,
      action: 'swap',
      sha: 'b'.repeat(40),
      opId: store.newOperationId(),
      nowIso: T0,
    });
    expect(first.outcome === 'started' && other.outcome === 'started' && first.opId !== other.opId).toBe(true);
    if (first.outcome === 'started') {
      expect(first.opId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('a live claim makes a second run busy; a released intent resumes under its own id; complete ends it', async () => {
    const first = await begin();
    expect(await begin(T_FRESH)).toEqual({ outcome: 'busy' });
    if (first.outcome !== 'started') throw new Error('expected started');
    const ref = { root, action: 'swap' as const, sha: SHA, opId: first.opId };
    expect(await store.releaseOperation(ref)).toEqual({ outcome: 'ok' });
    expect(await begin(T_FRESH)).toEqual({ outcome: 'resumed', opId: first.opId });
    expect(await store.completeOperation(ref)).toEqual({ outcome: 'ok' });
    // Completed: the next operation is new, with a different id, and nothing resumes the old one.
    const next = await begin(T_FRESH);
    expect(next.outcome).toBe('started');
    expect(next.outcome === 'started' && next.opId !== first.opId).toBe(true);
    expect((await readdir(join(root, '.release-ops'))).some((name) => name.endsWith(`${first.opId}.done`))).toBe(true);
  });

  it('a crashed run\'s stale claim is taken over and resumes the same id', async () => {
    const first = await begin();
    if (first.outcome !== 'started') throw new Error('expected started');
    expect(await begin(T_STALE)).toEqual({ outcome: 'resumed', opId: first.opId });
  });

  it('a proposed id that differs from the recorded intent is busy, and peek writes nothing', async () => {
    expect(await store.peekOperation({ root, action: 'swap', sha: SHA })).toEqual({ outcome: 'none' });
    expect(await readdir(root)).toEqual([]);
    const first = await begin();
    if (first.outcome !== 'started') throw new Error('expected started');
    await store.releaseOperation({ root, action: 'swap', sha: SHA, opId: first.opId });
    expect(
      await store.beginOperation({ root, action: 'swap', sha: SHA, opId: store.newOperationId(), nowIso: T_FRESH }),
    ).toEqual({ outcome: 'busy' });
    expect(await store.peekOperation({ root, action: 'swap', sha: SHA })).toEqual({ outcome: 'open', opId: first.opId });
  });

  it('cancel drops an operation that consumed nothing; a foreign id cannot end an intent', async () => {
    const first = await begin();
    if (first.outcome !== 'started') throw new Error('expected started');
    const foreign = { root, action: 'swap' as const, sha: SHA, opId: 'f'.repeat(32) };
    expect(await store.completeOperation(foreign)).toEqual({ outcome: 'unreadable' });
    expect(await store.cancelOperation({ ...foreign, opId: first.opId })).toEqual({ outcome: 'ok' });
    expect((await begin(T_FRESH)).outcome).toBe('started');
  });

  it(
    'CO14b fix round 5: a completed opId can never be reused for a fresh operation, ' +
      'but a genuinely new opId still starts normally',
    async () => {
      const staleOpId = store.newOperationId();
      const first = await store.beginOperation({ root, action: 'swap', sha: SHA, opId: staleOpId, nowIso: T0 });
      expect(first).toEqual({ outcome: 'started', opId: staleOpId });
      // Completing renames the intent to `<base>.<opId>.done`: the intent file
      // itself is now gone, so a naive exclusive-create under this same
      // opId would otherwise succeed FRESH, as if it were a brand-new start.
      expect(
        await store.completeOperation({ root, action: 'swap', sha: SHA, opId: staleOpId }),
      ).toEqual({ outcome: 'ok' });
      // Reusing the now-completed opId is refused, not a fresh 'started'.
      expect(
        await store.beginOperation({ root, action: 'swap', sha: SHA, opId: staleOpId, nowIso: T_FRESH }),
      ).toEqual({ outcome: 'busy' });
      // The refused attempt wrote no fresh intent of its own.
      expect(await store.peekOperation({ root, action: 'swap', sha: SHA })).toEqual({ outcome: 'none' });
      // A genuinely new opId for the same action and sha, with no `.done`
      // marker of its own, still starts normally.
      const freshOpId = store.newOperationId();
      expect(
        await store.beginOperation({ root, action: 'swap', sha: SHA, opId: freshOpId, nowIso: T_FRESH }),
      ).toEqual({ outcome: 'started', opId: freshOpId });
    },
  );

  it(
    'CO14b fix round 6: a stale completed opId is refused on the resumed-claim path too, ' +
      'and its claim is not left orphaned',
    async () => {
      const opId = store.newOperationId();
      const first = await store.beginOperation({ root, action: 'swap', sha: SHA, opId, nowIso: T0 });
      expect(first).toEqual({ outcome: 'started', opId });

      // Reproduce Luna's round-6 race as a deterministic sequence of awaited
      // calls, not real concurrency: intercept the one `readFile` of the
      // intent file that the EEXIST/"resumed" branch below makes to learn the
      // existing opId (it still names this same opId at that instant, so that
      // branch is taken), and run the first operation's `completeOperation`
      // immediately after that read resolves -- the exact window, in the real
      // race, between a second caller's existing-opId read and its own
      // `takeClaim`: the intent gets renamed to its `.done` marker and the
      // first call's claim gets released before this call's `takeClaim` runs.
      const realReadFile = fs.readFile;
      let intercepted = false;
      let completeResult: Awaited<ReturnType<typeof store.completeOperation>> | undefined;
      const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(
        (async (filePath: Parameters<typeof fs.readFile>[0], encoding: Parameters<typeof fs.readFile>[1]) => {
          const result = await realReadFile(filePath, encoding);
          if (!intercepted && typeof filePath === 'string' && filePath.endsWith('.intent')) {
            intercepted = true;
            completeResult = await store.completeOperation({ root, action: 'swap', sha: SHA, opId });
          }
          return result;
        }) as unknown as typeof fs.readFile,
      );

      let second: Awaited<ReturnType<typeof store.beginOperation>>;
      try {
        second = await store.beginOperation({ root, action: 'swap', sha: SHA, opId, nowIso: T_FRESH });
      } finally {
        readFileSpy.mockRestore();
      }

      expect(intercepted).toBe(true);
      expect(completeResult).toEqual({ outcome: 'ok' });
      // Without the round-6 check this would be 'resumed': the intent read
      // above still named this opId, so the EEXIST branch takes the
      // started-false path, and `takeClaim` succeeds cleanly because the
      // first call's own claim was just released by the race above. The
      // round-6 check catches the now-completed opId and refuses it instead.
      expect(second).toEqual({ outcome: 'busy' });

      // The claim this call took before being refused was released, not left
      // orphaned: a fresh opId for the same action and sha can still take the
      // claim cleanly right away.
      const freshOpId = store.newOperationId();
      expect(
        await store.beginOperation({ root, action: 'swap', sha: SHA, opId: freshOpId, nowIso: T_FRESH }),
      ).toEqual({ outcome: 'started', opId: freshOpId });
    },
  );

  it('binds a root to its driver state directory; the first binding wins', async () => {
    expect(await store.readDriverBinding({ root })).toEqual({ outcome: 'unbound' });
    expect(await store.bindDriver({ root, stateDir: '/srv/a' })).toEqual({ outcome: 'bound', stateDir: '/srv/a' });
    expect(await store.bindDriver({ root, stateDir: '/srv/b' })).toEqual({ outcome: 'bound', stateDir: '/srv/a' });
    expect(await store.readDriverBinding({ root })).toEqual({ outcome: 'bound', stateDir: '/srv/a' });
    expect(await store.bindDriver({ root, stateDir: 'relative' })).toEqual({ outcome: 'unreadable' });
  });
});
