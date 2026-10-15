// @generated outbound contract scaffold — refined for migration step 1.
/**
 * AcceptanceAssessmentPort: consume the evidence context's exact-head
 * assessment without importing its repositories or mutating its aggregates.
 * Pending, unknown or stale evidence never becomes a pass.
 */

export interface AcceptanceAssessmentRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
}

export type AcceptanceAssessmentResult =
  | { readonly outcome: 'accepted'; readonly receiptId: string; readonly assessedHeadSha: string }
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface AcceptanceAssessmentPort {
  /** Assess the exact candidate head; a moved head is never assessed as-is. */
  assessHeadAcceptance(request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult>;
}
