// Refined for lane DT-V2 (Jev veto decision, 2026-10-31).
/**
 * MergeVetoPort: ask one Jev veto question bound to the verified head over
 * the shared decision client and record the answer, confidence, mode and
 * decision receipt id. Advisory and additive only (decision-port invariant 1):
 * `merge-safe`, low confidence or `unknown` never affect a merge; only
 * `hold-for-human` at or above `holdConfidence` can hold — and that decision
 * stays with the merge-pass decider (DT9), while this port reports the
 * answer, confidence, mode and receipt id only.
 */

export interface MergeVetoStateFields {
  readonly tier: string;
  readonly title: string;
  readonly changedPaths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly hardToUndo: string;
  readonly fixRounds: number;
  readonly reviewerFamilies: readonly string[];
  readonly replyResolvedThreads: number;
  readonly majorBlockerFindings: number;
  readonly headChangedAfterReview: boolean;
}

export interface MergeVetoRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  readonly verifiedHeadOid: string;
  readonly mode: 'shadow' | 'live';
  readonly state: MergeVetoStateFields;
  readonly deadlineIso: string;
}

export type MergeVetoUnknownReason =
  | 'redaction-refused' | 'budget' | 'not-configured'
  | 'timeout' | 'transport' | 'shape' | 'low-confidence' | 'deadline';

export type MergeVetoAdvice =
  | { status: 'answered'; choice: 'merge-safe' | 'hold-for-human';
      confidence: number; decisionReceiptId?: string; mode: 'shadow' | 'live' }
  | { status: 'unknown'; reason: MergeVetoUnknownReason };

export interface MergeVetoPort {
  adviseMergeVeto(request: MergeVetoRequest): Promise<MergeVetoAdvice>;
}
