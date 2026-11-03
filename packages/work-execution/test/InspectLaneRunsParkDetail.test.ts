/**
 * GB3a tests for `InspectLaneRunsUseCase`: a `step-refused` park with a
 * qualifier shows the fixed refusal detail of its own step's result
 * (`view.parkDetail`), and never leaks a detail from another step or a null
 * detail. Fixtures are copied from
 * `src/application/use-cases/__tests__/lane-run-stop-and-status.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../src/domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../src/domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../src/domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../src/domain/lane-run-keys.js';
import { laneRunIntentEntry, laneRunResultEntry } from '../src/domain/lane-run-step-facts.js';
import { LaneRunRepositoryAdapter } from '../src/infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../src/infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { ConductorHaltAdapter } from '../src/infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../src/infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { InspectLaneRunsUseCase } from '../src/application/use-cases/InspectLaneRunsUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-example-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
  schemaVersion: 1,
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function stepKey(step: 'prepare' | 'dispatch', attemptOrdinal: number | null): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 1,
    step,
    seatIndex: 0,
    attemptOrdinal,
    head12: null,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a step key');
  }
  return built.key;
}

/** A result pair for one step key: its intent then its result (the journal requires the intent first). */
function resultPair(
  index: number,
  key: string,
  outcome: 'refused' | 'completed',
  reasonCode: string,
  detail: string | null = null,
): [LaneRunJournalEntryRecord, LaneRunJournalEntryRecord] {
  const id = (n: number) => '01JB00000000000000000000' + String(n).padStart(2, '0');
  return [
    laneRunIntentEntry(id(index * 2), RUN_ID, key, 'attempt-example-2', NOW),
    laneRunResultEntry(id(index * 2 + 1), RUN_ID, key, outcome, reasonCode, NOW, detail),
  ];
}

async function inspectView(record: LaneRunRecord, pairs: readonly [LaneRunJournalEntryRecord, LaneRunJournalEntryRecord][]) {
  const repo = new LaneRunRepositoryAdapter();
  const journal = new LaneRunJournalAdapter();
  const created = await repo.create(record);
  expect(created.outcome).toBe('saved');
  for (const [intent, result] of pairs) {
    expect((await journal.append(intent)).outcome).toBe('appended');
    expect((await journal.append(result)).outcome).toBe('appended');
  }
  const useCase = new InspectLaneRunsUseCase({
    runRepo: repo,
    runJournal: journal,
    halt: new ConductorHaltAdapter(),
    driverLease: new ConductorDriverLeaseAdapter(),
  });
  const result = await useCase.inspectLaneRuns({ nowIso: NOW });
  expect(result.outcome).toBe('listed');
  if (result.outcome !== 'listed') {
    throw new Error('expected listed');
  }
  return result.runs[0];
}

describe('InspectLaneRunsUseCase parkDetail (GB3a)', () => {
  it('T6: a step-refused dispatch park shows the refused dispatch detail', async () => {
    const record = runRecord({
      parked: { reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const view = await inspectView(record, [
      resultPair(0, stepKey('dispatch', 2), 'refused', 'dispatch-refused', 'worktree-uncommitted'),
    ]);
    expect(view.parkDetail).toBe('worktree-uncommitted');
  });

  it('T7: no parkDetail key when the run is not parked', async () => {
    const record = runRecord();
    const view = await inspectView(record, [
      resultPair(0, stepKey('dispatch', 2), 'refused', 'dispatch-refused', 'worktree-uncommitted'),
    ]);
    expect(view).not.toHaveProperty('parkDetail');
    expect(view.parkDetail).toBeUndefined();
  });

  it('T8: no parkDetail key when the park reason is not step-refused', async () => {
    const record = runRecord({
      parked: { reason: 'ambiguous', qualifier: 'dispatch', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const view = await inspectView(record, [
      resultPair(0, stepKey('dispatch', 2), 'refused', 'dispatch-refused', 'worktree-uncommitted'),
    ]);
    expect(view).not.toHaveProperty('parkDetail');
  });

  it('T8: no parkDetail key when the result detail is null', async () => {
    const record = runRecord({
      parked: { reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const view = await inspectView(record, [
      resultPair(0, stepKey('dispatch', 2), 'refused', 'dispatch-refused'),
    ]);
    expect(view).not.toHaveProperty('parkDetail');
  });

  it('T9: a detail from another step does not leak into a dispatch park', async () => {
    const record = runRecord({
      parked: { reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const view = await inspectView(record, [
      resultPair(0, stepKey('prepare', 2), 'refused', 'prepare-refused', 'worktree-uncommitted'),
      resultPair(1, stepKey('dispatch', 2), 'refused', 'dispatch-refused', 'no-reservation'),
    ]);
    expect(view.parkDetail).toBe('no-reservation');
  });

  it('a dispatch park with no dispatch result at all shows no detail', async () => {
    const record = runRecord({
      parked: { reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const view = await inspectView(record, [
      resultPair(0, stepKey('prepare', 2), 'refused', 'prepare-refused', 'worktree-uncommitted'),
    ]);
    expect(view).not.toHaveProperty('parkDetail');
  });
});
