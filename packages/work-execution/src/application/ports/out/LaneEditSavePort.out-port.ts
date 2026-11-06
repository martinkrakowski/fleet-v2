// @generated outbound contract scaffold — refined for lane CO27.
/**
 * LaneEditSavePort: on the recorded host, write a worktree's tracked and
 * untracked changes (ignored paths excluded) as one commit object on a save
 * ref under `refs/fleet/saved/` in the lane's clone, without touching the
 * index, the working tree, the branch or any remote, and read back the ref's
 * tree digest beside the worktree's. An existing save ref with the same tree
 * is already saved and one with another tree is refused; an unreadable tree or
 * no recorded host is refused, never a guess. It pushes nothing and holds no
 * credential; results carry ids, codes and digests only.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';

export type LaneEditSaveRefusalCode =
  | 'invalid-request'
  | 'no-recorded-host'
  | 'host-not-routable'
  | 'unreadable-tree'
  | 'worktree-not-in-clone'
  | 'save-ref-conflict'
  | 'save-ref-invalid'
  | 'digest-mismatch';

export interface LaneEditSaveRequest {
  readonly recordedHost: AttemptRunnerRecord | null;
  /** Absolute path of the lane clone on that host. */
  readonly clonePath: string;
  /** Absolute path of the lane worktree on that host. */
  readonly worktreePath: string;
  /** `refs/fleet/saved/<name>`. */
  readonly saveRef: string;
  /** Fixed text: no path, no secret-shaped text. */
  readonly commitMessage: string;
}

export type LaneEditSaveResult =
  | {
      readonly outcome: 'saved';
      readonly saveRef: string;
      readonly commitId: string;
      readonly treeDigest: string;
      readonly worktreeTreeDigest: string;
    }
  | {
      readonly outcome: 'already-saved';
      readonly saveRef: string;
      readonly commitId: string;
      readonly treeDigest: string;
      readonly worktreeTreeDigest: string;
    }
  | { readonly outcome: 'refused'; readonly reason: LaneEditSaveRefusalCode }
  /** Transport failure or timeout; the save may or may not have happened. */
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface LaneEditSavePort {
  saveLaneEdits(request: LaneEditSaveRequest): Promise<LaneEditSaveResult>;
}
