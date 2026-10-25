/**
 * RegisterProjectProfileUseCase implements RegisterProjectProfilePort. It
 * validates one project's private installation references, its designated
 * dispatcher host, its runner capabilities and the approved policy revision,
 * then persists the profile through the repository port.
 *
 * Registration is create-only: an existing id is refused, and the four profile
 * v2 fields are optional inputs rather than carried-forward state. Two
 * refusals are load-bearing here. A request field or runner-capability key that
 * carries the shape of a credential is rejected outright, so installation
 * configuration never accumulates secrets, and a profile with no designated
 * dispatcher host or no usable lane bound is never recorded, because such a
 * profile cannot dispatch anything.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import type { InstallationReferencePort } from '../ports/out/InstallationReferencePort.out-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  RegisterProjectProfilePort,
  RegisterProjectProfileRequest,
  RegisterProjectProfileResult,
} from '../ports/in/RegisterProjectProfilePort.in-port.js';
import {
  checkInstallationNames,
  findCredentialName,
  isFilled,
  isPlainObject,
  parseProfileRecord,
  saveProfileWithConflictCheck,
  trimString,
} from './profile-write-checks.js';

export interface RegisterProjectProfileDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
  readonly installationRefs?: InstallationReferencePort;
}

const REQUIRED_TEXT_FIELDS = [
  'projectId',
  'displayName',
  'repository',
  'designatedDispatcherHost',
  'policyRevision',
] as const;

const FORBIDDEN_REGISTRATION_FIELDS = ['status', 'lastProbe', 'revision'] as const;

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
    // A configured runtime still refuses a non-plain request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is rejected by the field validation below.
    if (!isPlainObject(input)) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as RegisterProjectProfileRequest;
    const fieldError = this.validateRequestFields(request);
    if (fieldError !== null) {
      return { outcome: 'rejected', reason: fieldError };
    }
    const projectId = trimString(request.projectId);
    const existing = await this.deps.profileRepo.findProfileById(projectId);
    if (existing !== null) {
      return {
        outcome: 'rejected',
        reason: `project ${projectId} is already registered; edit it with update`,
      };
    }
    const candidate = this.buildCandidateRecord(request, projectId);
    const parsed = parseProfileRecord(candidate, 'profile registration was refused');
    if ('reason' in parsed) {
      return { outcome: 'rejected', reason: parsed.reason };
    }
    const nameError = checkInstallationNames(this.deps.installationRefs, parsed.profile);
    if (nameError !== null) {
      return { outcome: 'rejected', reason: nameError };
    }
    const conflictError = await saveProfileWithConflictCheck(
      this.deps.profileRepo,
      parsed.profile,
      projectId,
    );
    if (conflictError !== null) {
      return { outcome: 'rejected', reason: conflictError };
    }
    return { outcome: 'registered', profile: parsed.profile };
  }

  private validateRequestFields(request: RegisterProjectProfileRequest): string | null {
    for (const key of FORBIDDEN_REGISTRATION_FIELDS) {
      if (Object.hasOwn(request, key)) {
        return `${key} cannot be set by registration`;
      }
    }
    const credentialField = findCredentialName(Object.keys(request));
    if (credentialField !== null) {
      return `profile registration must not carry a credential field: ${credentialField}`;
    }
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (!isFilled(request[field])) {
        return `profile registration requires a non-empty ${field}`;
      }
    }
    if (!Number.isInteger(request.maxConcurrentLanes) || request.maxConcurrentLanes < 1) {
      return 'profile registration requires a positive integer maxConcurrentLanes';
    }
    return this.validateRunnerCapabilities(request.runnerCapabilities);
  }

  private validateRunnerCapabilities(capabilities: unknown): string | null {
    if (typeof capabilities !== 'object' || capabilities === null) {
      return 'profile registration requires a runnerCapabilities map';
    }
    const credentialCapability = findCredentialName(Object.keys(capabilities));
    if (credentialCapability !== null) {
      return `runner capability must not carry a credential value: ${credentialCapability}`;
    }
    return null;
  }

  private buildCandidateRecord(
    request: RegisterProjectProfileRequest,
    projectId: string,
  ): ProjectProfileRecord {
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    // A new profile starts at revision 0 with the entity's v2 defaults; the
    // optional v2 request fields are the only way to set them.
    return {
      projectId,
      displayName: trimString(request.displayName),
      repository: trimString(request.repository),
      designatedDispatcherHost: trimString(request.designatedDispatcherHost),
      policyRevision: trimString(request.policyRevision),
      maxConcurrentLanes: request.maxConcurrentLanes,
      runnerCapabilities: Object.freeze({ ...request.runnerCapabilities }),
      revision: 0,
      updatedAtIso: nowIso,
      status: 'active',
      defaultBranch: request.defaultBranch ?? null,
      clones: request.clones ?? {},
      gateProcedures: request.gateProcedures ?? [],
      defaultAllowedPathPrefixes: request.defaultAllowedPathPrefixes ?? [],
      lastProbe: null,
    };
  }
}
