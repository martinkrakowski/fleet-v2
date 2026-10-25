/**
 * ProjectProfileReadAdapter implements ProjectProfileReadPort by delegating
 * in-process to operator-coordination's InspectProjectProfilePort, bound by
 * the composition root (same delegate pattern as ActionAuthorizationAdapter).
 * Without a delegate it throws. The supplier's `found` answer is mapped to a
 * ProjectProfileView copying only the six view fields, validating their
 * types; `not-found` maps to null; `rejected` throws with its reason; any
 * other or malformed answer throws a malformed-profile error.
 */

import { isValidHostName } from '@fleet/shared';

import type {
  ProjectProfileReadPort,
  ProjectProfileView,
} from '../../application/ports/out/ProjectProfileReadPort.out-port.js';

export interface ProjectProfileReadDelegate {
  readonly inspect?: (req: { projectId: string }) => Promise<unknown>;
}

function malformed(projectId: string): Error {
  return new Error(`ProjectProfileReadAdapter received a malformed profile for ${projectId}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.startsWith('/');
}

function isClone(value: unknown): value is { path: string; worktreeRoot: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return isAbsolutePath(value.path) && isAbsolutePath(value.worktreeRoot);
}

function readClones(
  projectId: string,
  value: unknown,
): Readonly<Record<string, { path: string; worktreeRoot: string }>> {
  if (!isPlainObject(value)) {
    throw malformed(projectId);
  }
  const copy: Record<string, { path: string; worktreeRoot: string }> = {};
  for (const [key, clone] of Object.entries(value)) {
    if (!isValidHostName(key) || !isClone(clone)) {
      throw malformed(projectId);
    }
    Object.defineProperty(copy, key, {
      value: { path: clone.path, worktreeRoot: clone.worktreeRoot },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function mapProfile(projectId: string, profile: Record<string, unknown>): ProjectProfileView {
  if (typeof profile.projectId !== 'string' || profile.projectId !== projectId) {
    throw malformed(projectId);
  }
  if (profile.status !== 'active' && profile.status !== 'retired') {
    throw malformed(projectId);
  }
  if (typeof profile.repository !== 'string') {
    throw malformed(projectId);
  }
  const clones = readClones(projectId, profile.clones);
  if (!isStringArray(profile.gateProcedures)) {
    throw malformed(projectId);
  }
  if (!Number.isInteger(profile.revision) || (profile.revision as number) < 0) {
    throw malformed(projectId);
  }
  return {
    projectId: profile.projectId,
    status: profile.status,
    repository: profile.repository,
    clones,
    gateProcedures: profile.gateProcedures,
    revision: profile.revision as number,
  };
}

export class ProjectProfileReadAdapter implements ProjectProfileReadPort {
  constructor(private readonly delegate?: ProjectProfileReadDelegate) {}

  async readProjectProfile(projectId: string): Promise<ProjectProfileView | null> {
    const inspect = this.delegate?.inspect;
    if (!inspect) {
      throw new Error('Not implemented: ProjectProfileReadAdapter');
    }

    const answer = await inspect({ projectId });
    if (answer === null || typeof answer !== 'object') {
      throw malformed(projectId);
    }
    const record = answer as Record<string, unknown>;

    switch (record.outcome) {
      case 'found': {
        const profile = record.profile;
        if (profile === null || typeof profile !== 'object') {
          throw malformed(projectId);
        }
        return mapProfile(projectId, profile as Record<string, unknown>);
      }
      case 'not-found':
        return null;
      case 'rejected':
        throw new Error(String(record.reason ?? 'profile read rejected'));
      default:
        throw malformed(projectId);
    }
  }
}
