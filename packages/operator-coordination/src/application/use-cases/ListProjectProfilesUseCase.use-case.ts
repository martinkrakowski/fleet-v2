/**
 * ListProjectProfilesUseCase implements ListProjectProfilesPort. It returns
 * every profile from the repository — optionally narrowed to active or retired
 * — sorted by projectId, without mutating state.
 *
 * The repository is the source of the profile list and is read exactly once;
 * this use case only filters the returned list and orders it deterministically.
 */

import type {
  ListProjectProfilesPort,
  ListProjectProfilesRequest,
  ListProjectProfilesResult,
} from '../ports/in/ListProjectProfilesPort.in-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';

export interface ListProjectProfilesDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
}

export class ListProjectProfilesUseCase implements ListProjectProfilesPort {
  constructor(private readonly deps?: ListProjectProfilesDependencies) {}

  async listProjectProfiles(
    request: ListProjectProfilesRequest,
  ): Promise<ListProjectProfilesResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<ListProjectProfilesResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ListProjectProfilesUseCase');
    }
    if (typeof input !== 'object' || input === null) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as ListProjectProfilesRequest;
    if (
      request.status !== undefined &&
      request.status !== 'active' &&
      request.status !== 'retired'
    ) {
      return { outcome: 'rejected', reason: 'status must be active or retired' };
    }
    const profiles = await this.deps.profileRepo.listProfiles();
    const filtered =
      request.status === undefined
        ? [...profiles]
        : profiles.filter((profile) => profile.status === request.status);
    filtered.sort((left, right) => left.projectId.localeCompare(right.projectId));
    return { outcome: 'listed', profiles: filtered };
  }
}
