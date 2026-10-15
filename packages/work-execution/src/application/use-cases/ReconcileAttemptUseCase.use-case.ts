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
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';

export interface ReconcileAttemptDependencies {
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

    const nowIso = request.nowIso ?? new Date().toISOString();

    if (!attempt.sessionId) {
      const reconciling: AttemptRecord = { ...attempt, state: 'reconciling', updatedAtIso: nowIso };
      await this.deps.attemptRepo.saveAttempt(reconciling);
      await appendJournalEntry(this.deps.journal, {
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

    const status = await this.deps.runner.inspectSession({
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
    });

    if (status.runnerReachable !== 'reachable') {
      const reconciling: AttemptRecord = { ...attempt, state: 'reconciling', updatedAtIso: nowIso };
      await this.deps.attemptRepo.saveAttempt(reconciling);
      await appendJournalEntry(this.deps.journal, {
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
      receipt.attemptId === attempt.id &&
      receipt.sessionId === attempt.sessionId;

    if (receiptMatches && receipt) {
      const ended: AttemptRecord = {
        ...attempt,
        state: 'ended',
        completionReceipt: receipt,
        updatedAtIso: nowIso,
      };
      await this.deps.attemptRepo.saveAttempt(ended);
      await this.deps.journal.releaseCapacityReservation(attempt.id, nowIso);
      await appendJournalEntry(this.deps.journal, {
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
      const running: AttemptRecord = { ...attempt, state: 'running', updatedAtIso: nowIso };
      await this.deps.attemptRepo.saveAttempt(running);
      await appendJournalEntry(this.deps.journal, {
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

    const reconciling: AttemptRecord = { ...attempt, state: 'reconciling', updatedAtIso: nowIso };
    await this.deps.attemptRepo.saveAttempt(reconciling);
    await appendJournalEntry(this.deps.journal, {
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
