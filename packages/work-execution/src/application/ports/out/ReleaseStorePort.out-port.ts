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
  prune(input: { readonly root: string; readonly keep: number }): Promise<ReleaseStorePruneResult>;
  /** Remove an incomplete build: this run's staging directory, its archive and its home. */
  discard(input: { readonly root: string; readonly buildId: string }): Promise<ReleaseStoreWriteResult>;
}
