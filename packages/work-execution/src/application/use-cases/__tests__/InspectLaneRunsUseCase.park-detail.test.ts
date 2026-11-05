/**
 * GB3c tests for `InspectLaneRunsUseCase`: a GB2-shaped `step-refused`
 * dispatch park at round 0 shows the refusal detail (worktree-uncommitted /
 * worktree-untracked) of the park's own qualifier step, and never leaks a
 * later dispatch-step result whose detail is null or a `next-seat-` advance
 * token (shadowing guard). Fixtures are copied from
 * `src/application/use-cases/__tests__/lane-run-stop-and-status.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { laneRunIntentEntry, laneRunResultEntry, type LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { InspectLaneRunsUseCase } from '../InspectLaneRunsUseCase.use-case.js';

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
  attemptIds: ['attempt-example-1', 'attempt-example-2'],
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

function stepKey(step: 'prepare' | 'dispatch', seatIndex: number, attemptOrdinal: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step,
    seatIndex,
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
  reasonCode: LaneRunResultReasonCode,
  detail: string | null = null,
): [LaneRunJournalEntryRecord, LaneRunJournalEntryRecord] {
  const id = (n: number) => '01JB00000000000000000000' + String(n).padStart(2, '0');
  return [
    laneRunIntentEntry(id(index * 2), RUN_ID, key, 'attempt-example-' + (index + 2), NOW),
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

/** The GB2-shaped park: step-refused at dispatch, parkedFrom seat-failed, round 0. */
function gb2Record(): LaneRunRecord {
  return runRecord({
    parked: { reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'seat-failed', questionId: null },
    parkCount: 1,
  });
}

/** The GB2-shaped journal: seat 0 runner-refused with an advance token, seat 1 prepare, seat 1 dispatch refused. */
function gb2Pairs(detail: string): readonly [LaneRunJournalEntryRecord, LaneRunJournalEntryRecord][] {
  return [
    resultPair(0, stepKey('dispatch', 0, 1), 'refused', 'runner-refused', 'next-seat-rate-limited-1'),
    resultPair(1, stepKey('prepare', 1, 2), 'completed', 'prepared'),
    resultPair(2, stepKey('dispatch', 1, 2), 'refused', 'dispatch-refused', detail),
  ];
}

describe('InspectLaneRunsUseCase parkDetail (GB3c)', () => {
  it('7. a GB2-shaped dispatch park shows the refusal detail (worktree-uncommitted)', async () => {
    const view = await inspectView(gb2Record(), gb2Pairs('worktree-uncommitted'));
    expect(view.parkDetail).toBe('worktree-uncommitted');
  });

  it('7b. the untracked refusal detail shows the same way', async () => {
    const view = await inspectView(gb2Record(), gb2Pairs('worktree-untracked'));
    expect(view.parkDetail).toBe('worktree-untracked');
  });

  it('8. a later dispatch-step result with a next-seat token does not shadow the refusal detail', async () => {
    const view = await inspectView(gb2Record(), [
      ...gb2Pairs('worktree-uncommitted'),
      resultPair(3, stepKey('dispatch', 2, 3), 'refused', 'runner-refused', 'next-seat-rate-limited-2'),
    ]);
    expect(view.parkDetail).toBe('worktree-uncommitted');
  });

  it('8b. a later dispatch-step result with a null detail does not shadow the refusal detail', async () => {
    const view = await inspectView(gb2Record(), [
      ...gb2Pairs('worktree-uncommitted'),
      resultPair(3, stepKey('dispatch', 2, 3), 'refused', 'dispatch-inputs-unreadable'),
    ]);
    expect(view.parkDetail).toBe('worktree-uncommitted');
  });
});

/** A gate step key for one head: `<runId>/r0/gate/<seatIndex>@<head12>` (no attempt ordinal). */
function gateKey(seatIndex: number, head12: string): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'gate',
    seatIndex,
    attemptOrdinal: null,
    head12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a gate step key');
  }
  return built.key;
}

describe('InspectLaneRunsUseCase parkDetail: latest head only (CX7a)', () => {
  it('reports the newer head gate- reason code when its result carries no detail, never an older head detail', async () => {
    const record = runRecord({
      parked: { reason: 'step-refused', qualifier: 'gate', parkedFrom: 'gating', questionId: null },
      parkCount: 1,
    });
    const pairs = [
      resultPair(0, gateKey(0, 'ffffffffffff'), 'completed', 'gate-failed', 'gate-unknown'),
      resultPair(1, gateKey(0, '0123456789ab'), 'completed', 'gate-congested', null),
    ];
    const view = await inspectView(record, pairs);
    expect(view.parkDetail).toBe('gate-congested');
    expect(view.parkDetail).not.toBe('gate-unknown');
  });
});
