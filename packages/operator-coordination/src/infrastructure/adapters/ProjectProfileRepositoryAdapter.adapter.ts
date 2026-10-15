// @generated adapter stub — refined for step 5 (no behaviour).
/**
 * ProjectProfileRepositoryAdapter implements ProjectProfileRepositoryPort
 * (private-installation-config-and-local-store). Implementation lands in a later
 * step; every method refuses until then rather than persisting an unverified
 * profile.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import type { ProjectProfileRepositoryPort } from '../../application/ports/out/ProjectProfileRepositoryPort.out-port.js';

export class ProjectProfileRepositoryAdapter implements ProjectProfileRepositoryPort {
  async saveProfile(_record: ProjectProfileRecord): Promise<void> {
    throw new Error('Not implemented: ProjectProfileRepositoryAdapter.saveProfile');
  }

  async findProfileById(_projectId: string): Promise<ProjectProfileRecord | null> {
    throw new Error('Not implemented: ProjectProfileRepositoryAdapter.findProfileById');
  }
}
