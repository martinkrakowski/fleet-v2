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

import type { AttemptRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type {
  ReapLaneWorktreesPort,
  ReapLaneWorktreesRequest,
  ReapLaneWorktreesResult,
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
      const state = laneRunJournalState(entriesByRun.get(run.runId) ?? [], run.runId);
      if (!isTerminalRun(state)) {
        skipped.push({ runId: run.runId, reason: 'run-not-terminal' });
        continue;
      }

      const workOrder = await findWorkOrder(run.workOrderId);
      if (workOrder === null || !isTerminalWorkOrder(workOrder.state)) {
        skipped.push({ runId: run.runId, reason: 'work-order-active' });
        continue;
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
        continue;
      }
      if (runAttempts.some((attempt) => attempt.state !== 'cancelled' && attempt.state !== 'collected')) {
        skipped.push({ runId: run.runId, reason: 'attempt-live' });
        continue;
      }
      if (runAttempts.some((attempt) => heldAttemptIds.has(attempt.id))) {
        skipped.push({ runId: run.runId, reason: 'slot-held' });
        continue;
      }

      const latestAttempt = runAttempts[runAttempts.length - 1];
      if (latestAttempt === undefined) {
        // No attempt, no worktree to remove.
        skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
        continue;
      }
      const recordedHost = conductedRunnerOf(latestAttempt);
      if (recordedHost === null) {
        skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
        continue;
      }

      if (deps.profileRead === undefined) {
        refused.push({ runId: run.runId, reason: 'not-configured' });
        continue;
      }
      const profile = await deps.profileRead.readProjectProfile(workOrder.projectId);
      const clone = profile?.clones[recordedHost.hostName ?? ''];
      if (clone === undefined) {
        skipped.push({ runId: run.runId, reason: 'no-clone' });
        continue;
      }

      if (dryRun) {
        removed.push({ runId: run.runId, branchTip: null });
        continue;
      }

      // The call keeps the workspace as its receiver: extracting the method
      // would lose `this`, and the adapter reads `this.options`.
      const workspace = deps.workspace;
      if (workspace === undefined || workspace.removeLaneWorktree === undefined) {
        refused.push({ runId: run.runId, reason: 'not-configured' });
        continue;
      }
      const result = await workspace.removeLaneWorktree({
        clonePath: clone.path,
        worktreeRoot: clone.worktreeRoot,
        worktreePath: latestAttempt.worktreePath,
        branch: branchForRun(run.runId),
        recordedHost,
      });
      if (result.outcome === 'removed') {
        await appendRemovalJournalEntry(deps, latestAttempt, run.runId, nowIso, result.branchTip);
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

    const byRunId = (a: { readonly runId: string }, b: { readonly runId: string }): number =>
      byCodeUnit(a.runId, b.runId);
    removed.sort(byRunId);
    alreadyRemoved.sort(byRunId);
    refused.sort(byRunId);
    skipped.sort(byRunId);

    return { outcome: 'reaped', dryRun, removed, alreadyRemoved, refused, skipped };
  }
}

/** Append one `collect` journal entry on the latest attempt recording the removal, the worktree path and the kept branch's tip. */
async function appendRemovalJournalEntry(
  deps: ReapLaneWorktreesDependencies,
  attempt: AttemptRecord,
  runId: string,
  nowIso: string,
  branchTip: string,
): Promise<void> {
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
}
