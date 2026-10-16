// Outbound contract for reading acceptance assessment evidence before forge actions.

export interface ReadAcceptanceRequest {
  readonly attemptId: string;
  readonly candidateHeadSha: string;
}

export interface AcceptanceAssessmentSnapshot {
  readonly state: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly acceptanceReceiptId: string | null;
}

export type ReadAcceptanceResult =
  | { readonly outcome: 'found'; readonly assessment: AcceptanceAssessmentSnapshot }
  | { readonly outcome: 'not-found'; readonly reason: string };

export interface AcceptanceEvidencePort {
  /** Read the evidence context's assessment for an attempt and candidate head. */
  readAcceptance(request: ReadAcceptanceRequest): Promise<ReadAcceptanceResult>;
}
