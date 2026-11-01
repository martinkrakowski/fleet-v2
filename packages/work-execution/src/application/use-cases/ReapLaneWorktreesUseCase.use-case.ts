// @generated use-case scaffold — refined for EX-2b.
/**
 * ReapLaneWorktreesUseCase: on the operator's explicit request, list or
 * remove the clean worktree of every finished lane run. A candidate is a run
 * whose journal state is `merged` or `stopped`, whose work order is `merged`
 * or `stopped`, whose every attempt is `cancelled` or `collected`, and none
 * of whose attempts holds a reservation. Anything else is skipped with a
 * reason and never touched. Removal goes through
 * `WorkspacePort.removeLaneWorktree` (EX-2a), one run at a time — destructive
 * writes, never parallel. The branch `fleet/<runId>` is the record of the
 * run and is kept: no branch command is ever issued. A dry run calls no
 * `removeLaneWorktree` and reports the candidates as `removed` with a null
 * tip.
 */

import { containsSecretShape } from '@fleet/shared';
import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { laneRunJournalState, type LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type {
  ReapLaneWorktreesPort,
  ReapLaneWorktreesRequest,
  ReapLaneWorktreesResult,
  ReapWorktreeJournalFailureEntry,
} from '../ports/in/ReapLaneWorktreesPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import { conductedRunnerOf } from './advance-lane-run/conducted-host.js';
import { journalsForRuns, type RunJournalRunReads } from './run-journal-reads.js';

/** The reads and writes the reap needs; narrowed so composition supplies only what it has. */
export interface ReapLaneWorktreesDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: RunJournalRunReads;
  readonly executionJournal: Pick<
    ExecutionJournalPort,
    'listActiveReservations' | 'appendJournalEntry' | 'listJournalEntriesForAttempt'
  >;
  /** Absent: any candidate that needs a clone is refused `not-configured`. */
  readonly profileRead?: ProjectProfileReadPort;
  /** Absent (or without `removeLaneWorktree`): a removal is refused `not-configured`. */
  readonly workspace?: Pick<WorkspacePort, 'removeLaneWorktree'>;
  /** Clock override; production uses the system clock. */
  readonly now?: () => string;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isTerminalRun(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

function isTerminalWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state === 'merged' || state === 'stopped';
}

/** The branch of a run's worktree (K7-D7): `fleet/<runId>`. */
function branchForRun(runId: string): string {
  return 'fleet/' + runId;
}

export class ReapLaneWorktreesUseCase implements ReapLaneWorktreesPort {
  constructor(private readonly deps?: ReapLaneWorktreesDependencies) {}

  async execute(input: unknown): Promise<ReapLaneWorktreesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapLaneWorktreesUseCase');
    }
    const request = (input ?? {}) as ReapLaneWorktreesRequest;
    return this.reapLaneWorktrees(request);
  }

  async reapLaneWorktrees(request: ReapLaneWorktreesRequest): Promise<ReapLaneWorktreesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapLaneWorktreesUseCase');
    }
    return this.reap(this.deps, request);
  }

  private async reap(
    deps: ReapLaneWorktreesDependencies,
    request: ReapLaneWorktreesRequest,
  ): Promise<ReapLaneWorktreesResult> {
    // Fail safe: only an explicit `dryRun: false` removes anything; a missing
    // or malformed value (an unchecked `execute` input) is a dry run.
    const dryRun = request.dryRun !== false;
    const nowIso = request.nowIso ?? deps.now?.() ?? new Date().toISOString();

    const runs = await deps.runRepo.list();
    // One grouped journal read for every run (EX-3a).
    const entriesByRun = await journalsForRuns(
      deps.runJournal,
      runs.map((run) => run.runId),
    );
    const heldAttemptIds = new Set(
      (await deps.executionJournal.listActiveReservations())
        .filter((reservation) => reservation.held)
        .map((reservation) => reservation.attemptId),
    );

    const removed: { readonly runId: string; readonly branchTip: string | null }[] = [];
    const alreadyRemoved: { readonly runId: string }[] = [];
    const refused: { readonly runId: string; readonly reason: string }[] = [];
    const skipped: { readonly runId: string; readonly reason: string }[] = [];
    const journalFailed: ReapWorktreeJournalFailureEntry[] = [];

    const workOrderCache = new Map<string, WorkOrderRecord | null>();
    const attemptsCache = new Map<string, readonly AttemptRecord[]>();
    const findWorkOrder = async (workOrderId: string): Promise<WorkOrderRecord | null> => {
      const cached = workOrderCache.get(workOrderId);
      if (cached !== undefined) {
        return cached;
      }
      const record = await deps.workOrderRepo.findWorkOrderById(workOrderId);
      workOrderCache.set(workOrderId, record);
      return record;
    };
    const listAttempts = async (workOrderId: string): Promise<readonly AttemptRecord[]> => {
      const cached = attemptsCache.get(workOrderId);
      if (cached !== undefined) {
        return cached;
      }
      const records = await deps.attemptRepo.listAttemptsByWorkOrder(workOrderId);
      attemptsCache.set(workOrderId, records);
      return records;
    };

    for (const run of runs) {
      const evaluation = await evaluateRunCandidate({
        deps,
        run,
        heldAttemptIds,
        findWorkOrder,
        listAttempts,
        entriesByRun,
        skipped,
        refused,
      });
      if (evaluation.outcome !== 'candidate') {
        continue;
      }
      await reapCandidateWorktree({
        deps,
        run,
        latestAttempt: evaluation.latestAttempt,
        clone: evaluation.clone,
        recordedHost: evaluation.recordedHost,
        dryRun,
        nowIso,
        removed,
        alreadyRemoved,
        refused,
        journalFailed,
      });
    }

    const byRunId = (a: { readonly runId: string }, b: { readonly runId: string }): number =>
      byCodeUnit(a.runId, b.runId);
    removed.sort(byRunId);
    alreadyRemoved.sort(byRunId);
    refused.sort(byRunId);
    skipped.sort(byRunId);
    journalFailed.sort(byRunId);

    return { outcome: 'reaped', dryRun, removed, alreadyRemoved, refused, skipped, journalFailed };
  }
}

