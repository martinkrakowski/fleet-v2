// @generated inbound contract scaffold — refined for migration step 1.
/**
 * ExecuteAuthorizedForgeActionPort: apply a scoped push/PR or merge action
 * only when an applicable authorization grant and current-head evidence
 * match. A moved head is refused; lanes gain no forge credentials here.
 */

export interface ExecuteAuthorizedForgeActionRequest {
  readonly actionId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly kind: 'push-and-open-pr' | 'merge-pr';
  readonly expectedHeadSha: string;
  readonly authorizationGrantId: string;
}

export type ExecuteAuthorizedForgeActionResult =
  | { readonly outcome: 'executed'; readonly pullRequestNumber?: number; readonly headSha: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ExecuteAuthorizedForgeActionPort {
  /** Execute one authorized forge action against the expected head only. */
  executeAuthorizedForgeAction(
    request: ExecuteAuthorizedForgeActionRequest,
  ): Promise<ExecuteAuthorizedForgeActionResult>;
}
