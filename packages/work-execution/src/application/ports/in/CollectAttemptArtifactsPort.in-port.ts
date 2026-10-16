// @generated inbound contract scaffold — refined for migration step 1.
/**
 * CollectAttemptArtifactsPort: after matching runner completion, inspect the
 * commit delta and collect identity-bound artifacts; explicitly record missing
 * notes. Only a matching ended observation permits collection.
 */

import type {
  CollectedAttemptArtifacts,
  CommandCompletionReceipt,
} from '../../../domain/execution-records.js';

export interface CollectAttemptArtifactsRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly worktreePath?: string;
  readonly baseCommit?: string;
  readonly expectedArtifacts: readonly string[];
  readonly completionReceipt: CommandCompletionReceipt;
}

export type CollectAttemptArtifactsResult =
  | { readonly outcome: 'collected'; readonly artifacts: CollectedAttemptArtifacts }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface CollectAttemptArtifactsPort {
  /** Collect artifacts only for an attempt whose runner session ended authoritatively. */
  collectAttemptArtifacts(
    request: CollectAttemptArtifactsRequest,
  ): Promise<CollectAttemptArtifactsResult>;
}
