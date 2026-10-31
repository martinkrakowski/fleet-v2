// @generated use-case scaffold — refined for EX-4.
/**
 * ReapOrphanSessionsUseCase: on the operator's explicit request, find lane
 * sessions that outlived their attempt. A candidate is a worktree whose every
 * attempt is finished (cancelled, collected or ended) and none of whose
 * attempts holds a reservation, but where the runner still reports a running
 * session. Those are listed as orphans; on explicit request (not a dry run)
 * each is aborted by directory only, one at a time, with a 10-second grace —
 * never a git command, never a deleted session record, worktree, branch or
 * run. Unknown runner state is reported and never acted on.
 */

import type { AttemptRecord } from '../../domain/execution-records.js';
import { conductedRunnerOf } from './advance-lane-run/conducted-host.js';
import type {
  ReapOrphanFailedEntry,
  ReapOrphanSessionEntry,
  ReapOrphanSessionsPort,
  ReapOrphanSessionsRequest,
  ReapOrphanSessionsResult,
  ReapOrphanUnknownEntry,
} from '../ports/in/ReapOrphanSessionsPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  AbortWorktreeRunResult,
  WorktreeRunState,
} from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';

/** The states of a finished attempt; any other state means the worktree is live. */
const FINISHED_ATTEMPT_STATES = new Set(['cancelled', 'collected', 'ended']);

/** Every reason the reap can skip a worktree with. */
type ReapOrphanSkippedReason = 'attempt-live' | 'slot-held' | 'no-runner' | 'became-live';

/** The reads and writes the reap needs; narrowed so composition supplies only what it has. */
export interface ReapOrphanSessionsDependencies {
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAllAttempts'>;
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations'>;
  /**
   * Resolves the runner addressed by an attempt's recorded host (H9b1).
   * Absent (or a refusal naming the recorded host) skips the worktree
   * `no-runner`; a default runner is never used.
   */
  readonly runnerForAttempt?: RunnerForAttemptPort;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Oldest first; the latest attempt of a worktree is the last after this sort. */
function byOldestFirst(a: AttemptRecord, b: AttemptRecord): number {
  return a.createdAtIso.localeCompare(b.createdAtIso) || byCodeUnit(a.id, b.id);
}

export class ReapOrphanSessionsUseCase implements ReapOrphanSessionsPort {
  constructor(private readonly deps?: ReapOrphanSessionsDependencies) {}

