/**
 * ProjectProfileReadAdapter implements ProjectProfileReadPort by delegating
 * in-process to operator-coordination's InspectProjectProfilePort, bound by
 * the composition root (same delegate pattern as ActionAuthorizationAdapter).
 * Without a delegate it throws. The supplier's `found` answer is mapped to a
 * ProjectProfileView copying only the six view fields, validating their
 * types; `not-found` maps to null; `rejected` throws with its reason; any
 * other or malformed answer throws a malformed-profile error.
 */

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

function isClone(value: unknown): value is { path: string; worktreeRoot: string } {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const clone = value as Record<string, unknown>;
  return typeof clone.path === 'string' && typeof clone.worktreeRoot === 'string';
}

function isClonesRecord(
  value: unknown,
): value is Readonly<Record<string, { path: string; worktreeRoot: string }>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const clones = value as Record<string, unknown>;
  return Object.values(clones).every(isClone);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function mapProfile(projectId: string, profile: Record<string, unknown>): ProjectProfileView {
  if (typeof profile.projectId !== 'string') {
    throw malformed(projectId);
  }
  if (profile.status !== 'active' && profile.status !== 'retired') {
    throw malformed(projectId);
  }
  if (typeof profile.repository !== 'string') {
    throw malformed(projectId);
  }
  if (!isClonesRecord(profile.clones)) {
    throw malformed(projectId);
  }
  if (!isStringArray(profile.gateProcedures)) {
    throw malformed(projectId);
  }
  if (typeof profile.revision !== 'number') {
    throw malformed(projectId);
  }
  return {
    projectId: profile.projectId as string,
    status: profile.status as 'active' | 'retired',
    repository: profile.repository as string,
    clones: profile.clones,
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
