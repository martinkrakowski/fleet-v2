// @generated outbound contract scaffold — refined for lane DT6a.
/**
 * MergeForgeActionPort: perform one repo-scoped forge action of the merge
 * pass (merge-pr, update-branch, post-status or create-branch) through a stable action id
 * at the expected head. Unlike ForgeActionPort the request is repo-scoped
 * and carries no attempt coordinates; every method takes a deadlineIso per
 * the daemon budget rule (plan §3.1). A status field is refused on any kind
 * but post-status, create-branch creates only a chain/<name> branch from main
 * at the expected commit (an existing branch at that commit is already applied,
 * one at another commit is a refusal), a moved head is refused before any write, and an outcome
 * that cannot be established is ambiguous for reconciliation, never a guess.
 */

import type { ForgeRefusalKind } from '../../../domain/coordination-keys.js';

export interface MergeForgeActionBase {
  readonly actionId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  readonly branchName: string;
  readonly expectedHeadSha: string;
  readonly deadlineIso: string;
}

/** Create `chain/<name>` from `main` at the expected commit; carries no pull request and no status. */
export interface MergeForgeCreateBranchRequest {
  readonly kind: 'create-branch';
  readonly actionId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly branchName: string;
  readonly sourceBranch: 'main';
  readonly expectedHeadSha: string;
  readonly deadlineIso: string;
}

export type MergeForgeActionRequest =
  | MergeForgeCreateBranchRequest
  | (MergeForgeActionBase & { readonly kind: 'merge-pr' })
  | (MergeForgeActionBase & { readonly kind: 'update-branch' })
  | (MergeForgeActionBase & {
      readonly kind: 'post-status';
      readonly status: {
        readonly context: 'premerge';
        readonly state: 'success' | 'failure';
        readonly description: string;
      };
    });

export type MergeForgeActionResult =
  | { readonly outcome: 'executed'; readonly headSha: string }
  | { readonly outcome: 'ambiguous'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string; readonly refusalKind: ForgeRefusalKind };

export interface MergeBranchHeadRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly branchName: string;
  readonly deadlineIso: string;
}

/** The head of one branch as the forge reports it; unknown stays `unavailable`, never `not-found`. */
export type MergeBranchHeadResult =
  | { readonly outcome: 'found'; readonly headSha: string }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface MergeForgeActionPort {
  performMergeForgeAction(request: MergeForgeActionRequest): Promise<MergeForgeActionResult>;
  readMergeBranchHead(request: MergeBranchHeadRequest): Promise<MergeBranchHeadResult>;
  isConfigured(): boolean;
}
