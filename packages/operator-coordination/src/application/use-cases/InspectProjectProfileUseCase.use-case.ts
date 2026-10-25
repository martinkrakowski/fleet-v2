/**
 * InspectProjectProfileUseCase implements InspectProjectProfilePort. It returns
 * one profile when it exists, a known absence otherwise, without mutating
 * state.
 *
 * The project id is trimmed before lookup, so a request padded with whitespace
 * finds the same profile as the bare id.
 */

import type {
  InspectProjectProfilePort,
  InspectProjectProfileRequest,
  InspectProjectProfileResult,
} from '../ports/in/InspectProjectProfilePort.in-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';

export interface InspectProjectProfileDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
}

export class InspectProjectProfileUseCase implements InspectProjectProfilePort {
  constructor(private readonly deps?: InspectProjectProfileDependencies) {}

  async inspectProjectProfile(
    request: InspectProjectProfileRequest,
  ): Promise<InspectProjectProfileResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<InspectProjectProfileResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: InspectProjectProfileUseCase');
    }
    if (typeof input !== 'object' || input === null) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as InspectProjectProfileRequest;
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : '';
    if (projectId.length === 0) {
      return { outcome: 'rejected', reason: 'projectId is required' };
    }
    const record = await this.deps.profileRepo.findProfileById(projectId);
    if (record === null) {
      return { outcome: 'not-found', projectId };
    }
    return { outcome: 'found', profile: record };
  }
}
