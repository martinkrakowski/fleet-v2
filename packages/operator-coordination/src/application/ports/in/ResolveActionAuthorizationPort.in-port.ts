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
}

export type ResolveActionAuthorizationResult =
  | {
      readonly outcome: 'authorized';
      readonly grantId: string;
      readonly requestId: string;
      readonly expectedHeadSha: string;
      readonly policyRevision: string;
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