/** A project-profile clone: the clone root and the worktree root it manages. */
type CloneRecord = { readonly path: string; readonly worktreeRoot: string };

/** One run's eligibility decision; a candidate carries what removal needs. */
type RunCandidateEvaluation =
  | {
      readonly outcome: 'candidate';
      readonly latestAttempt: AttemptRecord;
      readonly clone: CloneRecord;
      readonly recordedHost: AttemptRunnerRecord;
    }
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'refused' };

interface EvaluateRunCandidateParams {
  readonly deps: ReapLaneWorktreesDependencies;
  readonly run: LaneRunRecord;
  readonly heldAttemptIds: ReadonlySet<string>;
  readonly findWorkOrder: (workOrderId: string) => Promise<WorkOrderRecord | null>;
  readonly listAttempts: (workOrderId: string) => Promise<readonly AttemptRecord[]>;
  readonly entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  readonly skipped: { readonly runId: string; readonly reason: string }[];
  readonly refused: { readonly runId: string; readonly reason: string }[];
}

/**
 * Decide one run's eligibility and, for a candidate, return its latest attempt,
 * clone and recorded host. Non-candidates push their own skip or refusal entry.
 */
async function evaluateRunCandidate(
  params: EvaluateRunCandidateParams,
): Promise<RunCandidateEvaluation> {
  const {
    deps,
    run,
    heldAttemptIds,
    findWorkOrder,
    listAttempts,
    entriesByRun,
    skipped,
    refused,
  } = params;
  const state = laneRunJournalState(entriesByRun.get(run.runId) ?? [], run.runId);
  if (!isTerminalRun(state)) {
    skipped.push({ runId: run.runId, reason: 'run-not-terminal' });
    return { outcome: 'skipped' };
  }

  const workOrder = await findWorkOrder(run.workOrderId);
  if (workOrder === null || !isTerminalWorkOrder(workOrder.state)) {
    skipped.push({ runId: run.runId, reason: 'work-order-active' });
    return { outcome: 'skipped' };
  }

  // The run's attempts: every id the run records, in the run's own order.
  const runAttempts: AttemptRecord[] = [];
  const attemptsById = new Map(
    (await listAttempts(run.workOrderId)).map((attempt) => [attempt.id, attempt]),
  );
  let missingAttempt = false;
  for (const attemptId of run.attemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (attempt === undefined) {
      missingAttempt = true;
      break;
    }
    runAttempts.push(attempt);
  }
  // A run records an attempt the store does not have: it cannot be proven
  // cancelled or collected, so it is never a candidate.
  if (missingAttempt) {
    skipped.push({ runId: run.runId, reason: 'attempt-live' });
    return { outcome: 'skipped' };
  }
  if (runAttempts.some((attempt) => attempt.state !== 'cancelled' && attempt.state !== 'collected')) {
    skipped.push({ runId: run.runId, reason: 'attempt-live' });
    return { outcome: 'skipped' };
  }
  if (runAttempts.some((attempt) => heldAttemptIds.has(attempt.id))) {
    skipped.push({ runId: run.runId, reason: 'slot-held' });
    return { outcome: 'skipped' };
  }

  const latestAttempt = runAttempts[runAttempts.length - 1];
  if (latestAttempt === undefined) {
    // No attempt, no worktree to remove.
    skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
    return { outcome: 'skipped' };
  }
  const recordedHost = conductedRunnerOf(latestAttempt);
  if (recordedHost === null) {
    skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
    return { outcome: 'skipped' };
  }

  if (deps.profileRead === undefined) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return { outcome: 'refused' };
  }
  const profile = await deps.profileRead.readProjectProfile(workOrder.projectId);
  const clone = profile?.clones[recordedHost.hostName ?? ''];
  if (clone === undefined) {
    skipped.push({ runId: run.runId, reason: 'no-clone' });
    return { outcome: 'skipped' };
  }

  return { outcome: 'candidate', latestAttempt, clone, recordedHost };
}

