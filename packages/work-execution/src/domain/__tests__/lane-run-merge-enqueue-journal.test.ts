/**
 * KS7b: a journal written before the `merge-enqueue` step must still replay. The text below is a
 * recorded pre-change conducted journal (the stored shape: no `detail` key, the one-way
 * `<runId>/r0/merge/0@<head12>` key, the KS7a `premerge` key). It is read entry by entry
 * through the journal reader, never rebuilt from the current builders.
 */

import { describe, expect, it } from 'vitest';

import { readLaneRunJournalEntry, laneRunJournalPendingIntent, laneRunJournalState } from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import { laneRunMergeEnqueueFact } from '../lane-run-step-facts.js';
import { laneRunMergeEnqueueKey, parseLaneRunKey } from '../lane-run-keys.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const HEAD12 = 'aaaaaaaaaaaa';

/** A recorded pre-KS7b journal of a run that reached `merging` and journalled a one-way merge. */
const RECORDED_PRE_KS7B_JOURNAL = [
  { version: 1, entryId: '01JB0000000000000000000001', kind: 'conduct', key: null, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:00.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: null, reasonCode: null, grantId: null, state: 'merging' },
  { version: 1, entryId: '01JB0000000000000000000002', kind: 'intent', key: `${RUN_ID}/r0/accept/0@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:01.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: null, reasonCode: null, grantId: null, state: null },
  { version: 1, entryId: '01JB0000000000000000000003', kind: 'result', key: `${RUN_ID}/r0/accept/0@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:02.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: 'completed', reasonCode: 'accepted', grantId: null, state: null },
  { version: 1, entryId: '01JB0000000000000000000004', kind: 'intent', key: `${RUN_ID}/r0/premerge@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:03.000Z', mode: null, expectedRevision: null, mintedId: 'forge-01JB0000000000000000000009', outcome: null, reasonCode: null, grantId: null, state: null },
  { version: 1, entryId: '01JB0000000000000000000005', kind: 'result', key: `${RUN_ID}/r0/premerge@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:04.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: 'completed', reasonCode: 'premerge-success', grantId: null, state: null },
  { version: 1, entryId: '01JB0000000000000000000006', kind: 'intent', key: `${RUN_ID}/r0/merge/0@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:05.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: null, reasonCode: null, grantId: null, state: null },
] as const;

function replay(raw: readonly unknown[]): LaneRunJournalEntryRecord[] {
  return raw.map((input) => {
    const read = readLaneRunJournalEntry(input);
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok) {
      throw new Error('recorded entry must read');
    }
    return read.entry;
  });
}

describe('a journal written before KS7b still replays', () => {
  it('reads every recorded entry and keeps the one-way merge intent pending for its reconcile', () => {
    const entries = replay(RECORDED_PRE_KS7B_JOURNAL);
    expect(laneRunJournalState(entries, RUN_ID)).toBe('merging');
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toEqual({
      key: `${RUN_ID}/r0/merge/0@${HEAD12}`,
      step: 'merge',
      reconciliation: 'unread',
    });
    // The old keys keep their kinds; none is read as a merge-enqueue key.
    expect(entries.map((entry) => (entry.key === null ? null : parseLaneRunKey(entry.key)?.kind))).toEqual([
      null, 'step', 'step', 'premerge', 'premerge', 'step',
    ]);
    // No merge-enqueue fact is invented from it.
    expect(laneRunMergeEnqueueFact(entries, RUN_ID, 0, HEAD12)).toBe('none');
  });

  it('a settled old merge result leaves no pending intent and the same state', () => {
    const entries = replay([
      ...RECORDED_PRE_KS7B_JOURNAL,
      { version: 1, entryId: '01JB0000000000000000000007', kind: 'result', key: `${RUN_ID}/r0/merge/0@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:06.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: 'completed', reasonCode: 'merged', grantId: null, state: null },
    ]);
    expect(laneRunJournalPendingIntent(entries, RUN_ID)).toBeNull();
    expect(laneRunJournalState(entries, RUN_ID)).toBe('merging');
  });

  it('the new hand-off appends to the same journal: intent pending, then a final answer', () => {
    const key = laneRunMergeEnqueueKey(RUN_ID, 0, HEAD12);
    if (!key.ok) {
      throw new Error('fixture key');
    }
    const intent = { version: 1, entryId: '01JB0000000000000000000008', kind: 'intent', key: key.key, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:07.000Z', mode: null, expectedRevision: null, mintedId: '01JB0000000000000000000099', outcome: null, reasonCode: null, detail: null, grantId: null, state: null };
    const settledOld = { version: 1, entryId: '01JB0000000000000000000007', kind: 'result', key: `${RUN_ID}/r0/merge/0@${HEAD12}`, runId: RUN_ID, recordedAtIso: '2026-11-01T10:00:06.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: 'refused', reasonCode: 'merge-not-merged', grantId: null, state: null };
    const open = replay([...RECORDED_PRE_KS7B_JOURNAL, settledOld, intent]);
    expect(laneRunJournalPendingIntent(open, RUN_ID)).toEqual({ key: key.key, step: 'merge-enqueue', reconciliation: 'unread' });
    const dropped = replay([
      ...RECORDED_PRE_KS7B_JOURNAL, settledOld, intent,
      { ...intent, entryId: '01JB0000000000000000000010', kind: 'result', mintedId: null, outcome: 'completed', reasonCode: 'merge-dropped', detail: 'checks' },
    ]);
    expect(laneRunJournalPendingIntent(dropped, RUN_ID)).toBeNull();
    expect(laneRunMergeEnqueueFact(dropped, RUN_ID, 0, HEAD12)).toBe('dropped-fixable');
    // The fact is for one round and one head only.
    expect(laneRunMergeEnqueueFact(dropped, RUN_ID, 1, HEAD12)).toBe('none');
    expect(laneRunMergeEnqueueFact(dropped, RUN_ID, 0, 'bbbbbbbbbbbb')).toBe('none');
  });

  it('a merge-enqueue entry whose run id disagrees with its key is refused', () => {
    const key = laneRunMergeEnqueueKey(RUN_ID, 0, HEAD12);
    if (!key.ok) {
      throw new Error('fixture key');
    }
    const read = readLaneRunJournalEntry({
      version: 1, entryId: '01JB0000000000000000000008', kind: 'intent', key: key.key, runId: 'run-01JB0000000000000000000001',
      recordedAtIso: '2026-11-01T10:00:07.000Z', mode: null, expectedRevision: null, mintedId: null, outcome: null,
      reasonCode: null, detail: null, grantId: null, state: null,
    });
    expect(read.ok).toBe(false);
  });
});

