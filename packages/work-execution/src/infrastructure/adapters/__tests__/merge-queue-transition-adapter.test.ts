// DT9c: the queue store's compare-and-set transition, in memory and on disk.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MergeQueueRepositoryAdapter } from '../MergeQueueRepositoryAdapter.adapter.js';
import { buildParkedEntry, buildSupersession } from '../../../domain/merge-pass-transitions.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_2 = '0123456789abcdef0123456789abcdef01234599';
const A = '01JE00000000000000000000A1';
const B = '01JE00000000000000000000B1';
const SUCCESSOR = '01JE00000000000000000000C1';
const deadline = () => new Date(Date.now() + 60_000).toISOString();

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seeded(stateDir?: string) {
  const adapter = new MergeQueueRepositoryAdapter(stateDir === undefined ? {} : { stateDir });
  await adapter.enqueueMergeEntry({
    repository: { owner: 'fleet', repo: 'v2' }, pullRequest: 1, headOid: HEAD, tier: 2, enqueuedBy: 'cli',
    runId: null, entryId: A, successorEntryId: B, enqueuedAtIso: '2026-11-01T10:00:00.000Z', deadlineIso: deadline(),
  });
  const [entry] = await adapter.listMergeEntries({ deadlineIso: deadline() });
  return { adapter, entry };
}

describe('MergeQueueRepositoryAdapter.applyMergeTransition', () => {
  it('applies on the stored revision, once, and refuses the stale replay', async () => {
    const { adapter, entry } = await seeded();
    const built = buildParkedEntry(entry, { reason: 'checks', nextAttempt: 1, notBeforeIso: null });
    if (!built.ok) throw new Error('fixture');
    const command = { entryId: A, expectedRevision: 1, next: built.record, successor: null, deadlineIso: deadline() };

    expect((await adapter.applyMergeTransition(command)).outcome).toBe('applied');
    expect(await adapter.applyMergeTransition(command)).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    expect((await adapter.listMergeEntries({ deadlineIso: deadline() }))[0]).toMatchObject({ state: 'parked', revision: 2 });
  });

  it('persists a supersession and its successor atomically on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt9c-'));
    dirs.push(dir);
    const { adapter, entry } = await seeded(dir);
    const built = buildSupersession(entry, HEAD_2, SUCCESSOR);
    if (!built.ok) throw new Error('fixture');

    const decision = await adapter.applyMergeTransition({
      entryId: A, expectedRevision: 1, next: built.predecessor, successor: built.successor, deadlineIso: deadline(),
    });

    expect(decision.outcome).toBe('applied');
    const stored = JSON.parse(await readFile(join(dir, 'merge-queue.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(stored.map((record) => [record.entryId, record.state])).toEqual([[A, 'superseded'], [SUCCESSOR, 'awaiting-checks']]);
  });

  it('refuses an expired deadline and writes nothing', async () => {
    const { adapter, entry } = await seeded();
    const built = buildParkedEntry(entry, { reason: 'checks', nextAttempt: 1, notBeforeIso: null });
    if (!built.ok) throw new Error('fixture');
    const result = await adapter.applyMergeTransition({
      entryId: A, expectedRevision: 1, next: built.record, successor: null, deadlineIso: '2020-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
    expect((await adapter.listMergeEntries({ deadlineIso: deadline() }))[0].revision).toBe(1);
  });
});
