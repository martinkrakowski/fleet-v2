// @generated inbound contract scaffold — refined for lane CO5.

export interface ImportTrainStateRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly stateDir: string;
  readonly apply: boolean;
  /**
   * The standing `merge:import-shadow` grant handle and the project it was
   * issued for. Both are required only when `apply` is true; a dry run needs
   * neither. `grantId` is a non-secret handle and may be printed.
   */
  readonly grantId?: string | null;
  readonly projectId?: string | null;
}

export type ImportTrainStateRefusal =
  | 'invalid-request'
  | 'invalid-repository'
  | 'invalid-state-dir'
  | 'project-required'
  | 'grant-missing'
  | 'grant-expired'
  | 'grant-revoked'
  | 'grant-wrong-scope'
  | 'grant-wrong-repository'
  | 'grant-wrong-project'
  | 'grant-digest-mismatch'
  | 'grant-not-approved'
  | 'grant-id-mismatch'
  | 'authorization-unavailable'
  | 'journal-unavailable'
  | 'journal-refused'
  | 'legacy-unreadable'
  | 'secret-shaped';

/** Cap on the number of import keys listed in a report; the rest are truncated. */
export const IMPORT_KEYS_MAX = 500;

/**
 * One deduplicated entry and how this run would treat it. The import contract
 * covers queue, parked and in-progress state, deduped by the pair
 * (pullRequest, headOid) in source order queue, then inprogress, then
 * parked — the first source to hold a pair wins and is recorded here as
 * `source`. Every source, including inprogress, goes through the same
 * disposition rules: a non-`main` base yields `not-importable-base`, an
 * entry already live in the fleet queue yields `already-queued`.
 *
 * `legacy-in-progress` is a distinct case from both of those: it fires when
 * the entry's PULL REQUEST NUMBER — not the full (pullRequest, headOid)
 * pair — appears anywhere in the `inprogress` source, whether or not the
 * same pair also appears in `queue`. The real shell (tick.sh) MOVES a line
 * from `queue` to `inprogress` when it starts merging a PR, rather than
 * duplicating it into both; a PR appearing in BOTH `queue` and `inprogress`
 * for the same pair is only a rare crash-leftover artifact, not the normal
 * case. The normal case is a PR appearing in `inprogress` ALONE, and that
 * still means the legacy shell train is actively merging it right now —
 * importing it would let the fleet queue and the legacy train act on it at
 * the same time. The check is scoped to the PR number, not the pair,
 * because the shell's own `enqueue.sh` can append a fresh `queue` line for
 * a PR number whose older head is still `inprogress` (same PR, a different
 * head): that queue entry's pair never matches the `inprogress` pair, so a
 * pair-level check would miss it, but it is still the same PR the legacy
 * train is merging. `legacy-in-progress` is deliberately not folded into
 * `already-queued`: `already-queued` means the entry is already live in
 * the FLEET queue, a different fact entirely. Nothing disposed
 * `legacy-in-progress` is ever enqueued, even under `apply: true`.
 */
export interface ImportTrainStateKey {
  readonly pullRequest: number;
  readonly headOid: string;
  readonly base: string;
  readonly source: 'queue' | 'parked' | 'inprogress';
  readonly disposition: 'would-import' | 'already-queued' | 'not-importable-base' | 'legacy-in-progress';
}

export interface ImportTrainStateReport {
  readonly unknownLineNumbers: readonly number[];
  readonly notImportableBase: number;
  readonly alreadyQueued: number;
  readonly parkedLines: number;
  readonly chainFiles: number;
  readonly batchLines: number;
  readonly inprogressLines: number;
  readonly unknownBySource: {
    readonly queue: readonly number[];
    readonly parked: readonly number[];
    readonly inprogress: readonly number[];
  };
  readonly keys: readonly ImportTrainStateKey[];
  readonly keysTruncated: boolean;
}

export type ImportTrainStateResult =
  | { readonly outcome: 'refused'; readonly reason: ImportTrainStateRefusal }
  | ({ readonly outcome: 'dry-run'; readonly wouldImport: number } & ImportTrainStateReport)
  | ({ readonly outcome: 'applied'; readonly imported: number; readonly refused: number } & ImportTrainStateReport);

export interface ImportTrainStatePort {
  importTrainState(request: ImportTrainStateRequest): Promise<ImportTrainStateResult>;
}
