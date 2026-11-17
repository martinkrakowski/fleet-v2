// @generated inbound contract scaffold — refined for lane CO5.

export interface ImportTrainStateRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly stateDir: string;
  readonly apply: boolean;
  readonly authority: string | null;
}

export type ImportTrainStateRefusal =
  | 'invalid-repository'
  | 'invalid-state-dir'
  | 'authority-required'
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
 * the SAME (pullRequest, headOid) pair appears in BOTH the `queue` source
 * and the `inprogress` source, regardless of which of the two wins the
 * dedup above (today that is always `queue`, since it precedes `inprogress`
 * in source order). That co-occurrence means the legacy shell train is
 * actively merging this PR right now — importing it would let the fleet
 * queue and the legacy train act on it at the same time. It is deliberately
 * not folded into `already-queued`: `already-queued` means the entry is
 * already live in the FLEET queue, a different fact entirely. A pair that
 * is `inprogress` on its own, with no matching `queue` entry, is NOT
 * `legacy-in-progress` — that is the normal, ongoing state the S8
 * shadow-intake evaluator reads and still yields `would-import`. Nothing
 * disposed `legacy-in-progress` is ever enqueued, even under `apply: true`.
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
