// @generated outbound contract scaffold — refined for step 5.
/**
 * ProjectProfileRepositoryPort: persist private installation references and
 * policy revisions with version-aware updates. A stale revision is an error, not
 * a silent overwrite, and credential values are never stored here.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface ProjectProfileRepositoryPort {
  /** Persist one profile revision; a stale revision is rejected, never merged. */
  saveProfile(record: ProjectProfileRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findProfileById(projectId: string): Promise<ProjectProfileRecord | null>;
}
