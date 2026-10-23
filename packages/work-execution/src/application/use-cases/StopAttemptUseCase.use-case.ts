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
  canOverwriteAfterConflict,
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

/**
 * A record that already reached a state the stop decision cannot improve on:
 * cancelled, collected, or ended with an authoritative receipt.
 */
function isTerminalAttempt(record: AttemptRecord): boolean {
  return (
    record.state === 'cancelled' ||
    record.state === 'collected' ||
    (record.state === 'ended' && record.completionReceipt?.authoritative === true)
  );
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

    return this.stopAttemptOnce(request, attempt);
  }

  /**
   * Run the stop decision on one recorded attempt, exactly once. A conflict
   * on a save that follows the runner side effect never re-runs the decision
   * or `stopSession`: the fresh record is re-read once, the same transition
   * is rebuilt on top of it (or skipped when the fresh record is already
   * terminal), and a second conflict propagates.
   */
  private async stopAttemptOnce(
    request: StopAttemptRequest,
    attempt: AttemptRecord,
  ): Promise<StopAttemptResult> {
    const deps = this.deps!;
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
      const { record: cancelled, ownsReservation } = await this.saveCancelledOrSkip(
        attempt,
        stopResult.receipt,
        nowIso,
      );
      // Capacity release and the completion entry run after a terminated
      // stop whether the save went in on the first try, went in on the
      // rebuilt record, or was skipped as already terminal. The one exception:
      // the fresh record holds a different session (a re-dispatch), whose
      // reservation is not this stop's to release.
      const capacityReleased = ownsReservation
        ? await deps.journal.releaseCapacityReservation(attempt.id, nowIso)
        : false;
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

    const reconciling = await this.saveReconcilingOrSkip(attempt, nowIso);
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
  }

  /**
   * Save the `cancelled` transition after a terminated stop. On a revision
   * conflict the fresh record is re-read once: a terminal fresh record skips
   * the save, otherwise the same transition is rebuilt on top of the fresh
   * record and saved once. A second conflict propagates.
   */
  private async saveCancelledOrSkip(
    attempt: AttemptRecord,
    receipt: NonNullable<AttemptRecord['completionReceipt']>,
    nowIso: string,
  ): Promise<{ readonly record: AttemptRecord; readonly ownsReservation: boolean }> {
    const build = (base: AttemptRecord): AttemptRecord => ({
      ...base,
      revision: nextAttemptRevision(base),
      state: 'cancelled',
      outcome: 'stopped',
      completionReceipt: receipt,
      updatedAtIso: nowIso,
    });
    try {
      const cancelled = build(attempt);
      await this.deps!.attemptRepo.saveAttempt(cancelled);
      return { record: cancelled, ownsReservation: true };
    } catch (error) {
      if (!(error instanceof AttemptRevisionConflictError)) {
        throw error;
      }
      const fresh = await this.deps!.attemptRepo.findAttemptById(attempt.id);
      if (fresh && isTerminalAttempt(fresh)) {
        return { record: fresh, ownsReservation: true };
      }
      if (fresh && fresh.sessionId !== null && fresh.sessionId !== attempt.sessionId) {
        // A re-dispatch recorded another live session: the stopped session's
        // receipt never lands on it and its reservation is left alone.
        return { record: fresh, ownsReservation: false };
      }
      const rebuilt = build(fresh ?? attempt);
      await this.deps!.attemptRepo.saveAttempt(rebuilt);
      return { record: rebuilt, ownsReservation: true };
    }
  }

  /**
   * Save the `reconciling` transition after a non-authoritative stop. On a
   * revision conflict the fresh record is re-read once: `reconciling` is
   * rebuilt only when the fresh record is still `running`, `reconciling` or
   * `dispatching` (a vanished record rebuilds from the pre-conflict record).
   * Any `ended` — authoritative or not — plus `cancelled` and `collected`,
   * is someone else's move: the save is skipped and the fresh record is
   * returned untouched. A second conflict propagates.
   */
  private async saveReconcilingOrSkip(attempt: AttemptRecord, nowIso: string): Promise<AttemptRecord> {
    const build = (base: AttemptRecord): AttemptRecord => ({
      ...base,
      revision: nextAttemptRevision(base),
      state: 'reconciling',
      updatedAtIso: nowIso,
    });
    try {
      const reconciling = build(attempt);
      await this.deps!.attemptRepo.saveAttempt(reconciling);
      return reconciling;
    } catch (error) {
      if (!(error instanceof AttemptRevisionConflictError)) {
        throw error;
      }
      const fresh = await this.deps!.attemptRepo.findAttemptById(attempt.id);
      if (fresh && !canOverwriteAfterConflict(fresh, ['running', 'reconciling', 'dispatching'])) {
        return fresh;
      }
      const rebuilt = build(fresh ?? attempt);
      await this.deps!.attemptRepo.saveAttempt(rebuilt);
      return rebuilt;
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
