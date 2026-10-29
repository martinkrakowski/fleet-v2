// @generated inbound contract scaffold — refined for step 4.
/**
 * Open a pending assessment for one attempt at one exact head and policy,
 * idempotently, so an independent review can run before any verification
 * (follow-up (b)). The conductor may call it on every review act. An
 * assessment at another head, under another policy or in a terminal state
 * is refused, never overwritten and never marked stale.
 */

export interface OpenEvidenceAssessmentRequest {
  readonly attemptId: string;
  readonly projectId: string;
  /** Exactly 40 lowercase hex characters (the candidate commit sha). */
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  /** The implementer seat the attempt was dispatched on; recorded at creation. */
  readonly implementerModel: string;
  readonly requiredChecks: readonly string[];
  readonly nowIso?: string;
}

export type OpenEvidenceAssessmentResult =
  | { readonly outcome: 'opened' | 'exists'; readonly assessmentId: string }
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-request' | 'head-mismatch' | 'terminal' | 'store-unreadable';
    };

export interface OpenEvidenceAssessmentPort {
  openEvidenceAssessment(request: OpenEvidenceAssessmentRequest): Promise<OpenEvidenceAssessmentResult>;
}
