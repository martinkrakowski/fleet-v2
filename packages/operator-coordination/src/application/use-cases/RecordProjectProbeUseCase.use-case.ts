/**
 * RecordProjectProbeUseCase implements RecordProjectProbePort. It stores a
 * probe receipt as the profile's last probe only when the profile is still at
 * the revision the probe started from, replacing nothing but `lastProbe` and
 * moving the revision forward by one.
 *
 * The candidate is validated by building it through the entity, so a receipt
 * the entity refuses is reported with its message and nothing is saved. A
 * stale write is a `ProjectProfileRevisionConflictError` from the repository
 * and becomes a typed rejection, never a silent overwrite.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type {
  RecordProjectProbePort,
  RecordProjectProbeRequest,
  RecordProjectProbeResult,
} from '../ports/in/RecordProjectProbePort.in-port.js';
import {
  ProjectProfileRevisionConflictError,
  type ProjectProfileRepositoryPort,
} from '../ports/out/ProjectProfileRepositoryPort.out-port.js';

export interface RecordProjectProbeDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
}

export class RecordProjectProbeUseCase implements RecordProjectProbePort {
  constructor(private readonly deps?: RecordProjectProbeDependencies) {}

  async recordProjectProbe(
    request: RecordProjectProbeRequest,
  ): Promise<RecordProjectProbeResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RecordProjectProbeResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordProjectProbeUseCase');
    }
    if (typeof input !== 'object' || input === null) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as RecordProjectProbeRequest;
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : '';
    const stored = await this.deps.profileRepo.findProfileById(projectId);
    if (stored === null) {
      return { outcome: 'rejected', reason: `project ${projectId} is not registered` };
    }
    if (stored.status === 'retired') {
      return { outcome: 'rejected', reason: `project ${projectId} is retired` };
    }
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
      return {
        outcome: 'rejected',
        reason: 'expectedRevision must be a non-negative integer',
      };
    }
    if (stored.revision !== request.expectedRevision) {
      return {
        outcome: 'rejected',
        reason: `project ${projectId} changed since the probe started (revision ${stored.revision}, probe read ${request.expectedRevision}); probe again`,
      };
    }
    const candidate: ProjectProfileRecord = {
      ...stored,
      lastProbe: request.receipt,
      revision: stored.revision + 1,
    };
    let profile: ProjectProfileRecord;
    try {
      profile = ProjectProfile.fromRecord(candidate).toRecord();
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : 'probe recording was refused',
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
    return { outcome: 'recorded', profile };
  }
}
