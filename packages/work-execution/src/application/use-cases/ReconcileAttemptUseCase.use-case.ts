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
/**
 * True when `detail` names `sessionId` as a whole token: the id is bounded by
 * the start or end of the text or by a character that cannot be part of a
 * session id, so `ses_a` never matches inside `ses_ab`.
 */
export function detailNamesSession(detail: string, sessionId: string): boolean {
  if (sessionId.length === 0) return false;
  const isIdChar = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
  let from = 0;
  for (;;) {
    const at = detail.indexOf(sessionId, from);
    if (at < 0) return false;
    if (!isIdChar(detail[at - 1]) && !isIdChar(detail[at + sessionId.length])) return true;
    from = at + 1;
  }
}

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
    // is released here for `cancelled`, `collected`, and `ended` with an
    // authoritative completion receipt; the release is a no-op when nothing is
    // held. An `ended` attempt without an authoritative completion receipt
    // refuses before any runner contact, saves nothing, appends no journal
    // entry, and keeps its reservation held. The retry path's own check below
    // stays.
    if (
      attempt.state === 'cancelled' ||
      attempt.state === 'collected' ||
      (attempt.state === 'ended' && attempt.completionReceipt?.authoritative === true)
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
    if (attempt.state === 'ended') {
      return {
        outcome: 'refused',
        reason: `Attempt ${attempt.id} ended without an authoritative completion receipt and cannot be reconciled; its reservation stays held`,
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
        const observedId = worktreeState.sessionId;
        // Adoption has an ownership check (brief-fix2 item 2b): the id is
        // adopted only when this attempt's own history named it — a journal
        // entry for this attempt with sessionId === id, or an ambiguous
        // DISPATCH entry whose detail names the id as a whole token (how an
        // ambiguous start records the session it may have created). Reconcile
        // and stop entries never name: a refusal below writes the id into its
        // own detail, and that must not make the next reconcile adopt it. An
        // id that appears only in a blocked entry's observedSessionIds is
        // evidence, never proof, and never names. The agy runner reports only
        // that a lane runs and derives a synthetic id from the attempt id, so
        // that id is never adoptable.
        const syntheticAgyId = `agy-${attempt.id}`;
        let refusalReason: string | undefined;
        if (observedId.length === 0) {
          refusalReason = `Worktree runs a lane that reports no session id, which attempt ${attempt.id} cannot adopt; run 'attempt stop' to abort it`;
        } else if (observedId === syntheticAgyId) {
          refusalReason = `Worktree runs session ${observedId}, which attempt ${attempt.id} never started; run 'attempt stop' to abort it`;
        } else {
          const history = await deps.journal.listJournalEntriesForAttempt(attempt.id);
          const namedByHistory =
            history.some((entry) => entry.sessionId === observedId) ||
            history.some(
              (entry) =>
                entry.action === 'dispatch' &&
                entry.status === 'ambiguous' &&
                entry.detail !== null &&
                detailNamesSession(entry.detail, observedId),
            );
          if (!namedByHistory) {
            refusalReason = `Worktree runs session ${observedId}, which attempt ${attempt.id} never started; run 'attempt stop' to abort it`;
          }
        }
        if (refusalReason !== undefined) {
          // Not adoptable: no save, the reservation stays held, and the
          // operator is pointed at 'attempt stop'.
          await appendJournalEntry(deps.journal, {
            attemptId: attempt.id,
            workOrderId: attempt.workOrderId,
            action: 'reconcile',
            baseCommit: attempt.baseCommit,
            recordedAtIso: nowIso,
            status: 'ambiguous',
            sessionId: null,
            detail: refusalReason,
          });
          return { outcome: 'unknown', attempt, reason: refusalReason };
        }
        const running: AttemptRecord = {
          ...attempt,
          revision: nextAttemptRevision(attempt),
          state: 'running',
          sessionId: observedId,
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
          sessionId: observedId,
          detail: `${stateLabel} attempt adopted the session running in its worktree: ${observedId}`,
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
