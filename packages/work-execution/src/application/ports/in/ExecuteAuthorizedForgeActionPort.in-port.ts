// @generated inbound contract scaffold — refined for migration step 1.
/**
 * ExecuteAuthorizedForgeActionPort: apply a scoped push/PR or merge action
 * only when an applicable authorization grant and current-head evidence
 * match. A moved head is refused; lanes gain no forge credentials here.
 */

import type { ForgeActionKind, ForgeRefusalKind } from '../../../domain/coordination-keys.js';

export interface ExecuteAuthorizedForgeActionRequest {
  readonly actionId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly kind: ForgeActionKind;
  readonly expectedHeadSha: string;
  readonly authorizationGrantId: string;
  /**
   * Who authorised the action (auto-merge plan A8): `policy:autoMerge@<rev>` or
   * `policy:conductor@<rev>` for a policy grant. Absent means an owner grant.
   * Set only by in-process policy callers; the HTTP entry point drops it.
   */
  readonly authorizedBy?: string;
}

export type ExecuteAuthorizedForgeActionResult =
  | { readonly outcome: 'executed'; readonly pullRequestNumber?: number; readonly headSha: string }
  | {
      readonly outcome: 'refused';
      readonly reason: string;
      /** Set only when the forge itself refused, after the grant was consumed (plan §4, A13). */
      readonly forgeRefusalKind?: ForgeRefusalKind;
      /** Set only when the forge outcome was ambiguous; reconciliation decides, never a retry (§4). */
      readonly forgeAmbiguous?: true;
    };

export interface ExecuteAuthorizedForgeActionPort {
  /** Execute one authorized forge action against the expected head only. */
  executeAuthorizedForgeAction(
    request: ExecuteAuthorizedForgeActionRequest,
  ): Promise<ExecuteAuthorizedForgeActionResult>;
}
