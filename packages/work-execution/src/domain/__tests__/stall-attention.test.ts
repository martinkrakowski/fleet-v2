// PT1a: the stalled runs derived from run records and journals through the SN1 rule, never a second threshold check.
import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import type { LaneRunRecord } from '../lane-run-records.js';
import { laneRunConductEntry } from '../lane-run-step-facts.js';
import { parkedAtIsoOf, stallAttentionKey, stalledRunsOf } from '../stall-attention.js';

/** Ids shaped like `.fleet/state/lane-runs.json` and `run-journal.json`. */
const RUN_A = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const RUN_B = 'run-01M63WPH4GMF2CA3NQ7JAM4HS2';
const RUN_C = 'run-01M63WPH4GMF2CA3NQ7JAM4HS3';
const NOW = '2026-11-06T21:00:00.000Z';

function record(runId: string, workOrderId: string, parked: LaneRunRecord['parked'], prNumber: number | null = null): LaneRunRecord {
  const created = LaneRun.create({
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-01M64PT1PX2MAZVQDYAYMZ7WNB'],
    prNumber,
    parked,
    parkCount: parked === null ? 0 : 1,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy:conductor@7844746b0277',
    schemaVersion: 1,
  });
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return created.value.toRecord();
}

const PARK = { reason: 'halted', qualifier: null, parkedFrom: 'ready', questionId: null } as const;

function conduct(id: string, runId: string, state: 'parked' | 'ready' | 'fixing', iso: string): LaneRunJournalEntryRecord {
  return laneRunConductEntry(id, runId, state, iso);
}

describe('stalledRunsOf (PT1a)', () => {
  const records = [
    record(RUN_A, 'wo-fleet-v2-rv4-2026-11-06', { ...PARK, class: 'transport-busy', reason: 'review-seat-unavailable', parkedFrom: 'code-review' }),
    record(RUN_B, 'wo-fleet-v2-co14b-2026-11-06', PARK),
    record(RUN_C, 'wo-fleet-v2-t2c-2026-11-06', null),
  ];
  const journals = new Map<string, readonly LaneRunJournalEntryRecord[]>([
    [RUN_A, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_A, 'parked', '2026-11-06T19:00:00.000Z')]],
    [RUN_B, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN2', RUN_B, 'parked', '2026-11-06T20:00:00.000Z')]],
    [RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'fixing', '2026-11-06T20:10:00.000Z')]],
  ]);

  it('lists parked runs past the threshold oldest first, with class, age and work order', () => {
    const stalled = stalledRunsOf({ records, journals, stallAfterMinutes: 30, nowIso: NOW });
    expect(stalled.map((view) => [view.runId, view.parkClass, view.ageMinutes, view.workOrderId, view.key])).toEqual([
      [RUN_A, 'transport-busy', 120, 'wo-fleet-v2-rv4-2026-11-06', stallAttentionKey(RUN_A)],
      [RUN_B, 'other', 60, 'wo-fleet-v2-co14b-2026-11-06', stallAttentionKey(RUN_B)],
    ]);
  });

  it('uses only the runs over the threshold: a larger threshold drops the younger park', () => {
    const stalled = stalledRunsOf({ records, journals, stallAfterMinutes: 90, nowIso: NOW });
    expect(stalled.map((view) => view.runId)).toEqual([RUN_A]);
  });

  it('a run that is not parked, has a PR, or has no park time never appears', () => {
    expect(stalledRunsOf({ records: [records[2]!], journals, stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
    const withPr = [record(RUN_A, 'wo-fleet-v2-rv4-2026-11-06', PARK, 812)];
    expect(stalledRunsOf({ records: withPr, journals, stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
    expect(stalledRunsOf({ records: [records[1]!], journals: new Map(), stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
  });

  it('a record with no class reads as other, and a malformed clock or journal never throws', () => {
    expect(stalledRunsOf({ records: [records[1]!], journals, stallAfterMinutes: 30, nowIso: NOW })[0]?.parkClass).toBe('other');
    expect(stalledRunsOf({ records, journals, stallAfterMinutes: 30, nowIso: 'not a time' })).toEqual([]);
    expect(stalledRunsOf({ records, journals: new Map([[RUN_A, null as never]]), stallAfterMinutes: 30, nowIso: NOW })).toEqual([]);
  });

  it('parkedAtIsoOf takes the latest parked conduct entry of the run', () => {
    const entries = [
      conduct('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_A, 'parked', '2026-11-06T19:00:00.000Z'),
      conduct('01M64PT1PX2MAZVQDYAYMZ7WN2', RUN_A, 'fixing', '2026-11-06T19:30:00.000Z'),
      conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_A, 'parked', '2026-11-06T20:30:00.000Z'),
      conduct('01M64PT1PX2MAZVQDYAYMZ7WN4', RUN_B, 'parked', '2026-11-06T20:59:00.000Z'),
    ];
    expect(parkedAtIsoOf(entries, RUN_A)).toBe('2026-11-06T20:30:00.000Z');
    expect(parkedAtIsoOf([], RUN_A)).toBeNull();
  });
});
