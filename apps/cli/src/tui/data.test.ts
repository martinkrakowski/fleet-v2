// TUI data-layer tests — P9.
import { describe, expect, it } from 'vitest';

import type { ListLaneRunsResult } from '@fleet/work-execution';

import { createTuiDataSource, type TuiListRuns } from './data.js';

const NOW = '2026-11-03T10:04:00.000Z';
const RUN_ID = 'run-01JB0000000000000000000000';

const LISTED_RESULT: Extract<ListLaneRunsResult, { readonly outcome: 'listed' }> = {
  outcome: 'listed' as const,
  schedule: {
    observedAtIso: NOW,
    halt: 'clear' as const,
    driverLeaseLapsed: null,
    rows: [
      {
        runId: RUN_ID,
        baseBranch: 'main',
        workOrderId: 'wo-acme-repo',
        tier: 2,
        state: 'running',
        round: 0,
        revision: 1,
        stopMode: null,
        stopRequestedAtIso: null,
        placement: 'running',
        pendingStep: null,
        park: null,
        leaseLapsed: false,
        packageKeys: ['packages/a/x.ts'],
        workOrderUnreadable: false,
        overlapsWith: [],
        slot: { hostName: 'sol', slotIndex: 0 },
        admissionWait: null,
      },
    ],
    queues: [{ baseBranch: 'main', runIds: [RUN_ID] }],
    hosts: [{ hostName: 'sol', slots: [{ slotIndex: 0, runId: RUN_ID }] }],
    admission: { active: 1, inFlight: 0, maxActiveRuns: null },
    caps: null,
    trace: 'none' as const,
  },
  sessionStarts: [],
  truncated: false,
};

describe('createTuiDataSource', () => {
  it('maps a rejected listing to one not-read line with the reason', async () => {
    const listRuns: TuiListRuns = async () => ({
      outcome: 'rejected',
      reason: 'invalid-request',
    });
    const source = createTuiDataSource(listRuns);
    await expect(source.listRuns(NOW)).resolves.toEqual(['lane runs not read: invalid-request']);
  });

  it('maps a throwing listing to one not-read line', async () => {
    const listRuns: TuiListRuns = async () => {
      throw new Error('store unreadable');
    };
    const source = createTuiDataSource(listRuns);
    await expect(source.listRuns(NOW)).resolves.toEqual(['lane runs not read']);
  });

  it('maps a listed result to the scheduleText rows', async () => {
    const listRuns: TuiListRuns = async () => LISTED_RESULT;
    const source = createTuiDataSource(listRuns);
    const rows = await source.listRuns(NOW);
    expect(rows).toHaveLength(3);
    expect(rows.join('\n')).toContain(RUN_ID);
    expect(rows[0]).toBe('halt clear · driver none · admission 1 active + 0 in flight / cap not recorded');
  });
});
