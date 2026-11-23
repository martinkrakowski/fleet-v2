// @generated inbound contract scaffold — refined for step 5.
/**
 * ResolveActionAuthorizationPort: return an applicable grant from approved
 * policy or a verified scoped decision. Pending, ambiguous or scope-mismatched
 * authority stays blocked with a reason; absence of a grant is never an
 * authorization.
 */

export interface ResolveActionAuthorizationRequest {
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string;
  readonly authorizationGrantId?: string;
  /**
   * The 64-lowercase-hex digest of the plan the relaunch-apply grant is bound
   * to (AR3a). The grant is head-free: it authorizes a plan digest, never a
   * commit. Only the relaunch-apply resolve reads it; a missing or malformed
   * one fails closed as `invalid-request`.
   */
  readonly proposalDigest?: string;
  /**
   * The attempt the action is for (CO24e). A grant that records an attempt must match it; an
   * owner grant that records none is bound to it by this resolve.
   */
  readonly attemptId?: string;
  /**
   * The release root the action names (CO14 follow-up). A release grant
   * recorded for one root never authorizes an operation on another.
   */
  readonly releaseRoot?: string;
  /**
   * The deterministic action id this resolve is resuming (CO14 follow-up). A
   * release grant already durably consumed by exactly this action id resolves
   * again idempotently, so a crash between the consumption and the release's
   * write is recoverable: the retry resolves, observes the same consumption
   * and completes. A different action id never resumes a consumed grant.
   */
  readonly resumeActionId?: string;
  readonly repository?: { readonly owner: string; readonly repo: string } | string;
  readonly pullRequestNumber?: number;
}

export type ResolveActionAuthorizationResult =
  | {
      readonly outcome: 'authorized';
      readonly grantId: string;
      readonly requestId: string;
      readonly expectedHeadSha: string;
      readonly policyRevision: string;
      /** The root the granted release grant is bound to; absent on every other grant. */
      readonly releaseRoot?: string;
    }
  | {
      readonly outcome: 'blocked';
      readonly reason: string;
    };

export interface ResolveActionAuthorizationPort {
  resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult>;
}
