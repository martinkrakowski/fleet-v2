// Refined inbound contract for lane K11a2.
/**
 * ReapZombiesPort: one reaper pass. It gathers facts through existing read
 * ports, classifies with the merged `classifyZombies`, upserts findings,
 * raises or refreshes attention items, and performs only record-only repairs
 * under keyed journal entries (the intent before the action, the result
 * after). Every view carries ids, kinds, codes and counts only — never a
 * worktree path, never free text, never a secret.
 */

import type { ReaperFinding, ReaperPolicy } from '../../../domain/reaper-findings.js';

export interface ReapZombiesRequest {
  readonly projectId: string;
  /** Absent → the pass reads the clock itself; present but unparsable → refusal. */
  readonly nowIso?: string;
  /** The already-resolved reaper policy; absent → `{}` (report-only). */
  readonly policy?: ReaperPolicy;
}

/** One stored finding as the pass now sees it. */
export interface ReaperFindingView {
  readonly findingId: string;
  readonly kind: ReaperFinding['kind'];
  readonly subject: string;
  readonly action: ReaperFinding['action'];
  readonly sightings: number;
}

export type ReaperAttentionOutcome = 'raised' | 'refreshed' | 'reopened' | 'exists' | 'refused';

export interface ReaperAttentionView {
  readonly kind: string;
  readonly subject: string;
  readonly outcome: ReaperAttentionOutcome;
}

export type ReaperRepairOutcome = 'completed' | 'refused' | 'reconciled' | 'ambiguous' | 'skipped';

export interface ReaperRepairView {
  readonly key: string;
  readonly kind: string;
  readonly subject: string;
  readonly outcome: ReaperRepairOutcome;
  readonly reasonCode?: string;
}

/** One part of the pass that could not be read or decided; `reason` is a lowercase code token. */
export interface ReaperUnknownView {
  readonly subject: string;
  readonly kind?: string;
  readonly reason: string;
}

/** One worktree subject the pass gathered: ids and codes only, never a path or a branch name. */
export interface ReaperWorktreeView {
  readonly subject: string; // the 12-hex digest; never a path
  readonly report: 'merged-worktree' | 'worktree-busy';
  readonly evidence: 'merged-pr' | 'ancestor-only' | 'unknown';
  readonly sizeBytes: number | null; // null when the measurement ran out of budget
}

export interface ReapZombiesResult {
  readonly outcome: 'completed' | 'refused';
  readonly reason?: string;
  readonly findings: readonly ReaperFindingView[];
  readonly attention: readonly ReaperAttentionView[];
  readonly repairs: readonly ReaperRepairView[];
  readonly worktrees: readonly ReaperWorktreeView[];
  readonly unknown: readonly ReaperUnknownView[];
}

export interface ReapZombiesPort {
  /** Run one reaper pass; never throws. */
  reapZombies(request: ReapZombiesRequest): Promise<ReapZombiesResult>;
}
