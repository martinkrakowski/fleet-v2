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
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type { InstallationReferencePort } from '../ports/out/InstallationReferencePort.out-port.js';
import {
  ProjectProfileRevisionConflictError,
  type ProjectProfileRepositoryPort,
} from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  RegisterProjectProfilePort,
  RegisterProjectProfileRequest,
  RegisterProjectProfileResult,
} from '../ports/in/RegisterProjectProfilePort.in-port.js';

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

/**
 * Field and capability names that would move a secret into persisted
 * installation state. Only names are inspected; values are never read, copied
 * or compared.
 */
const CREDENTIAL_NAME_PATTERN =
  /(token|secret|credential|password|passphrase|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie)/i;

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

/**
 * Check a candidate profile's host and procedure names against the loaded
 * installation. Returns null when the names are acceptable or no installation
 * reference was supplied; otherwise the refusal reason. The designated
 * dispatcher host is checked first, then clone hosts in sorted order, then
 * gate procedures.
 */
function checkInstallationNames(
  installationRefs: InstallationReferencePort | undefined,
  profile: ProjectProfileRecord,
): string | null {
  if (installationRefs === undefined) {
    return null;
  }
  const refs = installationRefs.references();
  if (refs === null) {
    return 'no installation is loaded to check host and procedure names against';
  }
  const hostNames = new Set(refs.hostNames);
  if (!hostNames.has(profile.designatedDispatcherHost)) {
    return `designatedDispatcherHost ${profile.designatedDispatcherHost} is not a host in the installation`;
  }
  for (const host of Object.keys(profile.clones).sort()) {
    if (!hostNames.has(host)) {
      return `clone host ${host} is not a host in the installation`;
    }
  }
  const procedureNames = new Set(refs.procedureNames);
  for (const procedure of profile.gateProcedures) {
    if (!procedureNames.has(procedure)) {
      return `gate procedure ${procedure} is not a verification procedure in the installation`;
    }
  }
  return null;
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
    // A configured runtime still refuses a non-plain request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is rejected by the field validation below.
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as RegisterProjectProfileRequest;
    for (const field of FORBIDDEN_REGISTRATION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(request, field)) {
        return { outcome: 'rejected', reason: `${field} cannot be set by registration` };
      }
    }
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
    const projectId = request.projectId.trim();
    const existing = await this.deps.profileRepo.findProfileById(projectId);
    if (existing !== null) {
      return {
        outcome: 'rejected',
        reason: `project ${projectId} is already registered; edit it with update`,
      };
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    // A new profile starts at revision 0 with the entity's v2 defaults; the
    // optional v2 request fields are the only way to set them.
    const candidate: ProjectProfileRecord = {
      projectId,
      displayName: request.displayName.trim(),
      repository: request.repository.trim(),
      designatedDispatcherHost: request.designatedDispatcherHost.trim(),
      policyRevision: request.policyRevision.trim(),
      maxConcurrentLanes: request.maxConcurrentLanes,
      runnerCapabilities: Object.freeze({ ...capabilities }),
      revision: 0,
      updatedAtIso: nowIso,
      status: 'active',
      defaultBranch: request.defaultBranch ?? null,
      clones: request.clones ?? {},
      gateProcedures: request.gateProcedures ?? [],
      defaultAllowedPathPrefixes: request.defaultAllowedPathPrefixes ?? [],
      lastProbe: null,
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
    const nameCheck = checkInstallationNames(this.deps.installationRefs, profile);
    if (nameCheck !== null) {
      return { outcome: 'rejected', reason: nameCheck };
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
    return { outcome: 'registered', profile };
  }
}
