// @generated inbound contract scaffold — refined for the one-way-door station.
/**
 * CheckOwnerDecisionPort: report whether one recorded coordination request
 * currently authorizes the owner decision bound to it at an exact candidate
 * head. Only the request's own authorization rule decides: an approved state
 * with a recorded grant and decision revision, whose action scope is
 * `owner-decision:<requestId>` and whose expected commit equals the candidate
 * head. Anything the context cannot read is `unknown`, never `approved`, and
 * the caller must read `unknown` as a blocked one-way door.
 */

export interface CheckOwnerDecisionRequest {
  readonly requestId: string;
  readonly candidateHeadSha: string;
}

export type CheckOwnerDecisionResult =
  | { readonly outcome: 'approved'; readonly requestId: string; readonly grantId: string }
  | { readonly outcome: 'not-approved'; readonly requestId: string; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly requestId: string; readonly reason: string };

export interface CheckOwnerDecisionPort {
  /** Resolve one recorded owner decision against a candidate head. */
  checkOwnerDecision(request: CheckOwnerDecisionRequest): Promise<CheckOwnerDecisionResult>;
}