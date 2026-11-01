// @generated use-case scaffold — refined for EX-4.
/**
 * ReapOrphanSessionsUseCase: on the operator's explicit request, find lane
 * sessions that outlived their attempt. A candidate is a worktree whose every
 * attempt is finished (cancelled, collected or ended) and none of whose
 * attempts holds a reservation, but where the runner still reports a running
 * session. Those are listed as orphans; on explicit request (not a dry run)
 * each is aborted by directory only, one at a time, with a 10-second grace —
 * never a git command, never a deleted session record, worktree, branch or
 * run. Unknown runner state is reported and never acted on. The scan also
 * lists, read-only, every legacy-runner attempt (a record whose runner names
 * no installation host) the reaper will never adopt.
 */

import type { AttemptRecord } from '../../domain/execution-records.js';
import { runnerHasHostName } from '../../domain/execution-records.js';
import { conductedRunnerOf } from './advance-lane-run/conducted-host.js';
import type {
  ReapOrphanFailedEntry,
  ReapOrphanLegacyAttemptEntry,
  ReapOrphanLegacyRunnerReason,
  ReapOrphanSessionEntry,
  ReapOrphanSessionsPort,
  ReapOrphanSessionsRequest,
  ReapOrphanSessionsResult,
  ReapOrphanUnknownEntry,
} from '../ports/in/ReapOrphanSessionsPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  AbortWorktreeRunResult,
  ExecutionRunnerPort,
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

/** One worktree's scan outcomes; all lists are empty until filled. */
interface WorktreeScanResult {
  readonly orphans: readonly ReapOrphanSessionEntry[];
  readonly aborted: readonly { readonly worktreePath: string }[];
  readonly failed: readonly ReapOrphanFailedEntry[];
  readonly skipped: readonly {
    readonly worktreePath: string;
    readonly reason: ReapOrphanSkippedReason;
  }[];
  readonly unknown: readonly ReapOrphanUnknownEntry[];
}

function worktreeResult(partial: Partial<WorktreeScanResult> = {}): WorktreeScanResult {
  return {
    orphans: [],
    aborted: [],
    failed: [],
    skipped: [],
    unknown: [],
    ...partial,
  };
}

function groupAttemptsByWorktree(attempts: readonly AttemptRecord[]): Map<string, AttemptRecord[]> {
  const byWorktree = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const group = byWorktree.get(attempt.worktreePath);
    if (group === undefined) {
      byWorktree.set(attempt.worktreePath, [attempt]);
    } else {
      group.push(attempt);
    }
  }
  return byWorktree;
}

/** The latest finished attempt of the group that names an installation host. */
function latestConductedAttempt(group: readonly AttemptRecord[]): AttemptRecord | undefined {
  let latest: AttemptRecord | undefined;
  for (const attempt of group) {
    if (conductedRunnerOf(attempt) !== null) {
      if (latest === undefined || byOldestFirst(latest, attempt) < 0) {
        latest = attempt;
      }
    }
  }
  return latest;
}

/**
 * Classify one attempt as a legacy-runner record the reaper will never adopt,
 * or `null` when it names an installation host (the reaper's population).
 * Pure; never inspects a runner and never reads a store.
 */
function classifyLegacyAttempt(attempt: AttemptRecord): ReapOrphanLegacyAttemptEntry | null {
  if (runnerHasHostName(attempt.runner)) {
    return null;
  }
  let reason: ReapOrphanLegacyRunnerReason;
  if (attempt.runner === undefined || attempt.runner === null) {
    reason = 'no-runner';
  } else if ((attempt.runner.host ?? '').trim() !== '') {
    reason = 'alias-only';
  } else {
    reason = 'no-host-name';
  }
  return {
    attemptId: attempt.id,
    workOrderId: attempt.workOrderId,
    worktreePath: attempt.worktreePath,
    state: attempt.state,
    sessionId: attempt.sessionId,
    reason,
  };
}

/**
 * The confirm-then-abort leg of a running worktree on a real run: re-read the
 * attempt store and the journal immediately before the abort (the opening
 * snapshot may be stale because an attempt went live, took a reservation, or a
 * new attempt appeared since it was taken) and abort only when all three still
 * hold for this worktree: every attempt finished, none holds a reservation,
 * and the attempt ids are exactly the first snapshot's.
 */
