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

export interface ImportTrainStateReport {
  readonly unknownLineNumbers: readonly number[];
  readonly notImportableBase: number;
  readonly alreadyQueued: number;
  readonly parkedLines: number;
  readonly chainFiles: number;
  readonly batchLines: number;
}

export type ImportTrainStateResult =
  | { readonly outcome: 'refused'; readonly reason: ImportTrainStateRefusal }
  | ({ readonly outcome: 'dry-run'; readonly wouldImport: number } & ImportTrainStateReport)
  | ({ readonly outcome: 'applied'; readonly imported: number; readonly refused: number } & ImportTrainStateReport);

export interface ImportTrainStatePort {
  importTrainState(request: ImportTrainStateRequest): Promise<ImportTrainStateResult>;
}
