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
  AttemptRevisionConflictError,
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

    return this.stopAttemptOnce(request, attempt, false);
  }

  /**
   * Run the stop decision on one recorded attempt, at most twice. A stale
   * write throws `AttemptRevisionConflictError`, handled here: the attempt is
   * re-read once and the decision runs again on the fresh record (terminal
   * states are already refused at the top of the decision). A second conflict
   * propagates.
   */
  private async stopAttemptOnce(
    request: StopAttemptRequest,
    attempt: AttemptRecord,
    retried: boolean,
  ): Promise<StopAttemptResult> {
    const deps = this.deps!;
    try {
      // The private method is self-contained: it is called from the public
      // wrapper after the same guard, and again after a conflict re-read.
      if (!attempt.sessionId) {
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
    let runner: ExecutionRunnerPort = deps.runner;
    if (deps.runnerForAttempt) {
      const selection = deps.runnerForAttempt.runnerForAttempt({
        runner: attempt.runner ?? null,
      });
      if (!selection.ok) {
        return { outcome: 'refused', reason: selection.reason };
      }
      runner = selection.runner;
    }

    await appendJournalEntry(deps.journal, {
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
      await deps.attemptRepo.saveAttempt(cancelled);
      const capacityReleased = await deps.journal.releaseCapacityReservation(attempt.id, nowIso);
      await appendJournalEntry(deps.journal, {
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
      await appendJournalEntry(deps.journal, {
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
      await appendJournalEntry(deps.journal, {
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
    await deps.attemptRepo.saveAttempt(reconciling);
    const failureReason =
      (stopResult as { reason?: string }).reason ?? 'Termination receipt was not authoritative';
    await appendJournalEntry(deps.journal, {
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
    } catch (error) {
      if (error instanceof AttemptRevisionConflictError) {
        if (retried) {
          throw error;
        }
        const fresh = await deps.attemptRepo.findAttemptById(request.attemptId);
        if (!fresh || !fresh.sessionId) {
          return { outcome: 'refused', reason: 'Attempt not found or has no sessionId' };
        }
        return this.stopAttemptOnce(request, fresh, true);
      }
      throw error;
    }
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
