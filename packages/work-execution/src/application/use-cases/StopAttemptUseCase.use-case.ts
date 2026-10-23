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
import {
  nextAttemptRevision,
  type AttemptRepositoryPort,
} from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';

export interface StopAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly runner: ExecutionRunnerPort;
  /**
   * Optional (H9b1). When given, an attempt whose recorded host changed or
   * was removed is refused, naming the recorded host, before any intent is
   * recorded or subprocess runs. Without it the behaviour is unchanged.
   */
  readonly runnerForAttempt?: RunnerForAttemptPort;
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

    // Resolve the runner through the attempt's recorded host (H9b1). A
    // recorded host that changed or was removed refuses before any journal
    // intent or subprocess; the reason names the recorded host.
    let runner: ExecutionRunnerPort = this.deps.runner;
    if (this.deps.runnerForAttempt) {
      const selection = this.deps.runnerForAttempt.runnerForAttempt({
        runner: attempt.runner ?? null,
      });
      if (!selection.ok) {
        return { outcome: 'refused', reason: selection.reason };
      }
      runner = selection.runner;
    }

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

    const stopResult = await runner.stopSession({
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      worktreePath: attempt.worktreePath,
      runner: attempt.runner,
      gracePeriodSeconds: request.gracePeriodSeconds ?? 10,
    });

    if (stopResult.outcome === 'terminated' && stopResult.receipt.authoritative === true) {
      const cancelled: AttemptRecord = {
        ...attempt,
        revision: nextAttemptRevision(attempt),
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

    if (stopResult.outcome === 'refused') {
      await appendJournalEntry(this.deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'stop',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'refused',
        sessionId: attempt.sessionId,
        detail: stopResult.reason,
      });
      return { outcome: 'refused', reason: stopResult.reason };
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

    const reconciling: AttemptRecord = {
      ...attempt,
      revision: nextAttemptRevision(attempt),
      state: 'reconciling',
      updatedAtIso: nowIso,
    };
    await this.deps.attemptRepo.saveAttempt(reconciling);
    const failureReason =
      (stopResult as { reason?: string }).reason ?? 'Termination receipt was not authoritative';
    await appendJournalEntry(this.deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'stop',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'ambiguous',
      sessionId: attempt.sessionId,
      detail: failureReason,
    });
    return { outcome: 'unknown', attempt: reconciling, reason: failureReason };
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
