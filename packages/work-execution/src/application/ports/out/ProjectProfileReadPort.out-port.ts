/**
 * ProjectProfileReadPort reads one project profile and its revision from the
 * coordination context. Known absence is null; rejected or malformed answers
 * surface as thrown errors through the adapter.
 */

export interface ProjectProfileView {
  readonly projectId: string;
  readonly status: 'active' | 'retired';
  readonly repository: string;
  readonly clones: Readonly<
    Record<string, { readonly path: string; readonly worktreeRoot: string }>
  >;
  readonly gateProcedures: readonly string[];
  readonly revision: number;

  /**
   * AD-1: the project's lane cap — how many lanes the project may hold at
   * once. Absent means the profile declares no cap.
   */
  readonly maxConcurrentLanes?: number | null;
}

export interface ProjectProfileReadPort {
  readProjectProfile(projectId: string): Promise<ProjectProfileView | null>;
}
