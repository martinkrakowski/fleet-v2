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
   * A known pull-request number (WB5b): forwarded to the forge for PR
   * actions and used to resolve the merge's (repository, number) without
   * parsing journal text. Must be a positive integer when present.
   */
  readonly pullRequestNumber?: number;
  /**
   * Who authorised the action (auto-merge plan A8): `policy:autoMerge@<rev>` or
   * `policy:conductor@<rev>` for a policy grant. Absent means an owner grant.
   * Set only by in-process policy callers; the HTTP entry point drops it.
   */
  readonly authorizedBy?: string;
  /**
   * PR title/body forwarded to the forge only for `push-and-open-pr`; absent
   * keeps the adapter's defaults (K6-2). Never read from lane output.
   */
  readonly title?: string;
  readonly body?: string;
  /**
   * The run's recorded branch (KF-5b): a safe branch name validated like the
   * forge read's rule; absent keeps the use case's `feat/<laneId>` default,
   * except for `post-status`, which refuses when it is absent.
   */
  readonly branchName?: string;
  /**
   * The PR base branch, forwarded to the forge only for `push-and-open-pr`
   * (CB-D2); absent keeps the forge's default base.
   */
  readonly baseBranch?: string;
  /**
   * The single conducted-open label (CP1B): `tier:1` or `tier:2`, forwarded
   * to the forge only for `push-and-open-pr`. Absent on every other caller.
   */
  readonly tierLabel?: 'tier:1' | 'tier:2';
  /**
   * Status to post for `post-status`: the pre-merge review receipt of the
   * expected head. Only `post-status` may carry it.
   */
  readonly status?: {
    readonly context: 'premerge';
    readonly state: 'success' | 'pending' | 'failure';
    readonly description: string;
  };
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
