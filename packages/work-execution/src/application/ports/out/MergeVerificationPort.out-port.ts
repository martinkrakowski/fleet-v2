// Implemented outbound contract — merge verification station (DT8).
/**
 * MergeVerificationPort asks the evidence context's procedure for the one
 * fact the merge-pass decider needs: the verification receipt for the head.
 *
 * Identity, not head-only: the returned assessment and the selected receipt
 * must match the expected assessment id (derived from the attempt), project,
 * attempt, exact candidate head and policy revision. Evidence records carry
 * no repository identity, so repository scope comes from the trusted
 * queue-entry-to-attempt relationship the merge-pass caller resolves before
 * invoking this adapter; this port never looks a repository up.
 */

export interface MergeVerificationReadRequest {
  readonly repoDigest: string;
  readonly headOid: string;
  readonly macosProcedure: string;
  readonly policyRevision: string;
  readonly projectId: string;
  readonly attemptId: string | null;
  readonly deadlineIso: string;
}

/** The trigger path adds the caller-supplied evidence-identity fields. */
export interface MergeVerificationTriggerRequest extends MergeVerificationReadRequest {
  readonly hostId: string;
  readonly implementerModel: string;
  readonly requiredChecks: readonly string[];
}

export type MergeVerificationReasonCode =
  | 'procedure-not-required'
  | 'no-receipt'
  | 'no-attempt-identity'
  | 'other-head-receipt'
  | 'receipt-failed'
  | 'policy-unreadable'
  | 'evidence-unreadable'
  | 'budget-exhausted';

export type MergeVerificationResult =
  | {
      readonly outcome: 'verified';
      readonly receiptHeadOid: string;
      readonly receiptId: string;
      readonly verifiedBy: 'procedure';
    }
  | { readonly outcome: 'unknown'; readonly reasonCode: MergeVerificationReasonCode };

export interface MergeVerificationPort {
  readVerification(request: MergeVerificationReadRequest): Promise<MergeVerificationResult>;
  runVerification(request: MergeVerificationTriggerRequest): Promise<MergeVerificationResult>;
}
