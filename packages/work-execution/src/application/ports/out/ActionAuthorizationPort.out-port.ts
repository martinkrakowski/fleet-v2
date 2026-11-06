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
}

export type ResolveActionAuthorizationResult =
  | { readonly outcome: 'granted'; readonly authorizationGrantId: string }
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
}

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
