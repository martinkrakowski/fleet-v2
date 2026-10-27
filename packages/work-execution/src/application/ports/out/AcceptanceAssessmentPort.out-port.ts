// @generated outbound contract scaffold — refined for migration step 1.
/**
 * AcceptanceAssessmentPort: consume the evidence context's exact-head
 * assessment without importing its repositories or mutating its aggregates.
 * Pending, unknown or stale evidence never becomes a pass.
 * Blocker kinds travel as data; `reason` is for display.
 */

export interface AcceptanceAssessmentRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
}

/**
 * Kinds of acceptance blocker (auto-merge plan A11), declared here on the
 * consumer side; structurally identical to evidence-and-acceptance's
 * AcceptanceBlockerKind. Only `ci-pending` means "not yet".
 */
export type AssessmentBlockerKind =
  | 'ci-pending'
  | 'ci-failed'
  | 'threads-unresolved'
  | 'threads-unreadable'
  | 'review-missing'
  | 'door'
  | 'stale'
  | 'other';

export interface AssessmentBlocker {
  readonly kind: AssessmentBlockerKind;
  /** Display text only; never parsed. */
  readonly text: string;
}

export type AcceptanceAssessmentResult =
  | { readonly outcome: 'accepted'; readonly receiptId: string; readonly assessedHeadSha: string }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
      /**
       * Why acceptance did not pass, as data (A11). Absent means the producer named
       * no kind: treat it as one `other` blocker, never as pending and never as a pass.
       */
      readonly blockerDetails?: readonly AssessmentBlocker[];
    }
  | {
      readonly outcome: 'unknown';
      readonly reason: string;
      /**
       * Why acceptance did not pass, as data (A11). Absent means the producer named
       * no kind: treat it as one `other` blocker, never as pending and never as a pass.
       */
      readonly blockerDetails?: readonly AssessmentBlocker[];
    };

export interface AcceptanceAssessmentPort {
  /** Assess the exact candidate head; a moved head is never assessed as-is. */
  assessHeadAcceptance(request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult>;
}
