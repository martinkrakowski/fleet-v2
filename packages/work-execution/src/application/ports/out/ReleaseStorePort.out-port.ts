// @generated outbound contract scaffold — refined for lane CO14.
/**
 * ReleaseStorePort holds the release root: one built tree per commit, a
 * verified-build marker in each and the `current` pointer. Results carry shas
 * and codes only, never a path. An unreadable root or marker is `unreadable`,
 * never an empty store.
 */

export interface ReleaseBuildRecord {
  readonly sha: string;
  readonly builtAtIso: string;
}

export type ReleaseStoreListing =
  | {
      readonly outcome: 'read';
      readonly current: string | null;
      /** Verified builds, oldest first. */
      readonly builds: readonly ReleaseBuildRecord[];
    }
  | { readonly outcome: 'unreadable' };

export type ReleaseStoreWriteResult =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'not-verified' }
  | { readonly outcome: 'unreadable' };

export type ReleaseStorePruneResult =
  | { readonly outcome: 'pruned'; readonly removed: readonly string[] }
  | { readonly outcome: 'unreadable' };

export interface ReleaseStorePort {
  /** Create <root> and <root>/<sha>; never writes a build. */
  prepare(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStoreWriteResult>;
  list(input: { readonly root: string }): Promise<ReleaseStoreListing>;
  /** Record <root>/<sha> as a verified build (marker file + builtAtIso). */
  markVerified(input: {
    readonly root: string;
    readonly sha: string;
    readonly builtAtIso: string;
  }): Promise<ReleaseStoreWriteResult>;
  /** Atomically repoint <root>/current at <sha>. */
  repoint(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStoreWriteResult>;
  /** Keep the newest `keep` verified builds; never remove current or previous. */
  prune(input: { readonly root: string; readonly keep: number }): Promise<ReleaseStorePruneResult>;
  /** Remove an incomplete build: the `<sha>` directory and its leftover `<sha>.tar`. */
  discard(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStoreWriteResult>;
}
