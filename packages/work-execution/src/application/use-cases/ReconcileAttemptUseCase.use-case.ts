// Implemented for migration step 2 — reconcile before retry, collection or release.
/**
 * ReconcileAttemptUseCase: compare durable action intent with the matching
 * runner session before any retry, collection or reservation release. Only a
 * reachable runner, an ended worker command and a matching completion receipt
 * establish the end; unknown stays unknown, never becomes ended and never
 * frees capacity.
 */

import type { ActionJournalEntryRecord, AttemptRecord } from '../../domain/execution-records.js';
import type {
  ReconcileAttemptPort,
  ReconcileAttemptRequest,
  ReconcileAttemptResult,
} from '../ports/in/ReconcileAttemptPort.in-port.js';
import {
  AttemptRevisionConflictError,
  nextAttemptRevision,
  type AttemptRepositoryPort,
} from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';

export interface ReconcileAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly runner: ExecutionRunnerPort;
  /**
   * Optional (H9b1). When given, an attempt whose recorded host changed or
   * was removed refuses, naming the recorded host, before any state change.
   * Without it the behaviour is unchanged.
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

export class ReconcileAttemptUseCase implements ReconcileAttemptPort {
  constructor(private readonly deps?: ReconcileAttemptDependencies) {}

  async reconcileAttempt(request: ReconcileAttemptRequest): Promise<ReconcileAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReconcileAttemptUseCase');
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'not-found', attemptId: request.attemptId };
    }

    return this.reconcileAttemptOnce(request, attempt, false);
  }

  /**
   * Run the reconcile decision on one recorded attempt, at most twice. A
   * stale write throws `AttemptRevisionConflictError`, handled here: the
   * attempt is re-read once and the decision runs again on the fresh record.
   * On the retry a fresh terminal state (cancelled, collected or ended)
   * writes nothing and refuses; a second conflict propagates.
   */
  private async reconcileAttemptOnce(
    request: ReconcileAttemptRequest,
    attempt: AttemptRecord,
    retried: boolean,
  ): Promise<ReconcileAttemptResult> {
    const deps = this.deps!;
    try {
      const nowIso = request.nowIso ?? new Date().toISOString();

    // A terminal attempt is already resolved (minor 7): reconciling it could
    // write it back into a claiming state. Refuse before any runner contact
    // or attempt change. A crash between saving a terminal record and
    // releasing its capacity reservation (the blocked-idle path below, or the
    // `ended` path) would otherwise leave the reservation held forever, so it
    // is released here; the release is a no-op when nothing is held. The
    // retry path's own check below stays.
    if (
      attempt.state === 'cancelled' ||
      attempt.state === 'collected' ||
      attempt.state === 'ended'
    ) {
      const released = await deps.journal.releaseCapacityReservation(attempt.id, nowIso);
      if (released) {
        await appendJournalEntry(deps.journal, {
          attemptId: attempt.id,
          workOrderId: attempt.workOrderId,
          action: 'reconcile',
          baseCommit: attempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'completed',
          sessionId: attempt.sessionId ?? null,
          detail: `Released a capacity reservation still held by terminal attempt (${attempt.state})`,
        });
      }
      return {
        outcome: 'refused',
        reason: `Attempt ${attempt.id} is in terminal state '${attempt.state}' and cannot be reconciled${
          released ? '; a reservation it still held was released' : ''
        }`,
      };
    }

    // Resolve the runner through the attempt's recorded host (H9b1). A
    // recorded host that changed or was removed refuses, naming the recorded
    // host, before any state change or runner contact.
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

    // A session-less attempt in a claiming state (dispatching, reconciling,
    // blocked) keeps its reservation; the worktree may still be running a
    // lane. Resolve it by directory, not by session id. A session-less
    // `intent-recorded` attempt keeps the fallback below.
    if (
      !attempt.sessionId &&
      (attempt.state === 'dispatching' || attempt.state === 'reconciling' || attempt.state === 'blocked')
    ) {
      if (!runner.inspectWorktreeRun) {
        return {
          outcome: 'unknown',
          attempt,
          reason: 'Runner cannot inspect a worktree without a session',
        };
      }
      const worktreeState = await runner.inspectWorktreeRun({
        attemptId: attempt.id,
        worktreePath: attempt.worktreePath,
        runner: attempt.runner,
      });
      // Journal details and result reasons name the actual state, not always
      // 'blocked' (brief-fix2 item 1a).
      const stateLabel = `${attempt.state[0]!.toUpperCase()}${attempt.state.slice(1)}`;

      if (worktreeState.state === 'idle') {
        const cancelled: AttemptRecord = {
          ...attempt,
          revision: nextAttemptRevision(attempt),
          state: 'cancelled',
          outcome: 'stopped',
          updatedAtIso: nowIso,
        };
        await deps.attemptRepo.saveAttempt(cancelled);
        await deps.journal.releaseCapacityReservation(attempt.id, nowIso);
        await appendJournalEntry(deps.journal, {
          attemptId: attempt.id,
          workOrderId: attempt.workOrderId,
          action: 'reconcile',
          baseCommit: attempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'completed',
          sessionId: null,
          detail: `Nothing runs in the ${attempt.state} attempt's worktree; cancelled and capacity released`,
        });
        return {
          outcome: 'cancelled',
          attempt: cancelled,
          reason: `Nothing runs in the ${attempt.state} attempt's worktree; cancelled and capacity released`,
        };
      }

      if (worktreeState.state === 'running') {
        const running: AttemptRecord = {
          ...attempt,
          revision: nextAttemptRevision(attempt),
          state: 'running',
          sessionId: worktreeState.sessionId,
          updatedAtIso: nowIso,
        };
        await deps.attemptRepo.saveAttempt(running);
        await appendJournalEntry(deps.journal, {
          attemptId: attempt.id,
          workOrderId: attempt.workOrderId,
          action: 'reconcile',
          baseCommit: attempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'completed',
          sessionId: worktreeState.sessionId,
          detail: `${stateLabel} attempt adopted the session running in its worktree: ${worktreeState.sessionId}`,
        });
        return {
          outcome: 'active',
          attempt: running,
          status: {
            runnerReachable: 'reachable',
            workspacePreparation: 'prepared',
            workerCommand: 'active',
            completionReceipt: null,
            artifactsCollected: false,
          },
        };
      }

      // unknown: nothing is established, so nothing is written and the
      // reservation stays held.
      await appendJournalEntry(deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'reconcile',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: null,
        detail: worktreeState.reason,
      });
      return { outcome: 'unknown', attempt, reason: worktreeState.reason };
    }

    if (!attempt.sessionId) {
      const reconciling: AttemptRecord = {
        ...attempt,
        revision: nextAttemptRevision(attempt),
        state: 'reconciling',
        updatedAtIso: nowIso,
      };
      await deps.attemptRepo.saveAttempt(reconciling);
      await appendJournalEntry(deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'reconcile',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: null,
        detail: 'No sessionId recorded for attempt',
      });
      return { outcome: 'unknown', attempt: reconciling, reason: 'No sessionId recorded for attempt' };
    }

    const status = await runner.inspectSession({
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      worktreePath: attempt.worktreePath,
      runner: attempt.runner,
    });

    if (status.runnerReachable !== 'reachable') {
      const reconciling: AttemptRecord = {
        ...attempt,
        revision: nextAttemptRevision(attempt),
        state: 'reconciling',
        updatedAtIso: nowIso,
      };
      await deps.attemptRepo.saveAttempt(reconciling);
      await appendJournalEntry(deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'reconcile',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: attempt.sessionId,
        detail: `Runner reachability is ${status.runnerReachable}`,
      });
      return {
        outcome: 'unknown',
        attempt: reconciling,
        reason: `Runner reachability is ${status.runnerReachable}`,
      };
    }

    const receipt = status.completionReceipt;
    const receiptMatches =
      status.workerCommand === 'ended' &&
      receipt !== null &&
      receipt.authoritative === true &&
      receipt.attemptId === attempt.id &&
      receipt.sessionId === attempt.sessionId;

    if (receiptMatches && receipt) {
      const ended: AttemptRecord = {
        ...attempt,
        revision: nextAttemptRevision(attempt),
        state: 'ended',
        completionReceipt: receipt,
        updatedAtIso: nowIso,
      };
      await deps.attemptRepo.saveAttempt(ended);
      await deps.journal.releaseCapacityReservation(attempt.id, nowIso);
      await appendJournalEntry(deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'reconcile',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'completed',
        sessionId: attempt.sessionId,
        detail: 'Authoritative completion receipt matched',
      });
      return { outcome: 'ended', attempt: ended, receipt };
    }

    if (status.workerCommand === 'active') {
      const running: AttemptRecord = {
        ...attempt,
        revision: nextAttemptRevision(attempt),
        state: 'running',
        updatedAtIso: nowIso,
      };
      await deps.attemptRepo.saveAttempt(running);
      await appendJournalEntry(deps.journal, {
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'reconcile',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'completed',
        sessionId: attempt.sessionId,
        detail: 'Worker command still active',
      });
      return { outcome: 'active', attempt: running, status };
    }

    const reconciling: AttemptRecord = {
      ...attempt,
      revision: nextAttemptRevision(attempt),
      state: 'reconciling',
      updatedAtIso: nowIso,
    };
    await deps.attemptRepo.saveAttempt(reconciling);
    await appendJournalEntry(deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'reconcile',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'ambiguous',
      sessionId: attempt.sessionId,
      detail: 'Ambiguous worker command state or mismatched receipt',
    });
    return {
      outcome: 'unknown',
      attempt: reconciling,
      reason: 'Ambiguous worker command state or mismatched receipt',
    };
    } catch (error) {
      if (error instanceof AttemptRevisionConflictError) {
        if (retried) {
          throw error;
        }
        const fresh = await deps.attemptRepo.findAttemptById(request.attemptId);
        if (!fresh) {
          return { outcome: 'not-found', attemptId: request.attemptId };
        }
        if (
          fresh.state === 'cancelled' ||
          fresh.state === 'collected' ||
          fresh.state === 'ended'
        ) {
          return {
            outcome: 'refused',
            reason: `Attempt ${fresh.id} changed to ${fresh.state} while reconciling`,
          };
        }
        return this.reconcileAttemptOnce(request, fresh, true);
      }
      throw error;
    }
  }

  async execute(input?: unknown): Promise<ReconcileAttemptResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ReconcileAttemptUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a not-found.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: ReconcileAttemptUseCase');
    }
    return this.reconcileAttempt(input as ReconcileAttemptRequest);
  }
}
