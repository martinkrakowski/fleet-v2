// @generated inbound contract scaffold — refined for lane S1U1.
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';

/** Journal, for ONE (pullRequest, headOid) pair, the shadow merge decision the merge pass would reach. */
export interface DecideShadowMergeRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repoDigest: string;   // 12 lowercase hex
  readonly projectId: string;
  readonly policy: MergeRepoPolicy;  // the repository policy, exactly the decider's input
  readonly pullRequest: number;  // positive safe integer
  readonly headOid: string;      // 40 lowercase hex
  readonly deadlineIso: string;  // the budget deadline (D-DT9)
}

export type DecideShadowMergeOutcome =
  | 'journalled'
  | 'already-journalled'
  | 'not-ready'
  | 'refused'
  | 'budget-exhausted';

export interface DecideShadowMergeResult {
  readonly outcome: DecideShadowMergeOutcome;
  readonly reasonCode: string | null;
  readonly journalKey: string | null;
}

export interface DecideShadowMergePort {
  decideShadowMerge(request: DecideShadowMergeRequest): Promise<DecideShadowMergeResult>;
}
