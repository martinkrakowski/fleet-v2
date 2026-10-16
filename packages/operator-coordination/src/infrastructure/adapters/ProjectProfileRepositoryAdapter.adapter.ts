/**
 * ProjectProfileRepositoryAdapter implements ProjectProfileRepositoryPort over a
 * private installation store: an in-process map that optionally persists to
 * `<stateDir>/project-profiles.json` under an exclusive lock.
 *
 * Only the fields this context owns are persisted, and every stored or loaded
 * profile is re-validated by the domain before it is handed back, so a
 * credential-shaped field can never accumulate in installation state. Writes
 * are version-aware: a stale or conflicting revision evaluated against the
 * freshly read record is an error, never a silent overwrite, and known absence
 * is null while unreadable state throws.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type { ProjectProfileRepositoryPort } from '../../application/ports/out/ProjectProfileRepositoryPort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

export interface ProjectProfileRepositoryAdapterOptions {
  /** When set, profiles are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
}

const DEFAULT_FILE_NAME = 'project-profiles.json';
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function copy(record: ProjectProfileRecord): ProjectProfileRecord {
  return { ...record, runnerCapabilities: { ...record.runnerCapabilities } };
}

export class ProjectProfileRepositoryAdapter implements ProjectProfileRepositoryPort {
  private readonly inMemoryProfiles = new Map<string, ProjectProfileRecord>();

  constructor(private readonly options: ProjectProfileRepositoryAdapterOptions = {}) {}

  async saveProfile(record: ProjectProfileRecord): Promise<void> {
    const target = this.statePath;
    if (target === null) {
      const validated = ProjectProfile.fromRecord(record).toRecord();
      const existing = this.inMemoryProfiles.get(validated.projectId);
      if (existing !== undefined) {
        if (validated.revision < existing.revision) {
          throw new Error(
            `ProjectProfileRepositoryAdapter refuses stale revision ${validated.revision} for ${validated.projectId}; stored revision is ${existing.revision}`,
          );
        }
        if (
          validated.revision === existing.revision &&
          JSON.stringify(copy(validated)) !== JSON.stringify(copy(existing))
        ) {
          throw new Error(
            `ProjectProfileRepositoryAdapter refuses conflicting revision ${validated.revision} for ${validated.projectId}`,
          );
        }
      }
      this.inMemoryProfiles.set(validated.projectId, validated);
      return;
    }

    const lockPath = `${target}.lock`;
    const validated = ProjectProfile.fromRecord(record).toRecord();

    await withFileLock(lockPath, async () => {
      const profiles = await this.readProfilesFromDisk(target);
      const existing = profiles.get(validated.projectId);
      if (existing !== undefined) {
        if (validated.revision < existing.revision) {
          throw new Error(
            `ProjectProfileRepositoryAdapter refuses stale revision ${validated.revision} for ${validated.projectId}; stored revision is ${existing.revision}`,
          );
        }
        if (
          validated.revision === existing.revision &&
          JSON.stringify(copy(validated)) !== JSON.stringify(copy(existing))
        ) {
          throw new Error(
            `ProjectProfileRepositoryAdapter refuses conflicting revision ${validated.revision} for ${validated.projectId}`,
          );
        }
      }
      profiles.set(validated.projectId, validated);
      const list = [...profiles.values()]
        .sort((left, right) => left.projectId.localeCompare(right.projectId))
        .map(copy);
      await writeJsonAtomically(target, list);
    });
  }

  async findProfileById(projectId: string): Promise<ProjectProfileRecord | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemoryProfiles.get(projectId);
      return found === undefined ? null : copy(found);
    }
    const profiles = await this.readProfilesFromDisk(target);
    const found = profiles.get(projectId);
    return found === undefined ? null : copy(found);
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (!SAFE_FILE_NAME.test(name)) {
      throw new Error(`ProjectProfileRepositoryAdapter refuses unsafe state file name: ${name}`);
    }
    return join(stateDir, name);
  }

  private async readProfilesFromDisk(path: string): Promise<Map<string, ProjectProfileRecord>> {
    const map = new Map<string, ProjectProfileRecord>();
    let contents: string;
    try {
      contents = await fs.readFile(path, 'utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return map;
      }
      throw new Error(
        `ProjectProfileRepositoryAdapter could not read ${path}: ${describe(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error: unknown) {
      throw new Error(
        `ProjectProfileRepositoryAdapter could not parse ${path}: ${describe(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`ProjectProfileRepositoryAdapter expects a record list in ${path}`);
    }
    for (const entry of parsed) {
      const profile = ProjectProfile.fromRecord(entry as ProjectProfileRecord).toRecord();
      map.set(profile.projectId, profile);
    }
    return map;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
