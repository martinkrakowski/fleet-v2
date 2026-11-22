// @generated outbound contract scaffold — refined for migration step 1.
/**
 * ActionAuthorizationPort: obtain and durably consume an applicable
 * scope-bound grant from operator coordination. Pending, ambiguous or absent
 * authority blocks the action; a consumed grant never authorizes a second
 * unrelated action.
 */

import type { AuthorizedActionKind } from '../../../domain/coordination-keys.js';

export interface ResolveActionAuthorizationRequest {
  readonly actionId: string;
  readonly projectId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly actionKind: AuthorizedActionKind;
  readonly expectedHeadSha: string;
  readonly policyRevision: string;
  /**
   * The release root the action names (CO14 follow-up). A release grant bound
   * to one root never authorizes an operation on another root.
   */
  readonly releaseRoot?: string;
  /**
   * The deterministic action id this resolve resumes (CO14 follow-up), derived
   * from `actionId` at the adapter boundary: a release grant already durably
   * consumed by exactly this action id resolves again, so a crash between the
   * consumption and the release's write is recoverable.
   */
  readonly resumeActionId?: string;
}

export type ResolveActionAuthorizationResult =
  | {
      readonly outcome: 'granted'; readonly authorizationGrantId: string;
      /** The root the granted release grant is bound to; absent on every other grant. */
      readonly releaseRoot?: string;
    }
  | { readonly outcome: 'blocked'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface ConsumeActionAuthorizationRequest {
  readonly authorizationGrantId: string;
  readonly actionId: string;
  readonly actionKind: AuthorizedActionKind;
  /**
   * Head the grant was scoped to at resolve time. Optional because the
   * resolving runtime retains the coordinates and scopes the consumption
   * when the work-side request carries only grant and action identities.
   */
  readonly expectedHeadSha?: string;
  /**
   * Attempt the grant was bound to at resolve time. Optional for the same
   * reason: the recorded coordinates scope the consumption.
   */
  readonly attemptId?: string;
  /**
   * The release root the consumption names (CO14 follow-up); compared with the
   * root the grant was bound to at resolve time.
   */
  readonly releaseRoot?: string;
}

export type ConsumeActionAuthorizationResult =
  | { readonly outcome: 'consumed'; readonly actionId: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ActionAuthorizationPort {
  /** Obtain an applicable scope-bound grant; pending authority blocks the action. */
  resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult>;

  /** Durably bind one grant to one action; a second consumption is refused. */
  consumeActionAuthorization(
    request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult>;

  /**
   * C2': the scoped, one-way owner approval for removing one attempt's
   * unsealed worktree. Approved only through a signed owner decision on a
   * coordination request bound to the exact attempt, head and worktree-path
   * scope, consumed once via the authorization store. Pending or absent
   * authority blocks; an unreadable authorization answers unknown.
   */
  authorizeUnsealedWorktreeRemoval?(
    request: AuthorizeUnsealedWorktreeRemovalRequest,
  ): Promise<AuthorizeUnsealedWorktreeRemovalResult>;

  /**
   * The standing shadow import grant's head-free resolve. The grant is bound
   * by its digest-bound request id, its exact repository and its capped
   * expiry — never by a commit — so no head coordinate is carried here. The
   * caller supplies its own clock reading (`nowIso`); the clock behind it
   * stays with the caller, never with the request payload.
   */
  authorizeShadowImport?(
    request: AuthorizeShadowImportRequest,
  ): Promise<AuthorizeShadowImportResult>;

  /**
   * The relaunch-apply grant's head-free resolve. The grant is bound to the
   * plan digest it names and its capped expiry; the caller supplies its own
   * clock reading (`nowIso`). Pending and unknown results block the apply.
   */
  authorizeRelaunchApply?(request: AuthorizeRelaunchApplyRequest): Promise<AuthorizeRelaunchApplyResult>;
}

export interface AuthorizeShadowImportRequest {
  readonly projectId: string;
  readonly grantId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly nowIso: string;
}

export type AuthorizeShadowImportResult =
  | { readonly outcome: 'authorized'; readonly grantId: string }
  | { readonly outcome: 'blocked'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface AuthorizeUnsealedWorktreeRemovalRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly expectedHeadSha: string;
  readonly nowIso: string;
}

export type AuthorizeUnsealedWorktreeRemovalResult =
  | { readonly outcome: 'approved'; readonly approvalReference: string }
  | { readonly outcome: 'blocked'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface AuthorizeRelaunchApplyRequest {
  /** 64 lowercase hex: the plan digest the grant must name. */
  readonly planDigest: string;
  readonly grantId: string;
  readonly nowIso: string;
}

export type AuthorizeRelaunchApplyResult =
  | { readonly outcome: 'authorized'; readonly grantId: string }
  | { readonly outcome: 'blocked'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };
