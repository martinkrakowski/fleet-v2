// ReviewAssessmentPort: open the evidence context's assessment for one attempt
// at one exact head before a conductor review (plan §3.3). Opened or existing
// is open; anything else is unavailable with a reason code.

export interface OpenReviewAssessmentRequest {
  readonly attemptId: string;
  readonly projectId: string;
  /** 40 lowercase hex. */
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly implementerModel: string;
  /** The brief's required checks; non-empty (the evidence context refuses an assessment with none). */
  readonly requiredChecks: readonly string[];
}

export type OpenReviewAssessmentResult =
  | { readonly outcome: 'open' }
  | {
      readonly outcome: 'unavailable';
      readonly reason: 'invalid-request' | 'not-configured' | 'head-mismatch' | 'terminal' | 'unreadable';
    };

export interface ReviewAssessmentPort {
  openReviewAssessment(request: OpenReviewAssessmentRequest): Promise<OpenReviewAssessmentResult>;
}
