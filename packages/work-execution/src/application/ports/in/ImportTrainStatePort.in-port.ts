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
 * covers queue, parked and chain state: an entry the legacy train is currently
 * merging (`inprogress`) is reported but never an import candidate, because
 * enqueueing it would let both trains act on the same PR.
 */
export interface ImportTrainStateKey {
  readonly pullRequest: number;
  readonly headOid: string;
  readonly base: string;
  readonly source: 'queue' | 'parked' | 'inprogress';
  readonly disposition: 'would-import' | 'already-queued' | 'not-importable-base' | 'in-progress';
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
