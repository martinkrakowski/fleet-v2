// @generated outbound contract scaffold — refined for lane CO14.
/**
 * ReleaseStorePort holds the release root: one built tree per commit, a
 * verified-build marker in each and the `current` pointer. Results carry shas
 * and codes only, never a path. An unreadable root or marker is `unreadable`,
 * never an empty store. A build is made in a fresh, uniquely named staging
 * directory that `prepare` creates for this run alone; only `markVerified` on
 * that staging directory moves it to <root>/<sha>, so a directory left by an
 * earlier failed run (or a failed cleanup) is never reused or verified.
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
  /** An unfinished prune; `removed` names any builds it did take out first. */
  | { readonly outcome: 'unreadable'; readonly removed?: readonly string[] };

/**
 * CO14b: the outcome of the orphaned `.current.*.tmp` temp-link cleanup. A
 * clean pass reports the count of removed temp links and the names of any
 * matching entries that were not links (reported, never removed). An
 * unreadable root is `unreadable`, never "no orphans" and never a pass.
 */
export type ReleaseStoreOrphanCleanupResult =
  | { readonly outcome: 'cleaned'; readonly removed: number; readonly findings: readonly string[] }
  | { readonly outcome: 'unreadable' };

/**
 * CO14b: a pending repoint — the temp symlink an interrupted repoint left at
 * `<root>/.current.<pid>.<hex>.tmp`. At most one pending repoint is readable;
 * more than one is an ambiguous interrupted state, never resumable.
 */
export type ReleaseStorePendingRepointResult =
  | {
      readonly outcome: 'read';
      readonly pending: { readonly tempLink: string; readonly sha: string } | null;
    }
  | { readonly outcome: 'unreadable' };

/**
 * CO14b: the outcome of recording a pending repoint by creating (or reusing)
 * the temp symlink for the target. `resumed` is true when a pending temp link
 * to the same target already existed, so the operation is a retry of an
 * interrupted repoint rather than a fresh one.
 */
export type ReleaseStoreIntendResult =
  | { readonly outcome: 'ready'; readonly tempLink: string; readonly resumed: boolean }
  | { readonly outcome: 'unreadable' };

/** CO14b: the outcome of completing a pending repoint by renaming the temp link to `current`. */
export type ReleaseStoreCompleteRepointResult =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'fenced' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unreadable' };

/** A fresh staging directory created by this `prepare` call; the paths stay inside the application. */
export type ReleaseStagingResult =
  | {
      readonly outcome: 'prepared';
      /** `<sha>-<16 hex>`: names this run's staging directory and archive. */
      readonly buildId: string;
      readonly buildDir: string;
      readonly archivePath: string;
      /** An empty home directory for this run's build children, never the operator's. */
      readonly homeDir: string;
    }
  | { readonly outcome: 'unreadable' };

export interface ReleaseStorePort {
  /**
   * Create <root> and a new, uniquely named staging directory for <sha>; it
   * refuses (`unreadable`) when <root>/<sha> already exists, so a stale or
   * unverified tree is never built over. Never writes a build.
   */
  prepare(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStagingResult>;
  list(input: { readonly root: string }): Promise<ReleaseStoreListing>;
  /**
   * Verify the staging directory `buildId` names (it must hold the CLI entry),
   * write its marker and move it to <root>/<sha>. `not-found` when that staging
   * directory does not exist; `unreadable` when <root>/<sha> already exists.
   */
  markVerified(input: {
    readonly root: string;
    readonly sha: string;
    readonly buildId: string;
    readonly builtAtIso: string;
  }): Promise<ReleaseStoreWriteResult>;
  /**
   * Atomically repoint <root>/current at <sha>. Every check and the temporary
   * link come first; `fence` is awaited last, and only when it answers true
   * does the one rename run, with nothing awaited in between. A false or
   * throwing fence is `fenced`: the temporary link is removed and `current`
   * is untouched.
   */
  repoint(input: {
    readonly root: string;
    readonly sha: string;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStoreWriteResult | { readonly outcome: 'fenced' }>;
  /** Keep the newest `keep` verified builds; never remove current or previous. */
  prune(input: {
    readonly root: string;
    readonly keep: number;
    /**
     * Awaited before each build is taken out (one quick rename; the slow
     * delete runs afterwards on a name nothing can point at). A false or
     * throwing fence, or a `current` that moved since the snapshot, stops the
     * prune as `unreadable`.
     */
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStorePruneResult>;
  /** Remove an incomplete build: this run's staging directory, its archive and its home. */
  discard(input: { readonly root: string; readonly buildId: string }): Promise<ReleaseStoreWriteResult>;
  /**
   * CO14b: remove orphaned `.current.*.tmp` symlinks left by an interrupted
   * repoint. Only entries whose name matches that temp pattern and that are
   * symbolic links are removed; the `current` link and build directories
   * (including a matching entry that is not a link) are never touched. A
   * matching non-link entry is reported as a finding, not removed. Nothing
   * outside the root is ever read or removed. The pass is idempotent.
   */
  cleanupOrphanTmpLinks(input: { readonly root: string }): Promise<ReleaseStoreOrphanCleanupResult>;
  /**
   * CO14b: read the one pending repoint of the root, if any — a temp symlink
   * an interrupted repoint left at `<root>/.current.*.tmp`. More than one
   * pending temp link is an ambiguous interrupted state (`unreadable`), never
   * silently resumed.
   */
  pendingRepoint(input: { readonly root: string }): Promise<ReleaseStorePendingRepointResult>;
  /**
   * CO14b: record a pending repoint. Creates the temp symlink
   * `<root>/.current.*.tmp` pointing at `<sha>`, after removing any stale
   * pending temp links that name a different target (they can only belong to a
   * dead, interrupted repoint). When a pending temp link to the same target
   * already exists it is reused and `resumed` is true.
   */
  intendRepoint(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStoreIntendResult>;
  /**
   * CO14b: complete a pending repoint by renaming its temp symlink to
   * `current`. `fence` is awaited last, and only when it answers true does the
   * one rename run. A false or throwing fence is `fenced` and the temp link is
   * kept, so a later retry can resume the interrupted repoint.
   */
  completeRepoint(input: {
    readonly root: string;
    readonly tempLink: string;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStoreCompleteRepointResult>;
  /** CO14b: remove a pending repoint's temp symlink (abort the intent). */
  discardRepointIntent(input: { readonly root: string; readonly tempLink: string }): Promise<ReleaseStoreWriteResult>;
}
