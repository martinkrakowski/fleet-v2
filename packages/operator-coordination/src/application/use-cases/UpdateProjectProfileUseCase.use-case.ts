/**
 * UpdateProjectProfileUseCase implements UpdateProjectProfilePort. It edits an
 * active profile only when the caller names the revision it read and refuses
 * any change that would move the profile off the installation's hosts, gate
 * procedures or safe keys. Changing the repository or clones clears the last
 * probe because the old probe no longer describes the current checkout.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type { InstallationReferencePort } from '../ports/out/InstallationReferencePort.out-port.js';
import {
  ProjectProfileRevisionConflictError,
  type ProjectProfileRepositoryPort,
} from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  UpdateProjectProfilePort,
  UpdateProjectProfileRequest,
  UpdateProjectProfileResult,
} from '../ports/in/UpdateProjectProfilePort.in-port.js';

export interface UpdateProjectProfileDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
  readonly installationRefs?: InstallationReferencePort;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function trimString<T>(value: T): T {
  return (typeof value === 'string' ? value.trim() : value) as T;
}

function trimStringArray<T>(value: T): T {
  return (
    Array.isArray(value)
      ? value.map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : entry))
      : value
  ) as T;
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

const ALLOWED_CHANGE_FIELDS = new Set([
  'displayName',
  'repository',
  'designatedDispatcherHost',
  'policyRevision',
  'maxConcurrentLanes',
  'runnerCapabilities',
  'defaultBranch',
  'clones',
  'gateProcedures',
  'defaultAllowedPathPrefixes',
]);

export class UpdateProjectProfileUseCase implements UpdateProjectProfilePort {
  constructor(private readonly deps?: UpdateProjectProfileDependencies) {}

  async updateProjectProfile(
    request: UpdateProjectProfileRequest,
  ): Promise<UpdateProjectProfileResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<UpdateProjectProfileResult> {
    if (!this.deps) {
      throw new Error('Not implemented: UpdateProjectProfileUseCase');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as UpdateProjectProfileRequest;
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : '';
    const stored = await this.deps.profileRepo.findProfileById(projectId);
    if (stored === null) {
      return { outcome: 'rejected', reason: `project ${projectId} is not registered` };
    }
    if (stored.status === 'retired') {
      return {
        outcome: 'rejected',
        reason: `project ${projectId} is retired; a retired profile is not edited`,
      };
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
    const changes = request.changes;
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
      return { outcome: 'rejected', reason: 'changes must name at least one field' };
    }
    const changeKeys = Object.keys(changes);
    if (changeKeys.length === 0) {
      return { outcome: 'rejected', reason: 'changes must name at least one field' };
    }
    for (const key of changeKeys) {
      if (!ALLOWED_CHANGE_FIELDS.has(key)) {
        return { outcome: 'rejected', reason: `change ${key} is not allowed` };
      }
      if ((changes as Record<string, unknown>)[key] === undefined) {
        return { outcome: 'rejected', reason: `change ${key} has no value` };
      }
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    const merged: ProjectProfileRecord = {
      ...stored,
      ...changes,
      displayName:
        changes.displayName !== undefined ? trimString(changes.displayName) : stored.displayName,
      repository:
        changes.repository !== undefined ? trimString(changes.repository) : stored.repository,
      designatedDispatcherHost:
        changes.designatedDispatcherHost !== undefined
          ? trimString(changes.designatedDispatcherHost)
          : stored.designatedDispatcherHost,
      policyRevision:
        changes.policyRevision !== undefined
          ? trimString(changes.policyRevision)
          : stored.policyRevision,
      defaultBranch:
        changes.defaultBranch !== undefined
          ? trimString(changes.defaultBranch)
          : stored.defaultBranch,
      gateProcedures:
        changes.gateProcedures !== undefined
          ? trimStringArray(changes.gateProcedures)
          : stored.gateProcedures,
      defaultAllowedPathPrefixes:
        changes.defaultAllowedPathPrefixes !== undefined
          ? trimStringArray(changes.defaultAllowedPathPrefixes)
          : stored.defaultAllowedPathPrefixes,
      runnerCapabilities:
        changes.runnerCapabilities !== undefined
          ? Object.freeze({ ...changes.runnerCapabilities })
          : stored.runnerCapabilities,
      lastProbe:
        changes.repository !== undefined || changes.clones !== undefined ? null : stored.lastProbe,
      revision: stored.revision + 1,
      updatedAtIso: nowIso,
    };
    let profile: ProjectProfileRecord;
    try {
      profile = ProjectProfile.fromRecord(merged).toRecord();
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : 'profile update was refused',
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
    return { outcome: 'updated', profile };
  }
}
