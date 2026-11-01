// @generated outbound contract scaffold — refined for K6-2.
/**
 * ConductorForgeGrantPort: issue one push-and-open-pr, push-to-pr or
 * post-status policy grant for an accepted attempt at an exact head under
 * `policy:conductor@<revision>` (AM3a); it never decides eligibility and
 * never issues a merge grant (those belong to `policy:autoMerge@<rev>`,
 * AM4a).
 */

export interface ConductorForgeGrantRequest {
  readonly projectId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  /** The conductor grant kinds; `merge-pr` is never one. */
  readonly forgeKind: 'push-and-open-pr' | 'push-to-pr' | 'post-status';
  readonly expectedHeadSha: string;
  /** The work order's own policy revision (A3), unrelated to the conductor setting revision. */
  readonly policyRevision: string;
  readonly acceptanceReceiptId: string;
}

export type ConductorForgeGrantResult =
  | { readonly outcome: 'issued'; readonly grantId: string; readonly decisionRevision: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ConductorForgeGrantPort {
  /** Issue one conductor push grant; never decides eligibility, never a merge grant. */
  issueConductorForgeGrant(request: ConductorForgeGrantRequest): Promise<ConductorForgeGrantResult>;
}
