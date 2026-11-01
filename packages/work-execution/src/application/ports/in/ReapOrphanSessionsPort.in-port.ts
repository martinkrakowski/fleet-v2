// @generated inbound contract scaffold — refined for EX-4.
/**
 * ReapOrphanSessionsPort: on the operator's explicit request, list worktrees
 * whose every attempt is finished (cancelled, collected or ended) and none
 * holds a reservation, but where the runner still reports a running session,
 * and abort those by directory only with confirmation; never touches a
 * worktree with a live attempt or a held reservation; a dry run aborts
 * nothing and never deletes a session record, worktree, branch or run.
 * A read-only scan also lists every legacy-runner attempt (a record whose
 * runner names no installation host) the reaper will never adopt.
 */

export interface ReapOrphanSessionsRequest {
  /** Dry run: scan and list orphans exactly like a real run, but call no `abortWorktreeRun`. */
  readonly dryRun: boolean;
}

/** One orphan: a worktree whose attempts are finished but a session still runs in it. */
export interface ReapOrphanSessionEntry {
  readonly worktreePath: string;
  /** The worktree's latest finished attempt with a recorded host. */
  readonly attemptId: string;
  /** The session the runner reports running in the worktree. */
  readonly sessionId: string;
}

/** A worktree that is not an orphan candidate, with its typed reason. */
export interface ReapOrphanSkippedEntry {
  readonly worktreePath: string;
  readonly reason: string;
}

/** An abort that did not confirm termination, with the runner's outcome. */
export interface ReapOrphanFailedEntry {
  readonly worktreePath: string;
  readonly outcome: string;
}

/** A worktree the runner could not inspect; reported, never acted on. */
export interface ReapOrphanUnknownEntry {
  readonly worktreePath: string;
  readonly reason: string;
}

/** Why a legacy-runner attempt is never adopted by the reaper. */
export type ReapOrphanLegacyRunnerReason = 'no-runner' | 'alias-only' | 'no-host-name';

/** One legacy-runner attempt the reaper scans and reports, never adopts. */
export interface ReapOrphanLegacyAttemptEntry {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly worktreePath: string;
  readonly state: string;
  readonly sessionId: string | null;
  readonly reason: ReapOrphanLegacyRunnerReason;
}

export type ReapOrphanSessionsResult = {
  readonly outcome: 'reaped';
  readonly dryRun: boolean;
  /** Orphans found (on a real run, the ones the abort pass then processes). */
  readonly orphans: readonly ReapOrphanSessionEntry[];
  /** Worktrees whose running session was aborted. */
  readonly aborted: readonly { readonly worktreePath: string }[];
  /** Aborts that did not confirm termination (still-running, refused, unknown). */
  readonly failed: readonly ReapOrphanFailedEntry[];
  /** Worktrees that are not candidates, with why. */
  readonly skipped: readonly ReapOrphanSkippedEntry[];
  /** Worktrees whose runner state is unknown; reported, never aborted. */
  readonly unknown: readonly ReapOrphanUnknownEntry[];
  /** Legacy-runner attempts listed read-only; the reaper never adopts them. */
  readonly legacyAttempts: readonly ReapOrphanLegacyAttemptEntry[];
};

export interface ReapOrphanSessionsPort {
  reapOrphanSessions(request: ReapOrphanSessionsRequest): Promise<ReapOrphanSessionsResult>;
}