describe('laneRunMergeEnqueueFact', () => {
  const key = laneRunMergeEnqueueKey(RUN_ID, 0, HEAD12);
  const result = (outcome: string, reasonCode: string | null, detail: string | null): LaneRunJournalEntryRecord => {
    if (!key.ok) {
      throw new Error('fixture key');
    }
    return Object.freeze({
      version: 1, entryId: '01JB0000000000000000000011', kind: 'result', key: key.key, runId: RUN_ID,
      recordedAtIso: '2026-11-01T10:00:07.000Z', mode: null, expectedRevision: null, mintedId: null,
      outcome, reasonCode, detail, grantId: null, state: null,
    }) as unknown as LaneRunJournalEntryRecord;
  };

  it.each([
    ['merged', 'completed', 'merged', null, 'merged'],
    ['a fixable drop', 'completed', 'merge-dropped', 'conflict', 'dropped-fixable'],
    ['a macos drop', 'completed', 'merge-dropped', 'macos', 'dropped-fixable'],
    ['a forge-error drop', 'completed', 'merge-dropped', 'forge-error-exhausted', 'stuck'],
    ['an unknown drop token', 'completed', 'merge-dropped', 'unknown', 'stuck'],
    ['a drop without a detail', 'completed', 'merge-dropped', null, 'stuck'],
    ['a veto hold', 'completed', 'merge-held', 'veto-hold', 'held'],
    ['an enqueue refusal', 'refused', 'merge-enqueue-refused', 'invalid-head', 'stuck'],
    ['an unrecognised reason', 'completed', 'something-new', null, 'stuck'],
    ['an overtaken result', 'overtaken', 'merge-overtaken', null, 'none'],
    ['an ambiguous result', 'ambiguous', 'forge-ambiguous', null, 'none'],
  ] as const)('%s reads %s', (_name, outcome, reasonCode, detail, expected) => {
    expect(laneRunMergeEnqueueFact([result(outcome, reasonCode, detail)], RUN_ID, 0, HEAD12)).toBe(expected);
  });

  it('never throws on a bad head or run and reads none', () => {
    expect(laneRunMergeEnqueueFact([], RUN_ID, 0, null)).toBe('none');
    expect(laneRunMergeEnqueueFact([result('completed', 'merged', null)], RUN_ID, 0, 'xyz')).toBe('none');
    expect(laneRunMergeEnqueueFact([result('completed', 'merged', null)], 'run-other', 0, HEAD12)).toBe('none');
  });
});
