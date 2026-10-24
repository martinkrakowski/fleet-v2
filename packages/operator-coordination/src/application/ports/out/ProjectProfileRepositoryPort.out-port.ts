// @generated outbound contract scaffold — refined for step 5.
/**
 * ProjectProfileRepositoryPort: persist private installation references and
 * policy revisions with version-aware updates. A stale revision is an error, not
 * a silent overwrite, and credential values are never stored here.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

/**
 * Thrown when a save of an existing profile is not built on the stored
 * revision. Writers must chain from the record they read, so their revision is
 * exactly one more than the stored one; anything else is a stale write.
 * `expectedRevision` is the stored revision (or -1 for a new id that is not
 * being written at revision 0); `actualRevision` is the revision the writer
 * sent. The message names the stored revision, the required next write revision
 * and what the writer actually sent.
 */
export class ProjectProfileRevisionConflictError extends Error {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(projectId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Stale project profile revision for ${projectId}: stored ${expectedRevision}, write must be ${expectedRevision + 1}, got ${actualRevision}`,
    );
    this.name = 'ProjectProfileRevisionConflictError';
    this.projectId = projectId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface ProjectProfileRepositoryPort {
  /**
   * Persist one profile revision under a strict compare-and-swap rule. A new
   * id is stored only at revision 0; an existing id is stored only when
   * `record.revision === stored.revision + 1`; otherwise a
   * `ProjectProfileRevisionConflictError` is thrown.
   */
  saveProfile(record: ProjectProfileRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findProfileById(projectId: string): Promise<ProjectProfileRecord | null>;

  /** Every profile, active and retired, sorted by projectId. */
  listProfiles(): Promise<readonly ProjectProfileRecord[]>;
}
