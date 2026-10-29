// @generated outbound contract scaffold — refined for lane CT-2b.
/**
 * Read-only forge ancestry read port (CT-2b): answers whether one commit
 * contains another as an ancestor (a merged PR head containing the lane head)
 * through a read-only forge compare. No answer is unavailable, never a guess:
 * the caller parks or stays parked instead of entering `merged` on a
 * suspicion. Mutates nothing.
 */

import type { ForgeRepositoryRef } from './ForgeReadPort.out-port.js';

export interface ContainsCommitRequest {
  /** The candidate ancestor: the lane head's full 40-hex sha. */
  readonly ancestorSha: string;
  /** The candidate descendant: the PR head's full 40-hex sha. */
  readonly descendantSha: string;
  /** Overrides the adapter's configured repository for one read. */
  readonly repository?: ForgeRepositoryRef;
}

export type ContainsCommitResult =
  | { readonly outcome: 'answered'; readonly contains: boolean }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface ForgeAncestryPort {
  /** Answer whether `ancestorSha` is an ancestor of `descendantSha`; mutates nothing. */
  containsCommit(request: ContainsCommitRequest): Promise<ContainsCommitResult>;
}
