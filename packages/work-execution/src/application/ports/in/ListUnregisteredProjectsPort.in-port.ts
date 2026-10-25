// @generated inbound contract scaffold — refined for this lane.
/**
 * ListUnregisteredProjectsPort: list each project id that has work orders but
 * no profile, with what its work orders say about it (repositories, base
 * commits, owned paths, counts), so it can be adopted. Read-only.
 */

export interface ListUnregisteredProjectsRequest {}

export interface UnregisteredProject {
  readonly projectId: string;
  readonly workOrderCount: number;
  readonly activeWorkOrderCount: number;
  readonly repositories: readonly string[];
  readonly latestBaseCommit: string | null;
  readonly ownedPaths: readonly string[];
  readonly lastUpdatedAtIso: string;
}

export interface ListUnregisteredProjectsResult {
  readonly outcome: 'listed';
  readonly projects: readonly UnregisteredProject[];
}

export interface ListUnregisteredProjectsPort {
  execute(input?: unknown): Promise<ListUnregisteredProjectsResult>;
}
