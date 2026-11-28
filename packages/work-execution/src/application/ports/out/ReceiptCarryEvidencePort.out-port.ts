// @generated outbound contract scaffold — refined for U6 (receipt carry).
/**
 * ReceiptCarryEvidencePort reads the git facts that qualify a Tier 2 premerge
 * receipt carry across a base-merge head update (plan #1385): the new head's
 * parents, whether its merged-in parent is reachable from the base branch,
 * the clean automatic merge tree versus the new head's tree, and the PR's own
 * changed paths. It reads a bare mirror only (no ref changes; the clean-merge tree it computes is
 * an unreferenced object); the live checkout is never touched. It decides nothing: `qualifyBaseMergeCarry` does.
 */

/** The evidence question for one PR head move. */
export interface ReceiptCarryEvidenceRequest {
  readonly repositoryDigest: string; // names the mirror under <stateDir>/mirrors
  readonly reviewedHeadSha: string; // 40-hex; the head the receipt is bound to
  readonly newHeadSha: string; // 40-hex; the PR head after the forge update
  readonly baseBranch: string; // `main` or `chain/<name>`
  readonly deadlineIso: string;
}

export type ReceiptCarryEvidenceResult =
  | {
      readonly ok: true;
      /** The new head's parents in order; null when unreadable. */
      readonly newHeadParents: readonly string[] | null;
      /** Whether the second parent is an ancestor of the base branch; null when unknown. */
      readonly secondParentOnBase: boolean | null;
      /** `git merge-base(reviewedHeadSha, secondParent)`; null when unknown. */
      readonly mainRangeBaseSha: string | null;
      /** The tree of the clean automatic merge of reviewed head and second parent; null on conflict or error. */
      readonly automaticMergeTreeSha: string | null;
      readonly newHeadTreeSha: string | null;
      /** The PR's own changed paths: merge-base(base, new head)..new head; null when unreadable. */
      readonly prChangedPaths: readonly string[] | null;
    }
  | { readonly ok: false; readonly reason: 'refused'; readonly code: 'bad-digest' | 'bad-sha' | 'bad-base' | 'no-mirror' };

export interface ReceiptCarryEvidencePort {
  readCarryEvidence(request: ReceiptCarryEvidenceRequest): Promise<ReceiptCarryEvidenceResult>;
}
