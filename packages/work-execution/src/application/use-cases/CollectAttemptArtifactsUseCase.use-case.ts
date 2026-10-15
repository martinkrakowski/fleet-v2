// Implemented for migration step 2 — collect only after authoritative completion.
/**
 * CollectAttemptArtifactsUseCase: after a matching runner completion, inspect
 * the commit delta and collect identity-bound artifacts, recording missing
 * notes explicitly. Only an ended (or already collected) attempt with a
 * matching completion receipt may be collected. No-commit is recorded as a
 * fact, never as success.
 */

import type { ActionJournalEntryRecord, AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptOutcomeValue } from '../../domain/value-objects/AttemptOutcome.vo.js';
import type {
  CollectAttemptArtifactsPort,
  CollectAttemptArtifactsRequest,
  CollectAttemptArtifactsResult,
} from '../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { BriefKnowledgePort } from '../ports/out/BriefKnowledgePort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

export interface CollectAttemptArtifactsDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly artifactPort: AttemptArtifactPort;
  readonly briefKnowledge?: BriefKnowledgePort;
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

export class CollectAttemptArtifactsUseCase implements CollectAttemptArtifactsPort {
  constructor(private readonly deps?: CollectAttemptArtifactsDependencies) {}

  async collectAttemptArtifacts(request: CollectAttemptArtifactsRequest): Promise<CollectAttemptArtifactsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: CollectAttemptArtifactsUseCase');
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'refused', reason: 'Attempt not found' };
    }

    const receiptMatchesSession =
      !attempt.sessionId || request.completionReceipt.sessionId === attempt.sessionId;
    const hasEnded = attempt.state === 'ended' || attempt.state === 'collected';
    if (!hasEnded || request.completionReceipt.attemptId !== attempt.id || !receiptMatchesSession) {
      return { outcome: 'refused', reason: 'Attempt has not ended with a matching completion receipt' };
    }

    const collected = await this.deps.artifactPort.collectCompletedAttemptArtifacts({
      attemptId: request.attemptId,
      worktreePath: request.worktreePath,
      baseCommit: request.baseCommit,
      expectedArtifactPaths: request.expectedArtifacts,
      completionReceipt: request.completionReceipt,
    });
    if (collected.outcome === 'refused') {
      return { outcome: 'refused', reason: collected.reason };
    }

    const outcome: AttemptOutcomeValue = collected.artifacts.commitsSinceBase.length > 0 ? 'done' : 'no-commit';

    const nowIso = new Date().toISOString();
    const collectedAttempt: AttemptRecord = {
      ...attempt,
      state: 'collected',
      outcome,
      artifacts: collected.artifacts,
      updatedAtIso: nowIso,
    };
    await this.deps.attemptRepo.saveAttempt(collectedAttempt);
    // Release is idempotent: false simply means no reservation was held.
    await this.deps.journal.releaseCapacityReservation(attempt.id, nowIso);
    await appendJournalEntry(this.deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'collect',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'completed',
      sessionId: request.completionReceipt.sessionId,
      detail: `Artifacts collected with outcome ${outcome}`,
    });
    return { outcome: 'collected', artifacts: collected.artifacts };
  }

  async execute(input?: unknown): Promise<CollectAttemptArtifactsResult> {
    if (!this.deps || !input || typeof input !== 'object') {
      throw new Error('Not implemented: CollectAttemptArtifactsUseCase');
    }
    return this.collectAttemptArtifacts(input as CollectAttemptArtifactsRequest);
  }
}
