/**
 * InspectConfiguredCapabilitiesUseCase implements InspectConfiguredCapabilitiesPort.
 * It reports what a project has actually configured, which required
 * capabilities are missing, and which are explicitly unknown.
 *
 * An unrecorded capability is never assumed available: only a recorded `true`
 * satisfies a requirement, and a capability recorded with a descriptive string
 * such as "unknown" is reported as an explicit unknown rather than silently
 * counted as supported. Known absence of a profile is reported as `not-found`,
 * never as a project with no capabilities.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type {
  InspectConfiguredCapabilitiesPort,
  InspectConfiguredCapabilitiesRequest,
  InspectConfiguredCapabilitiesResult,
} from '../ports/in/InspectConfiguredCapabilitiesPort.in-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';

export interface InspectConfiguredCapabilitiesDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
}

export class InspectConfiguredCapabilitiesUseCase implements InspectConfiguredCapabilitiesPort {
  constructor(private readonly deps?: InspectConfiguredCapabilitiesDependencies) {}

  async inspectConfiguredCapabilities(
    request: InspectConfiguredCapabilitiesRequest,
  ): Promise<InspectConfiguredCapabilitiesResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<InspectConfiguredCapabilitiesResult> {
    if (!this.deps || typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: InspectConfiguredCapabilitiesUseCase');
    }
    const request = input as InspectConfiguredCapabilitiesRequest;
    const projectId = request.projectId;
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('Not implemented: InspectConfiguredCapabilitiesUseCase');
    }
    const record = await this.deps.profileRepo.findProfileById(projectId);
    if (record === null) {
      return { outcome: 'not-found', projectId };
    }
    const aggregate = ProjectProfile.fromRecord(record);
    const profile: ProjectProfileRecord = aggregate.toRecord();
    const required = Array.isArray(request.requiredCapabilities) ? request.requiredCapabilities : [];
    const missingRequirements: string[] = [];
    const explicitUnknowns: string[] = [];
    for (const capability of required) {
      if (typeof capability !== 'string' || capability.trim().length === 0) {
        continue;
      }
      const name = capability.trim();
      // Only a recorded `true` satisfies a requirement; an unrecorded or
      // descriptive entry is a missing requirement, never an assumed one.
      if (profile.runnerCapabilities[name] !== true) {
        missingRequirements.push(name);
      }
      // A recorded boolean is a decision, supported or missing. Anything else
      // is explicitly unknown and is reported rather than resolved by guess.
      if (aggregate.classifyCapability(name) === 'unknown') {
        explicitUnknowns.push(name);
      }
    }
    return {
      outcome: 'inspected',
      profile,
      missingRequirements,
      explicitUnknowns,
    };
  }
}
