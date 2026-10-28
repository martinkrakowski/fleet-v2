// Implemented for K4-1 — the record-only cancel of a prepared attempt.
/**
 * CancelPreparedAttemptUseCase: cancel an attempt that was never dispatched in
 * the record only. An `intent-recorded` attempt becomes `cancelled` by CAS on
 * its revision, so a concurrent writer loses; a held reservation is released
 * and reported released only when the release is confirmed. No runner is
 * contacted, and `DispatchAttempt` refuses a cancelled attempt.
 */

import type { ActionJournalEntryRecord, AttemptRecord } from '../../domain/execution-records.js';
import type {
  CancelPreparedAttemptPort,
  CancelPreparedAttemptRequest,
  CancelPreparedAttemptResult,
} from '../ports/in/CancelPreparedAttemptPort.in-port.js';
import {
  AttemptRevisionConflictError,
  nextAttemptRevision,
  type AttemptRepositoryPort,
} from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

export interface CancelPreparedAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: Pick<
    ExecutionJournalPort,
    'appendJournalEntry' | 'listJournalEntriesForAttempt' | 'listActiveReservations' | 'releaseCapacityReservation'
  >;
}

type JournalEntryDraft = Omit<ActionJournalEntryRecord, 'id'>;

/** Append one journal entry with an identity derived from the attempt's history. */
async function appendJournalEntry(
  journal: CancelPreparedAttemptDependencies['journal'],
  draft: JournalEntryDraft,
): Promise<ActionJournalEntryRecord> {
  const priorEntries = await journal.listJournalEntriesForAttempt(draft.attemptId);
  const entry: ActionJournalEntryRecord = {
    ...draft,
    id: `${draft.attemptId}:${draft.action}:${priorEntries.length + 1}`,
  };
  await journal.appendJournalEntry(entry);
  return entry;
}

export class CancelPreparedAttemptUseCase implements CancelPreparedAttemptPort {
  constructor(private readonly deps?: CancelPreparedAttemptDependencies) {}

  async cancelPreparedAttempt(request: CancelPreparedAttemptRequest): Promise<CancelPreparedAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: CancelPreparedAttemptUseCase');
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'refused', reason: 'attempt-missing' };
    }
    if (attempt.state !== 'intent-recorded') {
      return { outcome: 'refused', reason: 'not-prepared' };
    }

    const cancelled: AttemptRecord = {
      ...attempt,
      revision: nextAttemptRevision(attempt),
      state: 'cancelled',
      outcome: 'stopped',
      updatedAtIso: request.nowIso,
    };
    try {
      await this.deps.attemptRepo.saveAttempt(cancelled);
    } catch (error) {
      if (error instanceof AttemptRevisionConflictError) {
        return { outcome: 'refused', reason: 'changed' };
      }
      throw error;
    }

    const held = (await this.deps.journal.listActiveReservations()).some(
      (reservation) => reservation.attemptId === attempt.id && reservation.held,
    );
    let capacity: 'released' | 'none-held' | 'held';
    if (held) {
      const released = await this.deps.journal.releaseCapacityReservation(attempt.id, request.nowIso);
      capacity = released ? 'released' : 'held';
    } else {
      capacity = 'none-held';
    }

    await appendJournalEntry(this.deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'stop',
      baseCommit: attempt.baseCommit,
      recordedAtIso: request.nowIso,
      status: 'completed',
      sessionId: null,
      detail: 'Record-only cancel of an attempt that was never dispatched; capacity ' + capacity,
    });

    return { outcome: 'cancelled', attempt: cancelled, capacity };
  }
}
