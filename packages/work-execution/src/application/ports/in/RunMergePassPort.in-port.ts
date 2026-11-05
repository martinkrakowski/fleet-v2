// @generated inbound contract scaffold — refined for lane DT9a.
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';

/** One bounded merge pass for one repository, in shadow mode (DT9a). */
export interface RunMergePassRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repoDigest: string;   // 12 lowercase hex
  readonly projectId: string;    // the evidence project, for the procedure receipt
  readonly policy: MergeRepoPolicy;  // the repository policy, exactly the decider's input
  readonly deadlineIso: string;  // the pass budget deadline (D-DT9)
}

export type MergePassEntryDecision = 'journalled' | 'no-action' | 'live-deferred';

export interface MergePassEntryReport {
  readonly entryId: string;
  readonly head12: string;
  readonly decision: MergePassEntryDecision;
  readonly reasonCode: string | null;  // a lowercase token: the decider's reason or the shadow reason
  readonly journalKey: string | null;
}

export interface RunMergePassResult {
  readonly outcome: 'completed' | 'budget-exhausted' | 'refused';
  readonly reasonCode: string | null;
  readonly entries: readonly MergePassEntryReport[];
}

export interface RunMergePassPort {
  runMergePass(request: RunMergePassRequest): Promise<RunMergePassResult>;
}
