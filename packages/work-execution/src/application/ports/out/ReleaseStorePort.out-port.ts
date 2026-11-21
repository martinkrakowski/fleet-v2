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
 * One named file of a verified build. `quarantined` is `null` when the file
 * cannot be judged, and is never `false` in that case. Consumers must require
 * `present === true && quarantined === false`.
 */
export type ReleaseFileFact = {
  readonly present: boolean;
  readonly quarantined: boolean | null;
};

/**
 * Positional facts for one verified build. `files[i]` answers the request's
 * `paths[i]`. No file content and no path crosses this result. Membership is
 * by location under the verified build's marker only; the store has no
 * content integrity check.
 */
export type ReleaseFilesInspection =
  | { readonly outcome: 'read'; readonly files: readonly ReleaseFileFact[] }
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
    /**
     * CO14b #4c: the id of the operation whose repoint this is. When given,
     * the store records it in its store-level `current` operation marker
     * (`.release-ops/current-op.json`) BEFORE the fence and the rename, so a
     * later rollback can tell "the operation that last wrote `current`" from
     * a stale intent that merely aims at the same sha. Omitted calls keep
     * the old behaviour and overwrite the marker's opId with null.
     */
    readonly opId?: string;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStoreWriteResult | { readonly outcome: 'fenced' }>;
  /**
   * CO14b #4c: read the store-level marker of which operation last wrote
   * `current` on a repoint. Read-only: never mutates state, never throws.
   * `none` when no marker exists (no repoint with an operation id has run
   * under this root yet); `unreadable` when the marker exists but cannot be
   * read, is malformed, carries an unknown version, or names an invalid sha
   * or opId -- never a guess. Cost is constant (one small capped file read).
   */
  readLastCurrentOp?(input: { readonly root: string }): Promise<ReleaseLastCurrentOpResult>;
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
   * CO14 follow-up: remove the orphaned `.current.<...>.tmp` links an
   * interrupted repoint can leave in <root>. Only entries that are links whose
   * name matches that temp pattern are removed — never the `current` link
   * itself, never a build directory, never an entry that is not a link (that
   * entry is reported as a finding). Idempotent: a second pass over a clean
   * root removes nothing. An unreadable root is `unknown`, never an empty
   * result.
   */
  removeOrphanCurrentTemps(input: {
    readonly root: string;
    /**
     * Awaited before each removal: the caller passes the driver-lease fence, so
     * the pass runs only while no other repoint can have a temp link in
     * flight. A false or throwing fence stops the pass (`unknown`) with
     * nothing further removed.
     */
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseOrphanCurrentTempsResult>;
  /**
   * CO14 round 5: begin one release operation for (action, sha) under this
   * root. The durable intent carries a unique operation id that is NOT derivable
   * from action and sha: a fresh intent is `started`; an intent left by a run
   * that never recorded its result is `resumed` with its original id (only
   * that id may resume); a live claim by another run is `busy`. The claim is
   * exclusive; a claim older than the stale window is taken over.
   */
  beginOperation(input: {
    readonly root: string;
    readonly action: ReleaseOperationAction;
    readonly sha: string;
    /** The id this run proposes; an existing intent with another id makes the run `busy`. */
    readonly opId: string;
    readonly nowIso: string;
  }): Promise<ReleaseOperationBegin>;
  /** Read-only: the open intent's operation id for (action, sha), or none. Writes nothing. */
  peekOperation(input: {
    readonly root: string;
    readonly action: ReleaseOperationAction;
    readonly sha: string;
  }): Promise<{ readonly outcome: 'open'; readonly opId: string } | { readonly outcome: 'none' } | { readonly outcome: 'unreadable' }>;
  /**
   * CO14b fix round 8: find an open intent for `action` under this root
   * WITHOUT already knowing its sha. Only rollback needs this: its target is
   * never the request's own named value (unlike install and swap, whose
   * target is always the request's fixed sha), so once a crashed attempt's
   * own repoint has already moved `current`, a fresh recomputation can no
   * longer reproduce that attempt's real target, and `peekOperation` itself
   * cannot be asked without already having a (possibly wrong) sha in hand.
   * Read-only; writes nothing. `none` when no intent is open for `action`;
   * `unreadable` when more than one is found (an invariant violation
   * `beginOperation`'s own exclusive claim should make impossible, so this
   * never guesses which one is real) or an intent file cannot be read or
   * parsed.
   */
  peekAnyOpenOperation(input: {
    readonly root: string;
    readonly action: ReleaseOperationAction;
  }): Promise<ReleaseOpenOperationPeek>;
  /** A fresh, unique operation id (32 hex characters); never derivable from action and sha. */
  newOperationId(): string;
  /** Record the operation's result: the intent becomes a completed record and the claim is released. */
  completeOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult>;
  /** Drop an operation that consumed nothing: the intent and the claim are removed. */
  cancelOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult>;
  /**
   * CO14b fix round 10 (finding 1 and finding 2): record, on this operation's
   * own still-open intent, that its repoint has actually landed -- called
   * only once, immediately after `store.repoint` succeeds (or is confirmed
   * already achieved), before `prune` or `completeOperation`. Only the exact
   * opId that owns the intent may mark it (the same defensive style as
   * `completeOperation`/`cancelOperation`'s own opId guard); a mismatched or
   * already-gone intent is never rewritten. `peekAnyOpenOperation`'s
   * `repointed` flag is read back from this later: it tells a future caller
   * "this intent's mutation already ran" from "it never did", which is the
   * difference between a crash recoverable by the ordinary `current !==
   * plannedCurrent` check alone and one that additionally needs `current` to
   * still match the intent's own recorded sha before it may be adopted
   * again.
   */
  markRepointed(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult>;
  /** Release this run's claim and keep the intent, so the same operation id can resume. */
  releaseOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult>;
  /** The driver state directory this root is bound to; `unbound` before the first applied release. */
  readDriverBinding(input: { readonly root: string }): Promise<ReleaseDriverBinding>;
  /** Bind the root to a driver state directory when it has none (first binding wins). */
  bindDriver(input: { readonly root: string; readonly stateDir: string }): Promise<ReleaseDriverBinding>;
  /**
   * Read-only facts for named repository-relative paths of one verified build.
   * Cost is linear in `paths.length`, capped by `RELEASE_INSPECT_MAX_PATHS`,
   * and each file is capped by `RELEASE_INSPECT_MAX_FILE_BYTES`. `files[i]`
   * answers `paths[i]`. A file that cannot be judged is `quarantined: null`,
   * never `false`; consumers must require `present === true && quarantined ===
   * false`. Membership is by location under the verified build's marker only
   * (the store has no content integrity check). `not-found` when `<root>/<sha>`
   * is not a verified build or its marker is absent. `unreadable` when the
   * marker is corrupt or invalid, or the root or build cannot be read. Content
   * and paths never cross.
   */
  inspectReleaseFiles?(input: {
    readonly root: string;
    readonly sha: string;
    readonly paths: readonly string[];
  }): Promise<ReleaseFilesInspection>;
}

export type ReleaseOperationAction = 'install' | 'swap' | 'rollback';

export interface ReleaseOperationRef {
  readonly root: string;
  readonly action: ReleaseOperationAction;
  readonly sha: string;
  readonly opId: string;
}

export type ReleaseOperationBegin =
  | { readonly outcome: 'started' | 'resumed'; readonly opId: string }
  | { readonly outcome: 'busy' }
  | { readonly outcome: 'unreadable' };

export type ReleaseDriverBinding =
  | { readonly outcome: 'bound'; readonly stateDir: string }
  | { readonly outcome: 'unbound' }
  | { readonly outcome: 'unreadable' };

export type ReleaseOpenOperationPeek =
  | {
      readonly outcome: 'open';
      readonly opId: string;
      readonly sha: string;
      /**
       * CO14b fix round 10: whether THIS intent's own repoint has already
       * landed (set once, by `markRepointed`, right after it does). `false`
       * for an intent whose mutation never ran yet -- adopting its target is
       * then exactly as safe as before round 10, because the ordinary
       * `current !== plannedCurrent` check downstream still gates it.
       */
      readonly repointed: boolean;
    }
  | { readonly outcome: 'none' }
  | { readonly outcome: 'unreadable' };

/**
 * CO14b #4c: the store-level marker of which operation last wrote `current`.
 * `opId` is null when the last repoint carried no operation id.
 */
export type ReleaseLastCurrentOpResult =
  | { readonly outcome: 'read'; readonly opId: string | null; readonly sha: string }
  | { readonly outcome: 'none' }
  | { readonly outcome: 'unreadable' };

export type ReleaseOrphanCurrentTempsResult =
  | {
      readonly outcome: 'cleaned';
      /** How many orphan temp links were removed. */
      readonly removed: number;
      /** How many temp-named entries were found that are not links (reported, never removed). */
      readonly findings: number;
    }
  | { readonly outcome: 'unknown' };