interface ReapCandidateWorktreeParams {
  readonly deps: ReapLaneWorktreesDependencies;
  readonly run: LaneRunRecord;
  readonly latestAttempt: AttemptRecord;
  readonly clone: CloneRecord;
  readonly recordedHost: AttemptRunnerRecord;
  readonly dryRun: boolean;
  readonly nowIso: string;
  readonly removed: { readonly runId: string; readonly branchTip: string | null }[];
  readonly alreadyRemoved: { readonly runId: string }[];
  readonly refused: { readonly runId: string; readonly reason: string }[];
  readonly journalFailed: ReapWorktreeJournalFailureEntry[];
}

/**
 * Remove one candidate's clean worktree and report the outcome. A failed
 * post-removal journal append never aborts the scan: the removal stays in
 * `removed` and the failure is reported in `journalFailed`.
 */
async function reapCandidateWorktree(params: ReapCandidateWorktreeParams): Promise<void> {
  const {
    deps,
    run,
    latestAttempt,
    clone,
    recordedHost,
    dryRun,
    nowIso,
    removed,
    alreadyRemoved,
    refused,
    journalFailed,
  } = params;
  if (dryRun) {
    removed.push({ runId: run.runId, branchTip: null });
    return;
  }

  // The call keeps the workspace as its receiver: extracting the method
  // would lose `this`, and the adapter reads `this.options`.
  const workspace = deps.workspace;
  if (workspace === undefined || workspace.removeLaneWorktree === undefined) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return;
  }
  const result = await workspace.removeLaneWorktree({
    clonePath: clone.path,
    worktreeRoot: clone.worktreeRoot,
    worktreePath: latestAttempt.worktreePath,
    branch: branchForRun(run.runId),
    recordedHost,
  });
  if (result.outcome === 'removed') {
    const failureReason = await recordRemovalJournalEntry(
      deps,
      latestAttempt,
      run.runId,
      nowIso,
      result.branchTip,
    );
    if (failureReason !== null) {
      journalFailed.push({
        runId: run.runId,
        attemptId: latestAttempt.id,
        branchTip: result.branchTip,
        reason: failureReason,
      });
    }
    removed.push({ runId: run.runId, branchTip: result.branchTip });
  } else if (result.outcome === 'already-removed') {
    alreadyRemoved.push({ runId: run.runId });
  } else if (result.outcome === 'refused') {
    refused.push({ runId: run.runId, reason: result.reason });
  } else {
    // `unknown`: the executor did not answer; the worktree may or may not
    // be removed. Reported as refused so the exit code says unresolved.
    refused.push({ runId: run.runId, reason: 'unknown' });
  }
}

/**
 * Append one `collect` journal entry on the latest attempt recording the
 * removal, the worktree path and the kept branch's tip. On any failure the
 * primary append is retried as a best-effort `ambiguous` entry carrying the
 * sanitised failure reason, and the reason is returned so the caller can
 * report the removal in `journalFailed`; never throws.
 */
async function recordRemovalJournalEntry(
  deps: ReapLaneWorktreesDependencies,
  attempt: AttemptRecord,
  runId: string,
  nowIso: string,
  branchTip: string,
): Promise<string | null> {
  try {
    const priorEntries = await deps.executionJournal.listJournalEntriesForAttempt(attempt.id);
    await deps.executionJournal.appendJournalEntry({
      id: `${attempt.id}:collect:${priorEntries.length + 1}`,
      attemptId: attempt.id,
      workOrderId: attempt.workOrderId,
      action: 'collect',
      baseCommit: attempt.baseCommit,
      recordedAtIso: nowIso,
      status: 'completed',
      sessionId: null,
      detail:
        `Removed the lane worktree at ${attempt.worktreePath}; ` +
        `branch ${branchForRun(runId)} kept at ${branchTip}`,
    });
    return null;
  } catch (error) {
    const reason = sanitizeJournalFailureReason(error);
    // Best-effort fallback: record the failed append as ambiguous evidence.
    try {
      await deps.executionJournal.appendJournalEntry({
        id: `${attempt.id}:collect:reap-journal-failed:${runId}:${nowIso}`,
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'collect',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: null,
        detail:
          `Removed the lane worktree at ${attempt.worktreePath} ` +
          `(branch ${branchForRun(runId)} kept at ${branchTip}); ` +
          `journal append failed: ${reason}`,
      });
    } catch {
      // Even the fallback append failed; the failure still surfaces via `journalFailed`.
    }
    return reason;
  }
}

/**
 * A safe, non-secret reason for a failed journal append: the trimmed error
 * message, or `journal-append-failed` when there is none, redacted when it
 * matches a secret shape, and capped at 500 characters.
 */
function sanitizeJournalFailureReason(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : 'journal-append-failed';
  if (containsSecretShape(message)) {
    return 'journal-append-failed (redacted)';
  }
  return message.slice(0, 500);
}
