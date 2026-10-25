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
import { join, resolve } from 'node:path';

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfile } from '../../domain/entities/ProjectProfile.js';
import type { ProjectProfileRepositoryPort } from '../../application/ports/out/ProjectProfileRepositoryPort.out-port.js';
import { ProjectProfileRevisionConflictError } from '../../application/ports/out/ProjectProfileRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';
import { readRecordList } from './record-list-store.js';

export interface ProjectProfileRepositoryAdapterOptions {
  /** When set, profiles are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
}

const DEFAULT_FILE_NAME = 'project-profiles.json';
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function copy(record: ProjectProfileRecord): ProjectProfileRecord {
  return ProjectProfile.fromRecord(record).toRecord();
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseProjectProfileStateRecord(raw: unknown): ProjectProfileRecord | undefined {
  return ProjectProfile.fromRecord(raw as ProjectProfileRecord).toRecord();
}

export class ProjectProfileRepositoryAdapter implements ProjectProfileRepositoryPort {
  private readonly inMemoryProfiles = new Map<string, ProjectProfileRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options: ProjectProfileRepositoryAdapterOptions = {}) {
    this.changeSignal = options.changeSignal ?? new NoopChangeSignalAdapter();
  }

  get signalEmitFailures(): number {
    return this.signalEmitFailuresCount;
  }

  private signal(sig: ChangeSignal): void {
    try {
      this.changeSignal.emit(sig);
    } catch {
      this.signalEmitFailuresCount += 1;
    }
  }

  async saveProfile(record: ProjectProfileRecord): Promise<void> {
    const target = this.statePath;
    if (target === null) {
      const validated = ProjectProfile.fromRecord(record).toRecord();
      const existing = this.inMemoryProfiles.get(validated.projectId);
      this.assertWritable(existing, validated);
      this.inMemoryProfiles.set(validated.projectId, validated);
      this.signal({ kind: 'profile', id: validated.projectId, stateFile: null, before: null, written: null });
      return;
    }

    const lockPath = `${target}.lock`;
    const validated = ProjectProfile.fromRecord(record).toRecord();

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    await withFileLock(lockPath, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const profiles = await this.readProfilesFromDisk(target);
      const existing = profiles.get(validated.projectId);
      this.assertWritable(existing, validated);
      profiles.set(validated.projectId, validated);
      const list = [...profiles.values()]
        .sort((left, right) => left.projectId.localeCompare(right.projectId))
        .map(copy);
      await writeJsonAtomically(target, list);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    this.signal({
      kind: 'profile',
      id: validated.projectId,
      stateFile: resolve(target),
      before,
      written,
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

  async listProfiles(): Promise<readonly ProjectProfileRecord[]> {
    const target = this.statePath;
    if (target === null) {
      return [...this.inMemoryProfiles.values()]
        .sort((left, right) => left.projectId.localeCompare(right.projectId))
        .map(copy);
    }
    const profiles = await this.readProfilesFromDisk(target);
    return [...profiles.values()]
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
      .map(copy);
  }

  /**
   * Strict compare-and-swap: a new id is stored only at revision 0; an
   * existing id is stored only when the incoming revision is exactly one more
   * than the stored revision. Anything else is a `ProjectProfileRevisionConflictError`.
   */
  private assertWritable(
    existing: ProjectProfileRecord | undefined,
    incoming: ProjectProfileRecord,
  ): void {
    if (existing === undefined) {
      if (incoming.revision !== 0) {
        throw new ProjectProfileRevisionConflictError(incoming.projectId, -1, incoming.revision);
      }
      return;
    }
    if (incoming.revision !== existing.revision + 1) {
      throw new ProjectProfileRevisionConflictError(
        incoming.projectId,
        existing.revision,
        incoming.revision,
      );
    }
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
    const records = await readRecordList(
      path,
      'ProjectProfileRepositoryAdapter',
      parseProjectProfileStateRecord,
    );
    const map = new Map<string, ProjectProfileRecord>();
    for (const profile of records) {
      map.set(profile.projectId, profile);
    }
    return map;
  }
}
