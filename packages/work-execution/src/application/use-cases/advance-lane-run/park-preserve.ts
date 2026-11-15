/**
 * F198: when a run parks, its worktree may still hold work no commit carries.
 *
 * GB3 preserves a patch only for the FIRST attempt's refused dispatch; GB3a
 * deliberately hands a dirty worktree to the next seat with nothing preserved,
 * which is right while a next seat is still coming. When the seat plan then
 * runs out, neither path applies and the work is left in a hash-named worktree
 * that nothing in the journal names: on 2026-11-13 two parked runs held 137 and
 * 182 lines of real implementation that were found only by walking 534
 * directories by hand.
 *
 * This preserves the latest attempt's uncommitted tracked edits as a patch
 * beside the worktree and journals where it went. It is deliberately
 * NON-DESTRUCTIVE: nothing is reset, cancelled or deleted, so a worktree handed
 * over by GB3a is unchanged and the patch is additive evidence. Because the
 * patch path is built from the worktree path, the journal entry names the
 * worktree too — which is what makes untracked files, which no patch can carry,
 * discoverable as well.
 *
 * SCOPE, deliberately narrow. It runs for ONE park reason,
 * `seat-plan-exhausted`: the point at which no further seat will pick the
 * worktree up, which is exactly where the 2026-11-13 work was lost. Every other
 * park either still has a seat coming (GB3a's handover) or already carries its
 * work on a commit. It also stands down whenever the attempt holds a GB3
 * recovery marker, complete or not: an incomplete recovery parks precisely so
 * that nothing re-runs, and re-running a preserve there would break that.
 */
import type { ActionJournalEntryRecord, AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { WorkspacePort } from '../../ports/out/WorkspacePort.out-port.js';
import type { LaneRunParkReason } from '../../../domain/lane-run-records.js';
import { conductedRunnerOf } from './conducted-host.js';
import { worktreeRecoveryPatchInputsValid } from './prepare-dispatch.js';

/** The suffix that distinguishes a park patch from GB3's dispatch-recovery patch. */
export const PARK_PATCH_SUFFIX = '.park.patch';

/** The journal detail prefix a park patch is recorded under. */
export const PARK_PRESERVE_DETAIL = 'parked worktree preserved: ';

/** GB3's own marker: its presence means a recovery already owns this worktree. */
const GB3_DETAIL = 'preserved uncommitted edits:';

/** The one park reason after which no further seat will pick the worktree up. */
export const PARK_PRESERVE_REASON = 'seat-plan-exhausted';

/** Only what this step reads; `ctx.deps` satisfies it structurally. */
export interface ParkPreserveDeps {
  readonly attemptRepo: { findAttemptById(id: string): Promise<AttemptRecord | null> };
  readonly worktreeRecovery?: Pick<WorkspacePort, 'preserveWorktreeEdits'>;
  readonly executionJournal: {
    appendJournalEntry?(entry: ActionJournalEntryRecord): Promise<void>;
    listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]>;
  };
}

/**
 * Preserve and name the parked run's worktree. Never throws, never resets, and
 * never fails the park: a park that is recorded is worth more than a patch, so
 * every refusal (unwired port, a clean tree, an unreadable host) is silent.
 */
export async function preserveParkedWorktree(
  deps: ParkPreserveDeps,
  record: LaneRunRecord,
  reason: LaneRunParkReason,
  nowIso: string,
): Promise<void> {
  if (reason !== PARK_PRESERVE_REASON) {
    return;
  }
  const preserve = deps.worktreeRecovery?.preserveWorktreeEdits?.bind(deps.worktreeRecovery);
  const append = deps.executionJournal.appendJournalEntry?.bind(deps.executionJournal);
  if (preserve === undefined || append === undefined) {
    return;
  }
  try {
    const latest = await latestAttemptWithWorktree(deps, record);
    if (latest === null) {
      return;
    }
    const recordedHost = conductedRunnerOf(latest);
    if (recordedHost === null) {
      return;
    }
    const patchPath = latest.worktreePath + '.' + latest.id + PARK_PATCH_SUFFIX;
    const priorEntries = await deps.executionJournal.listJournalEntriesForAttempt(latest.id);
    // Idempotent: a re-park of the same attempt must not write a second entry,
    // and `destination-exists` below would refuse the write anyway.
    const owned = priorEntries.some((entry) => {
      const detail = entry.detail ?? '';
      return detail.startsWith(PARK_PRESERVE_DETAIL) || detail.startsWith(GB3_DETAIL);
    });
    if (owned) {
      return;
    }
    const preserved = await preserve({ worktreePath: latest.worktreePath, patchPath, recordedHost });
    // `nothing-to-preserve` is the common, healthy case: a clean worktree, or one
    // GB3 already reset. Only a patch that now exists is worth a journal entry.
    const saved =
      preserved.outcome === 'preserved' ||
      (preserved.outcome === 'refused' && preserved.reason === 'destination-exists');
    if (!saved) {
      return;
    }
    await append({
      id: latest.id + ':dispatch:' + String(priorEntries.length + 1),
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      action: 'dispatch',
      baseCommit: latest.baseCommit,
      recordedAtIso: nowIso,
      status: 'completed',
      sessionId: null,
      detail: PARK_PRESERVE_DETAIL + patchPath,
    });
  } catch {
    // A park is never failed by its evidence step.
  }
}

/** The run's newest attempt that records a worktree, newest first; null when none. */
async function latestAttemptWithWorktree(
  deps: ParkPreserveDeps,
  record: LaneRunRecord,
): Promise<AttemptRecord | null> {
  for (let index = record.attemptIds.length - 1; index >= 0; index -= 1) {
    const id = record.attemptIds[index];
    if (id === undefined) {
      continue;
    }
    const attempt = await deps.attemptRepo.findAttemptById(id);
    // The recorded path is untrusted data: an attempt whose path cannot build a
    // patch path is skipped, so an older attempt with a usable one is still found.
    if (attempt !== null && worktreeRecoveryPatchInputsValid(attempt.worktreePath, attempt.id)) {
      return attempt;
    }
  }
  return null;
}
