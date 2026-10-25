/**
 * Shared validation and persistence helpers for project profile registration
 * and updates. Pure application-layer functions with no runtime I/O imports.
 */

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type { InstallationReferencePort } from '../ports/out/InstallationReferencePort.out-port.js';
import {
  ProjectProfileRevisionConflictError,
  type ProjectProfileRepositoryPort,
} from '../ports/out/ProjectProfileRepositoryPort.out-port.js';

/**
 * Field and capability names that would move a secret into persisted
 * installation state. Only names are inspected; values are never read, copied
 * or compared.
 */
const CREDENTIAL_NAME_PATTERN =
  /(token|secret|credential|password|passphrase|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie)/i;

export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

export function isPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function trimString<T>(value: T): T {
  return (typeof value === 'string' ? value.trim() : value) as T;
}

export function trimStringArray<T>(value: T): T {
  return (
    Array.isArray(value)
      ? value.map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : entry))
      : value
  ) as T;
}

export function findCredentialName(names: readonly string[]): string | null {
  for (const name of names) {
    if (CREDENTIAL_NAME_PATTERN.test(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Check a candidate profile's host and procedure names against the loaded
 * installation. Returns null when the names are acceptable or no installation
 * reference was supplied; otherwise the refusal reason. The designated
 * dispatcher host is checked first, then clone hosts in sorted order, then
 * gate procedures.
 */
export function checkInstallationNames(
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
  for (const host of Object.keys(profile.clones).sort(compareCodeUnits)) {
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

export function parseProfileRecord(
  candidate: ProjectProfileRecord,
  fallbackReason: string,
): { readonly profile: ProjectProfileRecord } | { readonly reason: string } {
  try {
    return { profile: ProjectProfile.fromRecord(candidate).toRecord() };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : fallbackReason,
    };
  }
}

export async function saveProfileWithConflictCheck(
  profileRepo: ProjectProfileRepositoryPort,
  profile: ProjectProfileRecord,
  projectId: string,
): Promise<string | null> {
  try {
    await profileRepo.saveProfile(profile);
    return null;
  } catch (error) {
    if (error instanceof ProjectProfileRevisionConflictError) {
      return `profile ${projectId} changed while it was being written; read it again and retry`;
    }
    throw error;
  }
}
