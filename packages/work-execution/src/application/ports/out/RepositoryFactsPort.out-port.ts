// @generated outbound contract scaffold — refined for lane CO16.
/** Read-only repository facts at a pinned commit, for the fact-pack builder. */

export interface RepositoryFactsRequest {
  /** The checkout the facts are read from. */
  readonly repositoryPath: string;
  /** The pinned commit: 40 to 64 lowercase hex characters. */
  readonly commit: string;
}

export interface RepositoryFileListing {
  readonly status: 'read' | 'absent' | 'unreadable' | 'oversized';
  /** The listed paths; empty unless status is 'read'. */
  readonly paths: readonly string[];
}

export type RepositoryFactRead =
  | { readonly status: 'read'; readonly text: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'oversized' };

export interface RepositoryFactsPort {
  listFilesAtCommit(
    request: RepositoryFactsRequest & { readonly pathPrefix: string },
  ): Promise<RepositoryFileListing>;
  readFileRangeAtCommit(
    request: RepositoryFactsRequest & { readonly path: string; readonly fromLine: number; readonly toLine: number },
  ): Promise<RepositoryFactRead>;
  readMatchingLinesAtCommit(
    request: RepositoryFactsRequest & { readonly path: string; readonly token: string },
  ): Promise<RepositoryFactRead>;
}
