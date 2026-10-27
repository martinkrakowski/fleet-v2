// Implemented for migration step 2 — collect only after authoritative completion.
/**
 * CollectAttemptArtifactsUseCase: after a matching runner completion, inspect
 * the commit delta and collect identity-bound artifacts, recording missing
 * notes explicitly. Only an ended (or already collected) attempt with a
 * matching completion receipt may be collected. No-commit is recorded as a
 * fact, never as success.
 */

import type { ActionJournalEntryRecord, AttemptRecord, AttemptUsageRecord } from '../../domain/execution-records.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
import type { AttemptOutcomeValue } from '../../domain/value-objects/AttemptOutcome.vo.js';
import type { StopReasonValue } from '../../domain/value-objects/StopReason.vo.js';
import type {
  CollectAttemptArtifactsPort,
  CollectAttemptArtifactsRequest,
  CollectAttemptArtifactsResult,
} from '../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import {
  AttemptRevisionConflictError,
  nextAttemptRevision,
  type AttemptRepositoryPort,
} from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { BriefKnowledgePort } from '../ports/out/BriefKnowledgePort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { ReadUsageResult, UsagePort } from '../ports/out/UsagePort.out-port.js';

export interface CollectAttemptArtifactsDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly artifactPort: AttemptArtifactPort;
  readonly briefKnowledge?: BriefKnowledgePort;
  /**
   * Optional (H9b1). When given, an attempt whose recorded host changed or
   * was removed is refused, naming the recorded host. Without it the
   * behaviour is unchanged.
   */
  readonly runnerForAttempt?: RunnerForAttemptPort;
  /**
   * Optional (S3). When given, the attempt's opencode session usage is read
   * and stored on the collected record. A usage failure never changes the
   * collection outcome.
   */
  readonly usage?: UsagePort;
}

/**
 * The unavailable usage record stored when the usage read itself fails (the
 * port contract already returns `unavailable` for business failures; this is
 * only a defensive fallback so collection never changes because of usage).
 */
