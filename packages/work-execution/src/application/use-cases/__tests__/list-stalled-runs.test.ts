// PT1a (SN3): the stalled-runs view lists the same runs the pass raises attention for, oldest first.
import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { ListStalledRunsUseCase } from '../ListStalledRunsUseCase.use-case.js';

const RUN_A = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const RUN_B = 'run-01M63WPH4GMF2CA3NQ7JAM4HS2';
const NOW = '2026-11-06T21:00:00.000Z';

async function seed(repo: LaneRunRepositoryAdapter, journal: LaneRunJournalAdapter, runId: string, workOrderId: string, parkedAtIso: string, parkClass: string | undefined): Promise<void> {
  const created = LaneRun.create({
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-01M64PT1PX2MAZVQDYAYMZ7WNB'],
    prNumber: null,
    parked: { reason: 'halted', qualifier: null, parkedFrom: 'ready', questionId: null, ...(parkClass === undefined ? {} : { class: parkClass }) },
    parkCount: 1,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy:conductor@7844746b0277',
    schemaVersion: 1,
  });
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  await repo.create(created.value.toRecord());
  await journal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7' + runId.slice(-3).padStart(3, '0'), runId, 'parked', parkedAtIso));
}

describe('ListStalledRunsUseCase (PT1a)', () => {
  it('lists id, class, age and work order, oldest first, with the threshold it used', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    await seed(repo, journal, RUN_B, 'wo-fleet-v2-co14b-2026-11-06', '2026-11-06T20:00:00.000Z', undefined);
    await seed(repo, journal, RUN_A, 'wo-fleet-v2-rv4-2026-11-06', '2026-11-06T19:00:00.000Z', 'blocker');
    const result = await new ListStalledRunsUseCase({ runRepo: repo, runJournal: journal, stallAfterMinutes: 45 }).listStalledRuns({ nowIso: NOW });
    expect(result).toEqual({
      outcome: 'listed',
      stallAfterMinutes: 45,
      stalled: [
        { runId: RUN_A, class: 'blocker', ageMinutes: 120, workOrderId: 'wo-fleet-v2-rv4-2026-11-06' },
        { runId: RUN_B, class: 'other', ageMinutes: 60, workOrderId: 'wo-fleet-v2-co14b-2026-11-06' },
      ],
    });
  });

  it('defaults the threshold to 30 and lists nothing under it', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    await seed(repo, journal, RUN_A, 'wo-fleet-v2-rv4-2026-11-06', '2026-11-06T20:45:00.000Z', 'blocker');
    const result = await new ListStalledRunsUseCase({ runRepo: repo, runJournal: journal }).listStalledRuns({ nowIso: NOW });
    expect(result).toEqual({ outcome: 'listed', stallAfterMinutes: 30, stalled: [] });
  });

  it('refuses a malformed clock and an unreadable store as typed values', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const useCase = new ListStalledRunsUseCase({ runRepo: repo, runJournal: journal });
    expect(await useCase.listStalledRuns({ nowIso: 'yesterday' })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await useCase.listStalledRuns(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    const broken = new ListStalledRunsUseCase({
      runRepo: { list: async () => { throw new Error('unreadable'); } },
      runJournal: journal,
    });
    expect(await broken.listStalledRuns({ nowIso: NOW })).toEqual({ outcome: 'refused', reason: 'unreadable' });
  });
});
