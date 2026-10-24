/**
 * RegisterProjectProfileUseCase implements RegisterProjectProfilePort. It
 * validates one project's private installation references, its designated
 * dispatcher host, its runner capabilities and the approved policy revision,
 * then persists the profile through the repository port.
 *
 * Two refusals are load-bearing here. A request field or runner-capability key
 * that carries the shape of a credential is rejected outright, so installation
 * configuration never accumulates secrets, and a profile with no designated
 * dispatcher host or no usable lane bound is never recorded, because such a
 * profile cannot dispatch anything.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type {
  RegisterProjectProfilePort,
  RegisterProjectProfileRequest,
  RegisterProjectProfileResult,
} from '../ports/in/RegisterProjectProfilePort.in-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';

export interface RegisterProjectProfileDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
}

/**
 * Field and capability names that would move a secret into persisted
 * installation state. Only names are inspected; values are never read, copied
 * or compared.
 */
const CREDENTIAL_NAME_PATTERN =
  /(token|secret|credential|password|passphrase|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie)/i;

const REQUIRED_TEXT_FIELDS = [
  'projectId',
  'displayName',
  'repository',
  'designatedDispatcherHost',
  'policyRevision',
] as const;

function findCredentialName(names: readonly string[]): string | null {
  for (const name of names) {
    if (CREDENTIAL_NAME_PATTERN.test(name)) {
      return name;
    }
  }
  return null;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class RegisterProjectProfileUseCase implements RegisterProjectProfilePort {
  constructor(private readonly deps?: RegisterProjectProfileDependencies) {}

  async registerProjectProfile(
    request: RegisterProjectProfileRequest,
  ): Promise<RegisterProjectProfileResult> {
    return this.execute(request);
  }

  /**
   * The composition boundary entry point. Anything that is not a usable request
   * object, and any call made without dependencies, refuses rather than
   * inventing a profile.
   */
  async execute(input: unknown): Promise<RegisterProjectProfileResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RegisterProjectProfileUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is rejected by the field validation below.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: RegisterProjectProfileUseCase');
    }
    const request = input as RegisterProjectProfileRequest;
    const credentialField = findCredentialName(Object.keys(request));
    if (credentialField !== null) {
      return {
        outcome: 'rejected',
        reason: `profile registration must not carry a credential field: ${credentialField}`,
      };
    }
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (!isFilled(request[field])) {
        return { outcome: 'rejected', reason: `profile registration requires a non-empty ${field}` };
      }
    }
    if (
      !Number.isInteger(request.maxConcurrentLanes) ||
      request.maxConcurrentLanes < 1
    ) {
      return {
        outcome: 'rejected',
        reason: 'profile registration requires a positive integer maxConcurrentLanes',
      };
    }
    const capabilities: Readonly<Record<string, boolean | string>> = request.runnerCapabilities;
    if (typeof capabilities !== 'object' || capabilities === null) {
      return { outcome: 'rejected', reason: 'profile registration requires a runnerCapabilities map' };
    }
    const credentialCapability = findCredentialName(Object.keys(capabilities));
    if (credentialCapability !== null) {
      return {
        outcome: 'rejected',
        reason: `runner capability must not carry a credential value: ${credentialCapability}`,
      };
    }
    const existing = await this.deps.profileRepo.findProfileById(request.projectId);
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    // A new profile starts with the entity's v2 defaults; a re-registration
    // carries the stored v2 fields forward unchanged so clones and the last
    // probe are never wiped by a re-registration.
    const v2Fields =
      existing === null
        ? {
            status: 'active' as const,
            defaultBranch: null,
            clones: {},
            gateProcedures: [],
            defaultAllowedPathPrefixes: [],
            lastProbe: null,
          }
        : {
            status: existing.status,
            defaultBranch: existing.defaultBranch,
            clones: existing.clones,
            gateProcedures: existing.gateProcedures,
            defaultAllowedPathPrefixes: existing.defaultAllowedPathPrefixes,
            lastProbe: existing.lastProbe,
          };
    const candidate: ProjectProfileRecord = {
      projectId: request.projectId.trim(),
      displayName: request.displayName.trim(),
      repository: request.repository.trim(),
      designatedDispatcherHost: request.designatedDispatcherHost.trim(),
      policyRevision: request.policyRevision.trim(),
      maxConcurrentLanes: request.maxConcurrentLanes,
      runnerCapabilities: Object.freeze({ ...capabilities }),
      revision: existing === null ? 0 : existing.revision + 1,
      updatedAtIso: nowIso,
      ...v2Fields,
    };
    let profile: ProjectProfileRecord;
    try {
      profile = ProjectProfile.fromRecord(candidate).toRecord();
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : 'profile registration was refused',
      };
    }
    await this.deps.profileRepo.saveProfile(profile);
    return { outcome: 'registered', profile };
  }
}
