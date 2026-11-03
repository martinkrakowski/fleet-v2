/** GB3a: a refused fix dispatch hands the dirty worktree to the next fix seat unchanged. */
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';

/** The fixed refusal details whose worktree is dirty: uncommitted or untracked. */
export const DIRTY_WORKTREE_DETAILS = ['worktree-uncommitted', 'worktree-untracked'] as const;

export function isDirtyWorktreeDetail(detail: string): boolean {
  return (DIRTY_WORKTREE_DETAILS as readonly string[]).includes(detail);
}

/**
 * True when the run's last final dispatch-step result refused for a dirty
 * worktree. Entries are scanned from the end; ambiguous results never count,
 * so an all-ambiguous dispatch leaves no final result and reads false.
 */
export function lastDispatchLeftDirtyWorktree(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'result' || entry.runId !== runId || entry.outcome === 'ambiguous') {
      continue;
    }
    const parsed = entry.key === null ? null : parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'dispatch') {
      continue;
    }
    return entry.reasonCode === 'dispatch-refused' && isDirtyWorktreeDetail(entry.detail ?? '');
  }
  return false;
}
