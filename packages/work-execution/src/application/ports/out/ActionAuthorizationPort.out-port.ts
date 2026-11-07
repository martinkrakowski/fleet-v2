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
   * CO14b: the release root the action runs on. Required for release action
   * kinds (a release grant authorizes only the root it names); absent for
   * forge actions, which carry no root.
   */
  readonly root?: string;
}

export type ResolveActionAuthorizationResult =
  | { readonly outcome: 'granted'; readonly authorizationGrantId: string; readonly root?: string }
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
   * CO14b: the release root the action runs on. Required for release action
   * kinds; the consume compares it against the root the grant was resolved
   * for, so a grant cannot be moved to another root after it was issued.
   */
  readonly root?: string;
}

export type ConsumeActionAuthorizationResult =
  | { readonly outcome: 'consumed'; readonly actionId: string }
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * CO14b: does a recorded consumption prove that THIS action already consumed
 * a grant for this root and head? Only a consumption by the same action id,
 * action kind, head and root counts; a missing or foreign grant is `absent`.
 */
export interface VerifyConsumedActionAuthorizationRequest {
  readonly actionId: string;
  readonly projectId: string;
  readonly actionKind: AuthorizedActionKind;
  readonly expectedHeadSha: string;
  readonly root: string;
}

export type VerifyConsumedActionAuthorizationResult =
  | { readonly outcome: 'consumed' }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unknown' };

export interface ActionAuthorizationPort {
  /** CO14b: proof that this exact action consumed a grant (resume of an interrupted swap). */
  verifyConsumedActionAuthorization?(
    request: VerifyConsumedActionAuthorizationRequest,
  ): Promise<VerifyConsumedActionAuthorizationResult>;

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
