// @generated inbound contract scaffold — refined for AM4a-1.
/**
 * AutoMergeAttemptPort: merge one accepted attempt at its collected head under `policy.autoMerge`, or
 * route the exception (§4). Off is today's behaviour: nothing read beyond the setting, nothing written.
 * Unknown is never eligible; a named one-way door or an unlabelled lane is never merged by policy.
 */

import type { AutoMergeReason } from '../../../domain/auto-merge.js';

export interface AutoMergeAttemptRequest {
  readonly attemptId: string;
  /**
   * The run's recorded branch (KF-5b) forwarded to the `merge-pr` action
   * request; absent keeps the forge use case's `feat/<laneId>` default.
   */
  readonly branchName?: string;
}

export type AutoMergeRoute = 'none' | 'attention' | 'owner-question';

export type AutoMergeRouteOutcome = 'none' | 'recorded' | 'exists' | 'refused' | 'failed' | 'not-wired';

export type AutoMergeAttemptResult =
  | { readonly outcome: 'off' }
  | {
      readonly outcome: 'merged';
      readonly attemptId: string;
      readonly headSha: string;
      readonly pullRequestNumber?: number;
      readonly decisionRevision: string;
    }
  | {
      readonly outcome: 'waiting';
      readonly reason: 'ci-pending-first-look';
      readonly headSha: string;
      readonly firstLookAtIso: string;
    }
  | {
      readonly outcome: 'not-merged';
      readonly reason: AutoMergeReason;
      readonly route: AutoMergeRoute;
      readonly routeOutcome: AutoMergeRouteOutcome;
      readonly detail: string | null;
    };

export interface AutoMergeAttemptPort {
  autoMergeAttempt(request: AutoMergeAttemptRequest): Promise<AutoMergeAttemptResult>;
}
