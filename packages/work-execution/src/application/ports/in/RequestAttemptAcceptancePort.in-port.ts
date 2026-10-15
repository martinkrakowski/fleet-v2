// @generated inbound contract scaffold — refined for migration step 1.
/**
 * RequestAttemptAcceptancePort: request verification and independent review
 * of the exact candidate head and retain a scoped acceptance receipt. The
 * reviewer's model is never the implementer's; a moved head invalidates the
 * request.
 */

export interface RequestAttemptAcceptanceRequest {
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly reviewerModel: string;
}

export type RequestAttemptAcceptanceResult =
  | { readonly outcome: 'accepted'; readonly candidateHeadSha: string; readonly receiptId: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RequestAttemptAcceptancePort {
  /** Request acceptance of the exact candidate head; never of a moved one. */
  requestAttemptAcceptance(
    request: RequestAttemptAcceptanceRequest,
  ): Promise<RequestAttemptAcceptanceResult>;
}
