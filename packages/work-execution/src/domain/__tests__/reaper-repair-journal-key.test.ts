import { describe, expect, it } from 'vitest';

import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION, prepareLaneRunJournalAppend } from '../lane-run-journal.js';
import { reaperRepairKey } from '../lane-run-keys.js';

const ULID = '01JB0000000000000000000000';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function baseEntry(kind: LaneRunJournalEntryRecord['kind']): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: nextEntryId(),
    kind,
    key: null,
    runId: null,
    recordedAtIso: '2026-11-06T10:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function intent(key: string, extra: Partial<LaneRunJournalEntryRecord> = {}): LaneRunJournalEntryRecord {
  return { ...baseEntry('intent'), key, ...extra };
}

function result(
  key: string,
  outcome: NonNullable<LaneRunJournalEntryRecord['outcome']>,
  extra: Partial<LaneRunJournalEntryRecord> = {},
): LaneRunJournalEntryRecord {
  return { ...baseEntry('result'), key, outcome, ...extra };
}

describe('the reaper keyed repair journal entry (plan §3.9.2)', () => {
  const key = reaperRepairKey('attempt-example-1', 'dead-attempt', ULID);
  if (!key.ok) {
    throw new Error('unreachable: reaper repair key builder');
  }
  const repairKey = key.key;

  it('journals one reaper repair intent and its reconciled result under the repair key', () => {
    expect(repairKey).toBe(`reaper/attempt-example-1/dead-attempt@${ULID}`);
    const first = prepareLaneRunJournalAppend([], intent(repairKey));
    expect(first.ok).toBe(true);
    const second = prepareLaneRunJournalAppend(
      first.ok ? [first.entry] : [],
      result(repairKey, 'reconciled'),
    );
    expect(second.ok).toBe(true);
  });

  it('refuses a second reaper repair intent under the same key', () => {
    const first = prepareLaneRunJournalAppend([], intent(repairKey));
    if (!first.ok) {
      throw new Error('unreachable: first intent');
    }
    const second = prepareLaneRunJournalAppend([first.entry], intent(repairKey));
    expect(second).toEqual({
      ok: false,
      reason: 'duplicate-key',
      detail: null,
    });
  });

  it('refuses a reaper result without its intent', () => {
    const refusal = prepareLaneRunJournalAppend([], result(repairKey, 'reconciled'));
    expect(refusal).toEqual({
      ok: false,
      reason: 'result-without-intent',
      detail: null,
    });
  });

  it('keeps an intent without a result so the next pass can reconcile it once', () => {
    const first = prepareLaneRunJournalAppend([], intent(repairKey));
    if (!first.ok) {
      throw new Error('unreachable: first intent');
    }
    // The intent with no result is the whole journal: it stays kept.
    expect(first.entry.key).toBe(repairKey);

    const reconciled = prepareLaneRunJournalAppend([first.entry], result(repairKey, 'reconciled'));
    if (!reconciled.ok) {
      throw new Error('unreachable: reconciled result');
    }
    const after = prepareLaneRunJournalAppend(
      [first.entry, reconciled.entry],
      result(repairKey, 'reconciled'),
    );
    expect(after).toEqual({
      ok: false,
      reason: 'result-after-final',
      detail: null,
    });
  });
});
