// PT1a: the stalled runs derived from run records and journals through the SN1 rule, never a second threshold check.
import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import type { LaneRunRecord } from '../lane-run-records.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../lane-run-step-facts.js';
import { laneRunMergeEnqueueKey } from '../lane-run-keys.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';
import { isLegitimateIdleWait, parkedAtIsoOf, stallAttentionKey, stalledRunsOf } from '../stall-attention.js';

/** Ids shaped like `.fleet/state/lane-runs.json` and `run-journal.json`. */
const RUN_A = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const RUN_B = 'run-01M63WPH4GMF2CA3NQ7JAM4HS2';
const RUN_C = 'run-01M63WPH4GMF2CA3NQ7JAM4HS3';
const NOW = '2026-11-06T21:00:00.000Z';

function record(runId: string, workOrderId: string, parked: LaneRunRecord['parked'], prNumber: number | null = null, tier: LaneRunRecord['tier'] = 2): LaneRunRecord {
  const created = LaneRun.create({
    version: 1,
    runId,
    workOrderId,
    tier,
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

function conduct(id: string, runId: string, state: LaneRunStateValue, iso: string): LaneRunJournalEntryRecord {
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
    // RUN_C is not parked; 20 minutes before NOW keeps it under the 30 minute threshold in the tests below.
    [RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'fixing', '2026-11-06T20:40:00.000Z')]],
  ]);

  it('lists parked runs past the threshold oldest first, with class, age and work order', () => {
    const stalled = stalledRunsOf({ records, journals, stallAfterMinutes: 30, nowIso: NOW });
    expect(stalled.map((view) => [
      view.runId,
      'parkClass' in view ? view.parkClass : null,
      view.ageMinutes,
      view.workOrderId,
      view.key,
    ])).toEqual([
      [RUN_A, 'transport-busy', 120, 'wo-fleet-v2-rv4-2026-11-06', stallAttentionKey(RUN_A)],
      [RUN_B, 'other', 60, 'wo-fleet-v2-co14b-2026-11-06', stallAttentionKey(RUN_B)],
    ]);
  });

  it('uses only the runs over the threshold: a larger threshold drops the younger park', () => {
    const stalled = stalledRunsOf({ records, journals, stallAfterMinutes: 90, nowIso: NOW });
    expect(stalled.map((view) => view.runId)).toEqual([RUN_A]);
  });

  it('a parked run with an open PR is listed too (owned-park), once', () => {
    const withPr = [record(RUN_A, 'wo-fleet-v2-rv4-2026-11-06', PARK, 812)];
    const stalled = stalledRunsOf({ records: withPr, journals, stallAfterMinutes: 30, nowIso: NOW });
    expect(stalled.map((view) => [view.runId, view.ageMinutes])).toEqual([[RUN_A, 120]]);
  });

  it('a non-parked run under the threshold and a parked run with no park time never appear', () => {
    expect(stalledRunsOf({ records: [records[2]!], journals, stallAfterMinutes: 30, nowIso: NOW })).toEqual([]);
    expect(stalledRunsOf({ records: [records[1]!], journals: new Map(), stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
  });

  it('a record with no class reads as other, and a malformed clock or journal never throws', () => {
    const first = stalledRunsOf({ records: [records[1]!], journals, stallAfterMinutes: 30, nowIso: NOW })[0];
    expect(first !== undefined && 'parkClass' in first ? first.parkClass : undefined).toBe('other');
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

describe('isLegitimateIdleWait (PT1a)', () => {
  const tier1 = record(RUN_A, 'wo-fleet-v2-rv4-2026-11-06', null, null, 1);
  const tier2 = record(RUN_A, 'wo-fleet-v2-rv4-2026-11-06', null);

  it('watching-ci is a legitimate wait for tier 1 and tier 2', () => {
    const entries = [conduct('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_A, 'watching-ci', '2026-11-06T19:00:00.000Z')];
    expect(isLegitimateIdleWait(tier1, entries)).toBe(true);
    expect(isLegitimateIdleWait(tier2, entries)).toBe(true);
  });

  it('awaiting-premerge is a legitimate wait only for tier 2', () => {
    const entries = [conduct('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_A, 'awaiting-premerge', '2026-11-06T19:00:00.000Z')];
    expect(isLegitimateIdleWait(tier2, entries)).toBe(true);
    expect(isLegitimateIdleWait(tier1, entries)).toBe(false);
  });

  it('merging with an open merge-enqueue intent is legitimate; a final result closes it', () => {
    const mergeEnqueue = laneRunMergeEnqueueKey(RUN_A, 0, 'a'.repeat(12));
    if (!mergeEnqueue.ok) {
      throw new Error('fixture key must build');
    }
    const merging = conduct('01M64PT1PX2MAZVQDYAYMZ7WN2', RUN_A, 'merging', '2026-11-06T19:00:00.000Z');
    const intent = laneRunIntentEntry('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_A, mergeEnqueue.key, null, '2026-11-06T19:00:00.000Z');
    expect(isLegitimateIdleWait(tier2, [intent, merging])).toBe(true);
    expect(isLegitimateIdleWait(tier2, [merging])).toBe(false);
    const result = laneRunResultEntry('01M64PT1PX2MAZVQDYAYMZ7WN4', RUN_A, mergeEnqueue.key, 'completed', null, '2026-11-06T20:00:00.000Z', 'merged');
    expect(isLegitimateIdleWait(tier2, [intent, result, merging])).toBe(false);
  });

  it('brief-check, gating and running are never legitimate', () => {
    for (const state of ['brief-check', 'gating', 'running'] as const) {
      expect(isLegitimateIdleWait(tier2, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_A, state, '2026-11-06T19:00:00.000Z')])).toBe(false);
    }
  });
});

describe('stalledRunsOf non-parked runs (PT1a)', () => {
  const IDLE = record(RUN_C, 'wo-fleet-v2-t2c-2026-11-06', null);

  it('lists a non-parked run past the threshold once, with its journal state, age and last advanced time', () => {
    const journals = new Map([[RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'gating', '2026-11-06T19:00:00.000Z')]]]);
    const stalled = stalledRunsOf({ records: [IDLE], journals, stallAfterMinutes: 30, nowIso: NOW });
    expect(stalled).toEqual([
      {
        runId: RUN_C,
        key: stallAttentionKey(RUN_C),
        workOrderId: 'wo-fleet-v2-t2c-2026-11-06',
        state: 'gating',
        ageMinutes: 120,
        lastAdvancedAtIso: '2026-11-06T19:00:00.000Z',
      },
    ]);
  });

  it('the same run with a recent last-advanced time is absent', () => {
    const journals = new Map([[RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'gating', '2026-11-06T20:40:00.000Z')]]]);
    expect(stalledRunsOf({ records: [IDLE], journals, stallAfterMinutes: 30, nowIso: NOW })).toEqual([]);
  });

  it('every legitimate long wait is absent even far past the threshold', () => {
    const watchingCi = new Map([[RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'watching-ci', '2026-11-06T19:00:00.000Z')]]]);
    expect(stalledRunsOf({ records: [IDLE], journals: watchingCi, stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
    const premerge = new Map([[RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'awaiting-premerge', '2026-11-06T19:00:00.000Z')]]]);
    expect(stalledRunsOf({ records: [IDLE], journals: premerge, stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
    const mergeEnqueue = laneRunMergeEnqueueKey(RUN_C, 0, 'a'.repeat(12));
    if (!mergeEnqueue.ok) {
      throw new Error('fixture key must build');
    }
    const train = new Map([
      [
        RUN_C,
        [
          laneRunIntentEntry('01M64PT1PX2MAZVQDYAYMZ7WN4', RUN_C, mergeEnqueue.key, null, '2026-11-06T19:00:00.000Z'),
          conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'merging', '2026-11-06T19:00:00.000Z'),
        ],
      ],
    ]);
    expect(stalledRunsOf({ records: [IDLE], journals: train, stallAfterMinutes: 1, nowIso: NOW })).toEqual([]);
  });

  it('a conduct entry at 19:00 and a later result entry at 20:00 lists age 60 and the result timestamp', () => {
    const key = laneRunMergeEnqueueKey(RUN_C, 0, 'a'.repeat(12));
    if (!key.ok) {
      throw new Error('fixture key must build');
    }
    const journals = new Map([
      [
        RUN_C,
        [
          conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'gating', '2026-11-06T19:00:00.000Z'),
          laneRunResultEntry('01M64PT1PX2MAZVQDYAYMZ7WN5', RUN_C, key.key, 'completed', null, '2026-11-06T20:00:00.000Z', 'merged'),
        ],
      ],
    ]);
    const stalled = stalledRunsOf({ records: [IDLE], journals, stallAfterMinutes: 30, nowIso: NOW });
    expect(stalled).toHaveLength(1);
    const view = stalled[0]!;
    expect(view.ageMinutes).toBe(60);
    expect('lastAdvancedAtIso' in view ? view.lastAdvancedAtIso : undefined).toBe('2026-11-06T20:00:00.000Z');
  });

  it('one older idle run and one younger parked run sort idle first', () => {
    const bothRecords = [
      record(RUN_B, 'wo-fleet-v2-co14b-2026-11-06', PARK),
      record(RUN_C, 'wo-fleet-v2-t2c-2026-11-06', null),
    ];
    const bothJournals = new Map([
      [RUN_B, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN2', RUN_B, 'parked', '2026-11-06T20:00:00.000Z')]],
      [RUN_C, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN3', RUN_C, 'running', '2026-11-06T19:00:00.000Z')]],
    ]);
    const stalled = stalledRunsOf({ records: bothRecords, journals: bothJournals, stallAfterMinutes: 30, nowIso: NOW });
    expect(stalled.map((view) => view.runId)).toEqual([RUN_C, RUN_B]);
  });

  it('a parked run still does not appear twice', () => {
    const withPr = [record(RUN_A, 'wo-fleet-v2-rv4-2026-11-06', PARK, 812)];
    const withPrJournals = new Map([[RUN_A, [conduct('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_A, 'parked', '2026-11-06T19:00:00.000Z')]]]);
    expect(stalledRunsOf({ records: withPr, journals: withPrJournals, stallAfterMinutes: 30, nowIso: NOW })).toHaveLength(1);
  });
});
