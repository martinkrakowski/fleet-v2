/**
 * UpdateProjectProfileUseCase implements UpdateProjectProfilePort. It edits an
 * active profile only when the caller names the revision it read and refuses
 * any change that would move the profile off the installation's hosts, gate
 * procedures or safe keys. Changing the repository or clones clears the last
 * probe because the old probe no longer describes the current checkout.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import type { InstallationReferencePort } from '../ports/out/InstallationReferencePort.out-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  UpdateProjectProfilePort,
  UpdateProjectProfileRequest,
  UpdateProjectProfileResult,
} from '../ports/in/UpdateProjectProfilePort.in-port.js';
import {
  checkInstallationNames,
  isFilled,
  isPlainObject,
  parseProfileRecord,
  saveProfileWithConflictCheck,
  trimString,
  trimStringArray,
} from './profile-write-checks.js';

export interface UpdateProjectProfileDependencies {
  readonly profileRepo: ProjectProfileRepositoryPort;
  readonly installationRefs?: InstallationReferencePort;
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

function pickTrimmedString<T>(changed: T | undefined, fallback: T): T {
  return changed !== undefined ? trimString(changed) : fallback;
}

function pickTrimmedStringArray<T>(changed: T | undefined, fallback: T): T {
  return changed !== undefined ? trimStringArray(changed) : fallback;
}

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
    if (!isPlainObject(input)) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const request = input as UpdateProjectProfileRequest;
    const projectId = typeof request.projectId === 'string' ? trimString(request.projectId) : '';
    const stored = await this.deps.profileRepo.findProfileById(projectId);
    if (stored === null) {
      return { outcome: 'rejected', reason: `project ${projectId} is not registered` };
    }
    const editableError = this.checkEditableProfile(projectId, stored, request.expectedRevision);
    if (editableError !== null) {
      return { outcome: 'rejected', reason: editableError };
    }
    const changesError = this.validateChanges(request.changes);
    if (changesError !== null) {
      return { outcome: 'rejected', reason: changesError };
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    const merged = this.buildMergedRecord(stored, request.changes, nowIso);
    return this.persistUpdatedProfile(this.deps, projectId, merged);
  }

  private checkEditableProfile(
    projectId: string,
    stored: ProjectProfileRecord,
    expectedRevision: number,
  ): string | null {
    if (stored.status === 'retired') {
      return `project ${projectId} is retired; a retired profile is not edited`;
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return 'expectedRevision must be a non-negative integer';
    }
    if (expectedRevision !== stored.revision) {
      return `project ${projectId} is at revision ${stored.revision}, not ${expectedRevision}; read it again`;
    }
    return null;
  }

  private validateChanges(changes: unknown): string | null {
    if (!isPlainObject(changes)) {
      return 'changes must name at least one field';
    }
    const changeMap = changes as Record<string, unknown>;
    const changeKeys = Object.keys(changeMap);
    if (changeKeys.length === 0) {
      return 'changes must name at least one field';
    }
    for (const key of changeKeys) {
      if (!ALLOWED_CHANGE_FIELDS.has(key)) {
        return `change ${key} is not allowed`;
      }
      if (changeMap[key] === undefined) {
        return `change ${key} has no value`;
      }
    }
    return null;
  }

  private buildMergedRecord(
    stored: ProjectProfileRecord,
    changes: UpdateProjectProfileRequest['changes'],
    nowIso: string,
  ): ProjectProfileRecord {
    return {
      ...stored,
      ...changes,
      displayName: pickTrimmedString(changes.displayName, stored.displayName),
      repository: pickTrimmedString(changes.repository, stored.repository),
      designatedDispatcherHost: pickTrimmedString(
        changes.designatedDispatcherHost,
        stored.designatedDispatcherHost,
      ),
      policyRevision: pickTrimmedString(changes.policyRevision, stored.policyRevision),
      defaultBranch: pickTrimmedString(changes.defaultBranch, stored.defaultBranch),
      gateProcedures: pickTrimmedStringArray(changes.gateProcedures, stored.gateProcedures),
      defaultAllowedPathPrefixes: pickTrimmedStringArray(
        changes.defaultAllowedPathPrefixes,
        stored.defaultAllowedPathPrefixes,
      ),
      runnerCapabilities:
        changes.runnerCapabilities !== undefined
          ? Object.freeze({ ...changes.runnerCapabilities })
          : stored.runnerCapabilities,
      lastProbe:
        changes.repository !== undefined || changes.clones !== undefined ? null : stored.lastProbe,
      revision: stored.revision + 1,
      updatedAtIso: nowIso,
    };
  }

  private async persistUpdatedProfile(
    deps: UpdateProjectProfileDependencies,
    projectId: string,
    merged: ProjectProfileRecord,
  ): Promise<UpdateProjectProfileResult> {
    const parsed = parseProfileRecord(merged, 'profile update was refused');
    if ('reason' in parsed) {
      return { outcome: 'rejected', reason: parsed.reason };
    }
    const refusal =
      checkInstallationNames(deps.installationRefs, parsed.profile) ??
      (await saveProfileWithConflictCheck(deps.profileRepo, parsed.profile, projectId));
    if (refusal !== null) {
      return { outcome: 'rejected', reason: refusal };
    }
    return { outcome: 'updated', profile: parsed.profile };
  }
}
