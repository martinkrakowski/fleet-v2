// @generated outbound contract scaffold — refined for lane DT6a.
/**
 * MergeForgeActionPort: perform one repo-scoped forge action of the merge
 * pass (merge-pr, update-branch or post-status) through a stable action id
 * at the expected head. Unlike ForgeActionPort the request is repo-scoped
 * and carries no attempt coordinates; every method takes a deadlineIso per
 * the daemon budget rule (plan §3.1). A status field is refused on any kind
 * but post-status, a moved head is refused before any write, and an outcome
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

export type MergeForgeActionRequest =
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

export interface MergeForgeActionPort {
  performMergeForgeAction(request: MergeForgeActionRequest): Promise<MergeForgeActionResult>;
  isConfigured(): boolean;
}
