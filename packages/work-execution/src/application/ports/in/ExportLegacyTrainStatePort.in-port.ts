// Lane CO5b: read-only rollback export of the merge queue as legacy documents.

export interface ExportLegacyTrainStateRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
}

export type ExportLegacyTrainStateRefusal =
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-repository' | 'invalid-deadline' | 'queue-unreadable' | 'queue-too-large';
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'malformed-entry' | 'unrenderable' | 'secret-shaped';
      readonly entryId: string | null;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'duplicate-identity';
      readonly entryIds: readonly [string, string];
    };

export interface ExportLegacyTrainStateSuccess {
  readonly outcome: 'exported';
  readonly queueDocument: string;
  readonly parkedDocument: string;
}

export type ExportLegacyTrainStateResult =
  | ExportLegacyTrainStateSuccess
  | ExportLegacyTrainStateRefusal;

export interface ExportLegacyTrainStatePort {
  exportLegacyTrainState(request: ExportLegacyTrainStateRequest): Promise<ExportLegacyTrainStateResult>;
}