  async execute(input: unknown): Promise<ReapOrphanSessionsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapOrphanSessionsUseCase');
    }
    const request = (input ?? {}) as ReapOrphanSessionsRequest;
    return this.reapOrphanSessions(request);
  }

  async reapOrphanSessions(request: ReapOrphanSessionsRequest): Promise<ReapOrphanSessionsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapOrphanSessionsUseCase');
    }
    // Fail safe: only an explicit `dryRun: false` aborts anything; a missing
    // or malformed value (an unchecked `execute` input) is a dry run.
    const dryRun = request.dryRun !== false;

    const attempts = await this.deps.attemptRepo.listAllAttempts();
    const heldAttemptIds = new Set(
      (await this.deps.executionJournal.listActiveReservations())
        .filter((reservation) => reservation.held)
        .map((reservation) => reservation.attemptId),
    );

    const orphans: ReapOrphanSessionEntry[] = [];
    const aborted: { readonly worktreePath: string }[] = [];
    const failed: ReapOrphanFailedEntry[] = [];
    const skipped: { readonly worktreePath: string; readonly reason: ReapOrphanSkippedReason }[] = [];
    const unknown: ReapOrphanUnknownEntry[] = [];

    const byWorktree = new Map<string, AttemptRecord[]>();
    for (const attempt of attempts) {
      const group = byWorktree.get(attempt.worktreePath);
      if (group === undefined) {
        byWorktree.set(attempt.worktreePath, [attempt]);
      } else {
        group.push(attempt);
      }
    }

    for (const [worktreePath, group] of byWorktree) {
      // Any attempt on the worktree in a non-finished state means the worktree
      // still has a live attempt; it is never scanned or touched.
      if (group.some((attempt) => !FINISHED_ATTEMPT_STATES.has(attempt.state))) {
        skipped.push({ worktreePath, reason: 'attempt-live' });
        continue;
      }
      // A held reservation on any attempt keeps the worktree off limits.
      if (group.some((attempt) => heldAttemptIds.has(attempt.id))) {
        skipped.push({ worktreePath, reason: 'slot-held' });
        continue;
      }
      // The scanner's population: finished attempts with a recorded host.
      const conducted = group.filter((attempt) => conductedRunnerOf(attempt) !== null);
      let latest: AttemptRecord | undefined;
      for (const attempt of conducted) {
        if (latest === undefined || byOldestFirst(latest, attempt) < 0) {
          latest = attempt;
        }
      }
      if (latest === undefined || this.deps.runnerForAttempt === undefined) {
        skipped.push({ worktreePath, reason: 'no-runner' });
        continue;
      }
      const selection = this.deps.runnerForAttempt.runnerForAttempt({
        runner: latest.runner ?? null,
      });
      if (!selection.ok) {
        skipped.push({ worktreePath, reason: 'no-runner' });
        continue;
      }
      const runner = selection.runner;
      if (runner.inspectWorktreeRun === undefined) {
        skipped.push({ worktreePath, reason: 'no-runner' });
        continue;
      }
      let worktreeState: WorktreeRunState;
      try {
        // Called on the runner, never copied off it: the production adapters
        // read `this`, so an unbound call would throw.
        worktreeState = await runner.inspectWorktreeRun({
          attemptId: latest.id,
          worktreePath,
          runner: latest.runner,
        });
      } catch {
        // A throwing inspect must not end the scan: report it and move on.
        unknown.push({ worktreePath, reason: 'inspect-failed' });
        continue;
      }
      if (worktreeState.state === 'running') {
        const orphan: ReapOrphanSessionEntry = {
          worktreePath,
          attemptId: latest.id,
          sessionId: worktreeState.sessionId,
        };
        orphans.push(orphan);
        if (!dryRun) {
          // Re-read the attempt store and the journal immediately before the
          // abort: the opening snapshot may be stale because an attempt went
          // live, took a reservation, or a new attempt appeared since it was
          // taken. The abort proceeds only when all three still hold for this
          // worktree: every attempt finished, none holds a reservation, and
          // the attempt ids are exactly the first snapshot's.
          // A residual window between this re-read and the abort still
          // remains; it is bounded by the runner's own refusal to abort a
          // session it does not own.
          const reAttempts = await this.deps.attemptRepo.listAllAttempts();
          const reHeldAttemptIds = new Set(
            (await this.deps.executionJournal.listActiveReservations())
              .filter((reservation) => reservation.held)
              .map((reservation) => reservation.attemptId),
          );
          const reGroup = reAttempts.filter((attempt) => attempt.worktreePath === worktreePath);
          const reIds = new Set(reGroup.map((attempt) => attempt.id));
          const stillFinished = reGroup.every((attempt) => FINISHED_ATTEMPT_STATES.has(attempt.state));
          const stillUnheld = reGroup.every((attempt) => !reHeldAttemptIds.has(attempt.id));
          const sameAttempts =
            reGroup.length === group.length && group.every((attempt) => reIds.has(attempt.id));
          if (!stillFinished || !stillUnheld || !sameAttempts) {
            skipped.push({ worktreePath, reason: 'became-live' });
            continue;
          }
          // Abort one worktree at a time; `abortWorktreeRun` is the only write.
          if (runner.abortWorktreeRun === undefined) {
            failed.push({ worktreePath, outcome: 'refused' });
            continue;
          }
          let abortResult: AbortWorktreeRunResult;
          try {
            // Called on the runner, never copied off it: the production
            // adapters read `this`, so an unbound call would throw.
            abortResult = await runner.abortWorktreeRun({
              attemptId: latest.id,
              worktreePath,
              runner: latest.runner,
              gracePeriodSeconds: 10,
            });
          } catch {
            // A throwing abort must not end the scan: report it and move on.
            failed.push({ worktreePath, outcome: 'unknown' });
            continue;
          }
          if (abortResult.outcome === 'aborted') {
            aborted.push({ worktreePath });
          } else {
            failed.push({ worktreePath, outcome: abortResult.outcome });
          }
        }
        continue;
      }
      if (worktreeState.state === 'unknown') {
        unknown.push({ worktreePath, reason: worktreeState.reason });
      }
      // idle: nothing runs; the worktree is not an orphan and needs no entry.
    }

    orphans.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    aborted.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    failed.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    skipped.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    unknown.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));

    return { outcome: 'reaped', dryRun, orphans, aborted, failed, skipped, unknown };
  }
}
