import type { LaneDiffFinding } from '../../../domain/lane-diff-check.js';

export interface CommitEditOnlyAttemptRequest {
  readonly attemptId: string;
  readonly nowIso?: string;
}

export const COMMIT_EDIT_ONLY_REFUSALS = [
  'attempt-missing', 'not-ended', 'no-allowed-prefixes', 'brief-changed', 'diff-findings',
  'head-moved', 'detached-head', 'ref-moved', 'outside-allowed-paths',
] as const;
export type CommitEditOnlyRefusal = (typeof COMMIT_EDIT_ONLY_REFUSALS)[number];

export type CommitEditOnlyAttemptResult =
  /** Not an edit-only attempt: the lane commits itself; nothing was read or written. */
  | { readonly outcome: 'not-applicable' }
  | { readonly outcome: 'committed'; readonly headCommit: string; readonly alreadyCommitted: boolean }
  /** The lane changed nothing; collection then finds no commit (the no-commit fallback). */
  | { readonly outcome: 'nothing-to-commit' }
  /** Needs the owner: a finding never falls back to another seat. Findings carry path, line, rule only. */
  | { readonly outcome: 'refused'; readonly reason: CommitEditOnlyRefusal; readonly findings: readonly LaneDiffFinding[] }
  /** Nothing is established (an unreadable host, brief or diff); the caller treats it as unknown. */
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface CommitEditOnlyAttemptPort {
  commitEditOnlyAttempt(request: CommitEditOnlyAttemptRequest): Promise<CommitEditOnlyAttemptResult>;
}