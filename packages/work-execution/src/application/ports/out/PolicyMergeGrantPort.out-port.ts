// @generated outbound contract scaffold — refined for AM4a-1.
/**
 * PolicyMergeGrantPort: issue one `merge-pr` policy grant authorised by `policy:autoMerge@<settingRevision>`
 * (AM3a's `IssuePolicyForgeGrantPort` behind the composition root); it never decides eligibility.
 */

export interface PolicyMergeGrantRequest {
  readonly projectId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly policyRevision: string;
  readonly acceptanceReceiptId: string;
  readonly settingRevision: string;
}

export type PolicyMergeGrantResult =
  | { readonly outcome: 'issued'; readonly grantId: string; readonly decisionRevision: string }
  | { readonly outcome: 'superseded' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface PolicyMergeGrantPort {
  issuePolicyMergeGrant(request: PolicyMergeGrantRequest): Promise<PolicyMergeGrantResult>;
}
