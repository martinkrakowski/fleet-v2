// Implemented for migration step 2 — stop before release, never assume the end.
/**
 * StopAttemptUseCase: request cancellation of the identified runner session
 * and establish its actual end before releasing capacity. A still-running or
 * unknown session keeps its reservation; capacity is released only on a
 * confirmed termination receipt. Stopped sessions may hold partial useful
 * work; the outcome is recorded as stopped, never as success.
 */

import type { ActionJournalEntryRecord, AttemptRecord } from '../../domain/execution-records.js';
import type { StopAttemptPort, StopAttemptRequest, StopAttemptResult } from '../ports/in/StopAttemptPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';

export interface StopAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly runner: ExecutionRunnerPort;
}

type JournalEntryDraft = Omit<ActionJournalEntryRecord, 'id'>;

/** Append one journal entry with an identity derived from the attempt's history. */
async function appendJournalEntry(
  journal: ExecutionJournalPort,
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

export class StopAttemptUseCase implements StopAttemptPort {
  constructor(private readonly deps?: StopAttemptDependencies) {}

  async stopAttempt(request: StopAttemptRequest): Promise<StopAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: StopAttemptUseCase');
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt || !attempt.sessionId) {
      return { outcome: 'refused', reason: 'Attempt not found or has no sessionId' };
    }

    if (
      attempt.state === 'collected' ||
      attempt.state === 'cancelled' ||
      (attempt.state === 'ended' && attempt.completionReceipt?.authoritative === true)
    ) {
      return {
        outcome: 'refused',
        reason: `Attempt ${attempt.id} is in terminal state '${attempt.state}' and cannot be stopped`,
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();

    await appendJournalEntry(this.deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'stop',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'intent-recorded',
      sessionId: attempt.sessionId,
      detail: 'Stop intent recorded before cancellation request',
    });

    const stopResult = await this.deps.runner.stopSession({
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      worktreePath: attempt.worktreePath,
      gracePeriodSeconds: request.gracePeriodSeconds ?? 10,
    });

    if (stopResult.outcome === 'terminated') {
      const cancelled: AttemptRecord = {
        ...attempt,
        state: 'cancelled',
        outcome: 'stopped',
        completionReceipt: stopResult.receipt,
        updatedAtIso: nowIso,
      };
      await this.deps.attemptRepo.saveAttempt(cancelled);
      const capacityReleased = await this.deps.journal.releaseCapacityReservation(attempt.id, nowIso);
      await appendJournalEntry(this.deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'stop',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'completed',
        sessionId: attempt.sessionId,
        detail: 'Session terminated and termination receipt recorded',
      });
      return {
        outcome: 'terminated',
        attempt: cancelled,
        receipt: stopResult.receipt,
        capacityReleased,
      };
    }

    if (stopResult.outcome === 'still-running') {
      // Capacity stays held until the session's actual end is established.
      await appendJournalEntry(this.deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'stop',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: attempt.sessionId,
        detail: stopResult.reason,
      });
      return { outcome: 'still-running', attempt, reason: stopResult.reason };
    }

    const reconciling: AttemptRecord = { ...attempt, state: 'reconciling', updatedAtIso: nowIso };
    await this.deps.attemptRepo.saveAttempt(reconciling);
    await appendJournalEntry(this.deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'stop',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'ambiguous',
      sessionId: attempt.sessionId,
      detail: stopResult.reason,
    });
    return { outcome: 'unknown', attempt: reconciling, reason: stopResult.reason };
  }

  async execute(input?: unknown): Promise<StopAttemptResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: StopAttemptUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: StopAttemptUseCase');
    }
    return this.stopAttempt(input as StopAttemptRequest);
  }
}
