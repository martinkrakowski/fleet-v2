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
}

export interface DecisionTransportPort {
  /** Verified answer only; absence and ambiguity are returned, not invented. */
  readDecisionAnswer(requestId: string): Promise<DecisionAnswer>;
}
