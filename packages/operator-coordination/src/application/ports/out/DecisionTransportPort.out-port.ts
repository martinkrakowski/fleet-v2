// @generated outbound contract scaffold — refined for step 5.
/**
 * DecisionTransportPort: read and verify the existing Waves signed-answer
 * protocol or an explicit owner-recorded local decision. An unverified or
 * absent answer is reported as awaiting, never upgraded to approval, and no
 * token or credential is surfaced through this port.
 */

export type DecisionState = 'approved' | 'declined' | 'awaiting-decision';

export interface DecisionAnswer {
  readonly state: DecisionState;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
  readonly signature?: string | null;
  /**
   * A named owner-key refusal (`owner-key-env-mismatch` or
   * `owner-key-unpinned`) reported on an otherwise approving answer. A
   * refusal keeps the state `awaiting-decision` and authorizes nothing.
   */
  readonly refusalReason?: string;
}

export interface DecisionAnswerQuery {
  readonly requestId: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
}

export interface DecisionTransportPort {
  /** Verified answer only; absence and ambiguity are returned, not invented. */
  readDecisionAnswer(query: DecisionAnswerQuery): Promise<DecisionAnswer>;
}
