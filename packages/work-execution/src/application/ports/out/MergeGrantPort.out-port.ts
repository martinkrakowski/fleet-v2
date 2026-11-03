// @generated outbound contract scaffold — refined for lane DT6b.
/**
 * MergeGrantPort: issue one merge policy grant for the merge pass. A
 * conducted merge-queue entry (with an attempt) grants through the AM3a
 * attempt-bound path exactly as PolicyMergeGrantPort does today; a CLI-enqueued
 * entry has no attempt, so the attempt-less variant grants bound to
 * (repository, pullRequestNumber, expectedHeadSha) and authorised by
 * policy:merge@<settingRevision>. Every method takes a deadlineIso per the
 * daemon budget rule; the grant path performs no forge I/O, so the deadline is
 * carried only. It never decides eligibility.
 */

import type { PolicyMergeGrantRequest } from './PolicyMergeGrantPort.out-port.js';
export const MERGE_GRANT_FORGE_KINDS = ['merge-pr', 'update-branch', 'post-status'] as const;
export type MergeGrantForgeKind = (typeof MERGE_GRANT_FORGE_KINDS)[number];

export interface MergeGrantRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface MergeGrantBase {
  readonly projectId: string;
  readonly repository: MergeGrantRepositoryRef;
  readonly pullRequestNumber: number;
  readonly expectedHeadSha: string;
  /** 12 lower-case hex; the revision that authorises the grant. */
  readonly settingRevision: string;
  readonly deadlineIso: string;
}

export type MergeGrantRequest =
  | (MergeGrantBase & { readonly kind: 'attempt-bound' } & Omit<PolicyMergeGrantRequest, 'projectId' | 'expectedHeadSha' | 'settingRevision'>)
  | (MergeGrantBase & { readonly kind: 'attempt-less'; readonly forgeKind: MergeGrantForgeKind });

export type MergeGrantResult =
  | { readonly outcome: 'issued'; readonly requestId: string; readonly grantId: string; readonly decisionRevision: string; readonly cancelledGrantIds: readonly string[] }
  | { readonly outcome: 'superseded'; readonly requestId: string; readonly grantId: string; readonly cancelledGrantIds: readonly string[]; readonly unresolvedGrantIds: readonly string[] }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface MergeGrantPort {
  issueMergeGrant(request: MergeGrantRequest): Promise<MergeGrantResult>;
}
