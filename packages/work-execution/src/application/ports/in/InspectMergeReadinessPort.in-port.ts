// @generated inbound contract scaffold — refined for lane CO25.
import type { ForgeMergeRepositoryRef } from '../out/ForgeMergeReadPort.out-port.js';

export type MergeReadinessWaitingReason =
  | 'not-open'
  | 'head-moved'
  | 'checks-pending'
  | 'checks-missing'
  | 'checks-failed'
  | 'threads-unresolved'
  | 'not-mergeable'
  | 'wait-timeout';

export type MergeReadinessUnknownReason =
  | 'invalid-request'
  | 'forge-not-configured'
  | 'pr-not-found'
  | 'forge-unavailable'
  | 'budget-exhausted'
  | 'threads-unknown'
  | 'contexts-unknown'
  | 'merge-state-unknown';

export interface InspectMergeReadinessRequest {
  readonly repository: ForgeMergeRepositoryRef;
  readonly pullRequest: number;
  /** The head the caller expects; null when the caller has no expected head. */
  readonly expectedHeadOid: string | null;
  /** The context names that must be finished and green; an empty list requires none. */
  readonly requiredContexts: readonly string[];
  /** The budget for the forge read. */
  readonly deadlineIso: string;
}

export type InspectMergeReadinessResult =
  | { readonly outcome: 'ready'; readonly headOid: string }
  | { readonly outcome: 'still-waiting'; readonly reason: MergeReadinessWaitingReason }
  | { readonly outcome: 'unknown'; readonly reason: MergeReadinessUnknownReason };

export interface InspectMergeReadinessPort {
  inspectMergeReadiness(request: InspectMergeReadinessRequest): Promise<InspectMergeReadinessResult>;
}
