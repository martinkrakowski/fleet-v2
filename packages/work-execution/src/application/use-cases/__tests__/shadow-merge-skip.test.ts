// S1U6: the shared shadow-skip helper used by the merge pass and the shadow
// merge decision. It filters journaled would-already-merged heads and fails
// open on every unreadable journal answer.
import { describe, expect, it } from 'vitest';

import {
  readJournaledWouldAlreadyMerged,
  withoutJournaledAlreadyMerged,
} from '../shadow-merge-skip.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';

const DIGEST = '0123456789ab';
const HEAD_A = 'aaaaaaaaaaaa' + '0'.repeat(28);
const HEAD_B = 'bbbbbbbbbbbb' + '0'.repeat(28);
const A12 = 'aaaaaaaaaaaa';
const B12 = 'bbbbbbbbbbbb';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';

function entry(pullRequest: number, headOid: string, id: string): MergeQueueEntryRecord {
  return { entryId: id, repoDigest: DIGEST, pullRequest, headOid, state: 'queued' } as unknown as MergeQueueEntryRecord;
}

function key(pr: number, head12: string, action: string, digest = DIGEST): string {
  return `merge/${digest}/${pr}/${head12}/${action}`;
}

function dryRun(k: string, reasonCode: string, outcome = 'dry-run'): Record<string, unknown> {
  return { kind: 'result', outcome, reasonCode, key: k };
}

function journalOf(list: () => unknown): { calls: number; journal: { listForKeyPrefix: () => Promise<never> } } {
  const state = { calls: 0, journal: { listForKeyPrefix: async () => { state.calls += 1; return list() as never; } } };
  return state;
}

async function read(
  list: () => unknown,
  overrides: { shadow?: boolean; deadlineIso?: string } = {},
) {
  const j = journalOf(list);
  const index = await readJournaledWouldAlreadyMerged({
    journal: j.journal,
    repoDigest: DIGEST,
    shadow: overrides.shadow ?? true,
    nowIso: NOW,
    deadlineIso: overrides.deadlineIso ?? DEADLINE,
  });
  return { index, calls: j.calls };
}

const ordered = [entry(1, HEAD_A, 'e1'), entry(1, HEAD_B, 'e2'), entry(2, HEAD_A, 'e3')];

async function filtered(records: unknown): Promise<readonly string[]> {
  const { index } = await read(() => records);
  if (index.outcome !== 'indexed') throw new Error('expected an index');
  return withoutJournaledAlreadyMerged(DIGEST, ordered, index).map((e) => e.entryId);
}

describe('shadow-merge-skip', () => {
  it('an empty journal returns ordered unchanged', async () => {
    const { index } = await read(() => []);
    if (index.outcome !== 'indexed') throw new Error('expected an index');
    expect(withoutJournaledAlreadyMerged(DIGEST, ordered, index)).toBe(ordered);
  });

  it('would-already-merged on head A for PR 1 filters head A and leaves head B of PR 1 and PR 2', async () => {
    expect(await filtered([dryRun(key(1, A12, 'would-already-merged'), 'would-already-merged')])).toEqual(['e2', 'e3']);
  });

  it('would-supersede on head B plus would-already-merged on head A for PR 1 filters both', async () => {
    expect(
      await filtered([
        dryRun(key(1, A12, 'would-already-merged'), 'would-already-merged'),
        dryRun(key(1, B12, 'would-supersede'), 'would-supersede'),
      ]),
    ).toEqual(['e3']);
  });

  it('shadow false returns an empty index without calling listForKeyPrefix', async () => {
    const { index, calls } = await read(() => [dryRun(key(1, A12, 'would-already-merged'), 'would-already-merged')], {
      shadow: false,
    });
    expect(calls).toBe(0);
    expect(index).toMatchObject({ outcome: 'indexed' });
    if (index.outcome === 'indexed') expect(index.alreadyMergedKeys.size).toBe(0);
  });

  it('an exhausted budget returns budget-exhausted without calling listForKeyPrefix', async () => {
    const past = await read(() => [], { deadlineIso: '2026-11-01T11:00:00.000Z' });
    const tight = await read(() => [], { deadlineIso: '2026-11-01T12:00:01.000Z' });
    expect(past.index).toEqual({ outcome: 'budget-exhausted' });
    expect(tight.index).toEqual({ outcome: 'budget-exhausted' });
    expect(past.calls + tight.calls).toBe(0);
  });

  it('a missing or null journal fails open', async () => {
    for (const journal of [undefined, null, {}]) {
      const index = await readJournaledWouldAlreadyMerged({
        journal: journal as never,
        repoDigest: DIGEST,
        shadow: true,
        nowIso: NOW,
        deadlineIso: DEADLINE,
      });
      expect(index.outcome).toBe('indexed');
      if (index.outcome === 'indexed') expect(withoutJournaledAlreadyMerged(DIGEST, ordered, index)).toBe(ordered);
    }
  });

  it('a throwing listForKeyPrefix and a non-array return each fail open', async () => {
    const throwing = await readJournaledWouldAlreadyMerged({
      journal: { listForKeyPrefix: async () => { throw new Error('boom'); } },
      repoDigest: DIGEST,
      shadow: true,
      nowIso: NOW,
      deadlineIso: DEADLINE,
    });
    expect(throwing.outcome).toBe('indexed');
    if (throwing.outcome === 'indexed') expect(throwing.alreadyMergedKeys.size).toBe(0);
    expect(await filtered({ not: 'an array' })).toEqual(['e1', 'e2', 'e3']);
    expect(await filtered(null)).toEqual(['e1', 'e2', 'e3']);
  });

  it('malformed records, null elements and throwing getters filter nothing', async () => {
    const throwingGetter = {
      get kind(): string {
        throw new Error('getter');
      },
    };
    expect(
      await filtered([
        null,
        7,
        'text',
        { kind: 'result' },
        dryRun('not-a-key', 'would-already-merged'),
        dryRun(key(1, A12, 'would-already-merged'), 'would-drop'),
        throwingGetter,
      ]),
    ).toEqual(['e1', 'e2', 'e3']);
  });

  it('shadow-intent-closed, an open intent, a non-merge key and a wrong repoDigest each filter nothing', async () => {
    const k = key(1, A12, 'would-already-merged');
    expect(
      await filtered([
        dryRun(k, 'shadow-intent-closed'),
        { kind: 'intent', outcome: null, reasonCode: null, key: k },
        dryRun(key(1, A12, 'would-already-merged', 'ffffffffffff'), 'would-already-merged'),
        dryRun(key(1, A12, 'merge-pr'), 'would-already-merged'),
        dryRun(k, 'would-already-merged', 'journalled'),
      ]),
    ).toEqual(['e1', 'e2', 'e3']);
  });

  it('a non-array ordered input returns an empty list', async () => {
    const { index } = await read(() => []);
    if (index.outcome !== 'indexed') throw new Error('expected an index');
    expect(withoutJournaledAlreadyMerged(DIGEST, undefined as never, index)).toEqual([]);
    expect(withoutJournaledAlreadyMerged(DIGEST, null as never, index)).toEqual([]);
  });
});