async function abortConfirmedOrphan(
  deps: ReapOrphanSessionsDependencies,
  worktreePath: string,
  group: readonly AttemptRecord[],
  orphan: ReapOrphanSessionEntry,
  latest: AttemptRecord,
  runner: ExecutionRunnerPort,
): Promise<WorktreeScanResult> {
  const reAttempts = await deps.attemptRepo.listAllAttempts();
  const reHeldAttemptIds = new Set(
    (await deps.executionJournal.listActiveReservations())
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
    return worktreeResult({ orphans: [orphan], skipped: [{ worktreePath, reason: 'became-live' }] });
  }
  // Abort one worktree at a time; `abortWorktreeRun` is the only write.
  if (runner.abortWorktreeRun === undefined) {
    return worktreeResult({ orphans: [orphan], failed: [{ worktreePath, outcome: 'refused' }] });
  }
  let abortResult: AbortWorktreeRunResult;
  try {
    // Called on the runner, never copied off it: the production adapters
    // read `this`, so an unbound call would throw.
    abortResult = await runner.abortWorktreeRun({
      attemptId: latest.id,
      worktreePath,
      runner: latest.runner,
      gracePeriodSeconds: 10,
    });
  } catch {
    // A throwing abort must not end the scan: report it and move on.
    return worktreeResult({ orphans: [orphan], failed: [{ worktreePath, outcome: 'unknown' }] });
  }
  if (abortResult.outcome === 'aborted') {
    return worktreeResult({ orphans: [orphan], aborted: [{ worktreePath }] });
  }
  return worktreeResult({ orphans: [orphan], failed: [{ worktreePath, outcome: abortResult.outcome }] });
}

/** Scan one worktree, calling its runner only when it is an orphan candidate. */
async function scanWorktree(
  deps: ReapOrphanSessionsDependencies,
  worktreePath: string,
  group: readonly AttemptRecord[],
  heldAttemptIds: ReadonlySet<string>,
  dryRun: boolean,
): Promise<WorktreeScanResult> {
  // Any attempt on the worktree in a non-finished state means the worktree
  // still has a live attempt; it is never scanned or touched.
  if (group.some((attempt) => !FINISHED_ATTEMPT_STATES.has(attempt.state))) {
    return worktreeResult({ skipped: [{ worktreePath, reason: 'attempt-live' }] });
  }
  // A held reservation on any attempt keeps the worktree off limits.
  if (group.some((attempt) => heldAttemptIds.has(attempt.id))) {
    return worktreeResult({ skipped: [{ worktreePath, reason: 'slot-held' }] });
  }
  // The scanner's population: finished attempts with a recorded host.
  const latest = latestConductedAttempt(group);
  if (latest === undefined || deps.runnerForAttempt === undefined) {
    return worktreeResult({ skipped: [{ worktreePath, reason: 'no-runner' }] });
  }
  const selection = deps.runnerForAttempt.runnerForAttempt({
    runner: latest.runner ?? null,
  });
  if (!selection.ok) {
    return worktreeResult({ skipped: [{ worktreePath, reason: 'no-runner' }] });
  }
  const runner = selection.runner;
  if (runner.inspectWorktreeRun === undefined) {
    return worktreeResult({ skipped: [{ worktreePath, reason: 'no-runner' }] });
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
    return worktreeResult({ unknown: [{ worktreePath, reason: 'inspect-failed' }] });
  }
  if (worktreeState.state === 'running') {
    const orphan: ReapOrphanSessionEntry = {
      worktreePath,
      attemptId: latest.id,
      sessionId: worktreeState.sessionId,
    };
    if (dryRun) {
      return worktreeResult({ orphans: [orphan] });
    }
    return abortConfirmedOrphan(deps, worktreePath, group, orphan, latest, runner);
  }
  if (worktreeState.state === 'unknown') {
    return worktreeResult({ unknown: [{ worktreePath, reason: worktreeState.reason }] });
  }
  // idle: nothing runs; the worktree is not an orphan and needs no entry.
  return worktreeResult();
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
    const deps = this.deps;

    const attempts = await deps.attemptRepo.listAllAttempts();
    const heldAttemptIds = new Set(
      (await deps.executionJournal.listActiveReservations())
        .filter((reservation) => reservation.held)
        .map((reservation) => reservation.attemptId),
    );

    const orphans: ReapOrphanSessionEntry[] = [];
    const aborted: { readonly worktreePath: string }[] = [];
    const failed: ReapOrphanFailedEntry[] = [];
    const skipped: { readonly worktreePath: string; readonly reason: ReapOrphanSkippedReason }[] =
      [];
    const unknown: ReapOrphanUnknownEntry[] = [];
    const legacyAttempts: ReapOrphanLegacyAttemptEntry[] = [];

    // The read-only legacy scan covers every attempt in the opening snapshot,
    // across all states and worktrees, with no runner call and no write.
    for (const attempt of attempts) {
      const legacy = classifyLegacyAttempt(attempt);
      if (legacy !== null) {
        legacyAttempts.push(legacy);
      }
    }

    const byWorktree = groupAttemptsByWorktree(attempts);
    for (const [worktreePath, group] of byWorktree) {
      const result = await scanWorktree(deps, worktreePath, group, heldAttemptIds, dryRun);
      orphans.push(...result.orphans);
      aborted.push(...result.aborted);
      failed.push(...result.failed);
      skipped.push(...result.skipped);
      unknown.push(...result.unknown);
    }

    orphans.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    aborted.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    failed.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    skipped.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    unknown.sort((a, b) => byCodeUnit(a.worktreePath, b.worktreePath));
    legacyAttempts.sort(
      (a, b) => byCodeUnit(a.worktreePath, b.worktreePath) || byCodeUnit(a.attemptId, b.attemptId),
    );

    return { outcome: 'reaped', dryRun, orphans, aborted, failed, skipped, unknown, legacyAttempts };
  }
}
