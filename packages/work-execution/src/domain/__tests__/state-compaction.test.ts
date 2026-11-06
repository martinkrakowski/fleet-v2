// EX-3b: the pure compaction policy. Only the fields the policy reads matter
// (`id`, `attemptId`, `priorAttemptId`, `state`, `held`, `status`), so the
// records below are minimal literals.

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
} from '../execution-records.js';
import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import type { LaneRunRecord } from '../lane-run-records.js';
import {
  liveRunAttemptIds,
  planAttemptScopedCompaction,
  type AttemptScopedCompactionInput,
  type AttemptScopedCompactionPlan,
} from '../state-compaction.js';

function attempt(id: string, state: AttemptRecord['state'], priorAttemptId: string | null = null): AttemptRecord {
  return { id, state, priorAttemptId } as unknown as AttemptRecord;
}

function reservation(id: string, attemptId: string, held: boolean): CapacityReservationRecord {
  return { id, attemptId, held } as unknown as CapacityReservationRecord;
}

function journal(id: string, attemptId: string, status: ActionJournalEntryRecord['status']): ActionJournalEntryRecord {
  return { id, attemptId, status } as unknown as ActionJournalEntryRecord;
}

function plan(
  input: Partial<Omit<AttemptScopedCompactionInput, 'attempts'>> & Pick<AttemptScopedCompactionInput, 'attempts'>,
): AttemptScopedCompactionPlan {
  return planAttemptScopedCompaction({
    attempts: input.attempts,
    reservations: input.reservations ?? [],
    journalEntries: input.journalEntries ?? [],
    liveRunAttemptIds: input.liveRunAttemptIds ?? [],
  });
}

describe('planAttemptScopedCompaction', () => {
  it('a collected attempt is removable and a running attempt is not', () => {
    const result = plan({
      attempts: [attempt('att-collected', 'collected'), attempt('att-running', 'running')],
    });
    expect(result.removableAttemptIds).toEqual(['att-collected']);
  });

  it('a cancelled attempt is removable and an ended attempt is not', () => {
    const result = plan({
      attempts: [attempt('att-cancelled', 'cancelled'), attempt('att-ended', 'ended')],
    });
    expect(result.removableAttemptIds).toEqual(['att-cancelled']);
  });

  it('an attempt a live run names is kept', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected')],
      liveRunAttemptIds: ['att-a'],
    });
    expect(result.removableAttemptIds).toEqual([]);
  });

  it('an attempt a held reservation holds is kept', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected')],
      reservations: [reservation('res-1', 'att-a', true)],
    });
    expect(result.removableAttemptIds).toEqual([]);
  });

  it('the prior attempt of an uncollected attempt is kept', () => {
    const result = plan({
      attempts: [attempt('att-old', 'collected'), attempt('att-new', 'running', 'att-old')],
    });
    expect(result.removableAttemptIds).toEqual([]);
  });

  it('an attempt an intent-recorded journal entry names is kept', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected')],
      journalEntries: [journal('j-1', 'att-a', 'intent-recorded')],
    });
    expect(result.removableAttemptIds).toEqual([]);
  });

  it('an attempt an ambiguous journal entry names is kept', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected')],
      journalEntries: [journal('j-1', 'att-a', 'ambiguous')],
    });
    expect(result.removableAttemptIds).toEqual([]);
  });

  it('a released reservation of a removable attempt is removable and a held one is not', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected'), attempt('att-b', 'collected')],
      reservations: [
        reservation('res-released', 'att-a', false),
        reservation('res-held', 'att-b', true),
      ],
    });
    expect(result.removableAttemptIds).toEqual(['att-a']);
    expect(result.removableReservationIds).toEqual(['res-released']);
  });

  it('a completed journal entry of a removable attempt is removable and an entry of a kept attempt is not', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected'), attempt('att-running', 'running')],
      journalEntries: [
        journal('j-completed', 'att-a', 'completed'),
        journal('j-of-running', 'att-running', 'completed'),
      ],
    });
    expect(result.removableAttemptIds).toEqual(['att-a']);
    expect(result.removableJournalEntryIds).toEqual(['j-completed']);
  });

  it('the plan removes nothing when every attempt is live', () => {
    const result = plan({
      attempts: [attempt('att-a', 'collected')],
      liveRunAttemptIds: ['att-a'],
    });
    expect(result.removableAttemptIds).toEqual([]);
    expect(result.removableReservationIds).toEqual([]);
    expect(result.removableJournalEntryIds).toEqual([]);
  });
});

describe('liveRunAttemptIds', () => {
  const RUN_A = 'run-01J' + '0'.repeat(23);
  const RUN_B = 'run-01J' + '1'.repeat(23);
  const run = (runId: string, attemptIds: string[]): LaneRunRecord =>
    ({ runId, attemptIds }) as unknown as LaneRunRecord;
  const conduct = (runId: string, state: string): LaneRunJournalEntryRecord =>
    ({ kind: 'conduct', runId, state }) as unknown as LaneRunJournalEntryRecord;

  it('lists the attempts of a live run', () => {
    const journals = new Map([[RUN_A, [conduct(RUN_A, 'running')]]]);
    expect(liveRunAttemptIds([run(RUN_A, ['att-1', 'att-2'])], journals)).toEqual(['att-1', 'att-2']);
  });

  it('a terminal run contributes nothing', () => {
    const journals = new Map([
      [RUN_A, [conduct(RUN_A, 'running'), conduct(RUN_A, 'merged')]],
      [RUN_B, [conduct(RUN_B, 'stopped')]],
    ]);
    expect(liveRunAttemptIds([run(RUN_A, ['att-1']), run(RUN_B, ['att-2'])], journals)).toEqual([]);
  });

  it('a run with no journal entry is live', () => {
    expect(liveRunAttemptIds([run(RUN_A, ['att-1'])], new Map())).toEqual(['att-1']);
  });

  it('a run with an unreadable id reads as live and duplicates collapse', () => {
    expect(liveRunAttemptIds([run('bogus', ['att-1', 'att-1'])], new Map())).toEqual(['att-1']);
  });
});
