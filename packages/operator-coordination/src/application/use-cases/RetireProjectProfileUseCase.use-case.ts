/**
 * RetireProjectProfileUseCase implements RetireProjectProfilePort. It marks a
 * profile retired (never deleted) when the caller names the revision it read;
 * nothing else changes.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import {
  ProjectProfileRevisionConflictError,
  type ProjectProfileRepositoryPort,
} from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  RetireProjectProfilePort,
  RetireProjectProfileRequest,
  RetireProjectProfileResult,
} from '../ports/in/RetireProjectProfilePort.in-port.js';

export interface RetireProjectProfileDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
}

export class RetireProjectProfileUseCase implements RetireProjectProfilePort {
  constructor(private readonly deps?: RetireProjectProfileDependencies) {}

  async retireProjectProfile(
    request: RetireProjectProfileRequest,
  ): Promise<RetireProjectProfileResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RetireProjectProfileResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RetireProjectProfileUseCase');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as RetireProjectProfileRequest;
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : '';
    const stored = await this.deps.profileRepo.findProfileById(projectId);
    if (stored === null) {
      return { outcome: 'rejected', reason: `project ${projectId} is not registered` };
    }
    if (stored.status === 'retired') {
      return { outcome: 'rejected', reason: `project ${projectId} is already retired` };
    }
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
      return { outcome: 'rejected', reason: 'expectedRevision must be a non-negative integer' };
    }
    if (request.expectedRevision !== stored.revision) {
      return {
        outcome: 'rejected',
        reason: `project ${projectId} is at revision ${stored.revision}, not ${request.expectedRevision}; read it again`,
      };
    }
    const retired: ProjectProfileRecord = {
      ...stored,
      status: 'retired',
      revision: stored.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    let profile: ProjectProfileRecord;
    try {
      profile = ProjectProfile.fromRecord(retired).toRecord();
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : 'profile retirement was refused',
      };
    }
    try {
      await this.deps.profileRepo.saveProfile(profile);
    } catch (error) {
      if (error instanceof ProjectProfileRevisionConflictError) {
        return {
          outcome: 'rejected',
          reason: `profile ${projectId} changed while it was being written; read it again and retry`,
        };
      }
      throw error;
    }
    return { outcome: 'retired', profile };
  }
}