function unavailableUsage(
  attempt: AttemptRecord,
  nowIso: string,
  reason: string,
): AttemptUsageRecord {
  return {
    source: 'unavailable',
    readAtIso: nowIso,
    sessionId: attempt.sessionId,
    steps: null,
    wallSeconds: null,
    tokensInput: null,
    tokensOutput: null,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costUsd: null,
    model: null,
    agent: null,
    reason,
  };
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

    // Request-validation entry check: every expected-artifact path must be a
    // contained worktree-relative path, refused here before any collection.
    for (const artifact of request.expectedArtifacts ?? []) {
      const refusedReason = validateWorktreeRelativePath(artifact);
      if (refusedReason !== null) {
        return {
          outcome: 'refused',
          reason: `expectedArtifacts entry '${String(artifact)}' is refused: ${refusedReason}`,
        };
      }
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

    if (request.worktreePath !== undefined && request.worktreePath !== attempt.worktreePath) {
      return { outcome: 'refused', reason: 'worktreePath differs from recorded attempt' };
    }
    if (request.baseCommit !== undefined && request.baseCommit !== attempt.baseCommit) {
      return { outcome: 'refused', reason: 'baseCommit differs from recorded attempt' };
    }

    if (this.deps.runnerForAttempt) {
      // The recorded host is the truth: a recorded host that changed or was
      // removed refuses, naming the recorded host.
      const selection = this.deps.runnerForAttempt.runnerForAttempt({
        runner: attempt.runner ?? null,
      });
      if (!selection.ok) {
        return { outcome: 'refused', reason: selection.reason };
      }
    }

    const collected = await this.deps.artifactPort.collectCompletedAttemptArtifacts({
      attemptId: request.attemptId,
      worktreePath: attempt.worktreePath,
      baseCommit: attempt.baseCommit,
      expectedArtifactPaths: request.expectedArtifacts,
      completionReceipt: request.completionReceipt,
      // H9b2: the artifact read runs on the attempt's recorded host.
      recordedHost: attempt.runner ?? null,
    });
    if (collected.outcome === 'refused') {
      return { outcome: 'refused', reason: collected.reason };
    }

    // C1: seal the collected files in an atomically written, content-addressed
    // manifest before the attempt is recorded as collected. A port that cannot
    // seal leaves the record without `manifestPath` and `manifestSha256`
    // (older records that lack `manifestPath` are read as "artifacts not
    // collected" for C2); a refused seal refuses collection.
    let artifacts = collected.artifacts;
    if (this.deps.artifactPort.sealArtifactManifest) {
      const sealed = await this.deps.artifactPort.sealArtifactManifest({
        attemptId: attempt.id,
        worktreePath: attempt.worktreePath,
        artifactPaths: collected.artifacts.collectedArtifactPaths,
        recordedHost: attempt.runner ?? null,
      });
      if (sealed.outcome === 'refused') {
        return { outcome: 'refused', reason: 'Artifact manifest not sealed: ' + sealed.reason };
      }
      artifacts = {
        ...collected.artifacts,
        manifestPath: sealed.manifestPath,
        manifestSha256: sealed.manifestSha256,
      };
    }

    const outcome: AttemptOutcomeValue = collected.artifacts.commitsSinceBase.length > 0 ? 'done' : 'no-commit';
    // S1: no commit is a stop reason a fallback seat may wait for.
    const stopReason: StopReasonValue = outcome === 'no-commit' ? 'no-commit' : 'none';

    const nowIso = new Date().toISOString();
    // S3: read the attempt's opencode session usage when a usage port is
    // wired. A usage failure never changes the collection outcome. Both arms
    // carry a usage record; absent `deps.usage` leaves the record untouched.
    let usageResult: ReadUsageResult | undefined;
    if (this.deps.usage) {
      try {
        usageResult = await this.deps.usage.readUsage({ attempt });
      } catch {
        usageResult = {
          outcome: 'unavailable',
          usage: unavailableUsage(attempt, nowIso, 'usage read failed'),
        };
      }
    }

    const collectedAttempt: AttemptRecord = {
      ...attempt,
      revision: nextAttemptRevision(attempt),
      state: 'collected',
      outcome,
      stopReason,
      artifacts,
      ...(usageResult !== undefined ? { usage: usageResult.usage } : {}),
      updatedAtIso: nowIso,
    };
    try {
      await this.deps.attemptRepo.saveAttempt(collectedAttempt);
    } catch (error) {
      if (error instanceof AttemptRevisionConflictError) {
        // Never redo collection: re-read once. If the fresh record is still
        // `ended`, rebuild the same `collected` transition on top of it with
        // the artifacts and usage already gathered and save once (a second
        // conflict propagates); release and the journal entry still run.
        // Any other fresh state keeps the refusal naming that state; a losing
        // concurrent collection's content-addressed manifest file in `.lane/`
        // is harmless and never overwrites the winner's manifest.
        const fresh = await this.deps.attemptRepo.findAttemptById(attempt.id);
        if (fresh?.state !== 'ended') {
          return {
            outcome: 'refused',
            reason: `Attempt ${attempt.id} changed to ${fresh?.state ?? 'unknown'} while collecting artifacts`,
          };
        }
        const rebuilt: AttemptRecord = {
          ...fresh,
          revision: nextAttemptRevision(fresh),
          state: 'collected',
          outcome,
          stopReason,
          artifacts,
          ...(usageResult !== undefined ? { usage: usageResult.usage } : {}),
          updatedAtIso: nowIso,
        };
        await this.deps.attemptRepo.saveAttempt(rebuilt);
      } else {
        throw error;
      }
    }
    // Release is idempotent: false simply means no reservation was held.
    await this.deps.journal.releaseCapacityReservation(attempt.id, nowIso);
    const usageDetail =
      usageResult === undefined
        ? `Artifacts collected with outcome ${outcome}`
        : usageResult.outcome === 'read'
          ? 'usage read'
          : `usage unavailable: ${usageResult.usage.reason}`;
    await appendJournalEntry(this.deps.journal, {
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'collect',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'completed',
      sessionId: request.completionReceipt.sessionId,
      detail: usageDetail,
    });
    return { outcome: 'collected', artifacts };
  }

  async execute(input?: unknown): Promise<CollectAttemptArtifactsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: CollectAttemptArtifactsUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: CollectAttemptArtifactsUseCase');
    }
    return this.collectAttemptArtifacts(input as CollectAttemptArtifactsRequest);
  }
}
