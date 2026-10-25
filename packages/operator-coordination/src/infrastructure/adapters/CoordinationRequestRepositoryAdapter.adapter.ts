/**
 * CoordinationRequestRepositoryAdapter implements
 * CoordinationRequestRepositoryPort over a local transactional store: an
 * in-process map that optionally persists to
 * `<stateDir>/coordination-requests.json` under an exclusive lock.
 *
 * Every stored or loaded record is re-validated by the domain, so a request
 * that would duplicate a consumption, hide a delivery gap or invent a state
 * never becomes readable state. Writes are revision-aware: a stale or
 * conflicting revision evaluated against the freshly read record raises the
 * typed CoordinationRequestRevisionConflictError rather than a silent
 * overwrite, and lookups return known absence as null instead of synthesizing
 * a request.
 */

import { join } from 'node:path';

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import { CoordinationRequestRevisionConflictError } from '../../application/ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { CoordinationRequestRepositoryPort } from '../../application/ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';
import { readRecordList } from './record-list-store.js';

export interface CoordinationRequestRepositoryAdapterOptions {
  /** When set, requests are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
}

const DEFAULT_FILE_NAME = 'coordination-requests.json';
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function copy(record: CoordinationRequestRecord): CoordinationRequestRecord {
  return {
    ...record,
    consumptions: record.consumptions.map((consumption) => ({ ...consumption })),
    acknowledgements: record.acknowledgements.map((acknowledgement) => ({ ...acknowledgement })),
  };
}

/**
 * Refuse a write that loses a race with a fresher record: a stale revision, or
 * the same revision carrying different content. Both are a lost race, never a
 * silent overwrite, and both surface as the typed conflict error.
 */
function refuseRevisionConflict(
  validated: CoordinationRequestRecord,
  existing: CoordinationRequestRecord,
): void {
  if (validated.revision < existing.revision) {
    throw new CoordinationRequestRevisionConflictError(
      validated.id,
      validated.revision,
      `CoordinationRequestRepositoryAdapter refuses stale revision ${validated.revision} for ${validated.id}; stored revision is ${existing.revision}`,
    );
  }
  if (
    validated.revision === existing.revision &&
    JSON.stringify(copy(validated)) !== JSON.stringify(copy(existing))
  ) {
    throw new CoordinationRequestRevisionConflictError(
      validated.id,
      validated.revision,
      `CoordinationRequestRepositoryAdapter refuses conflicting revision ${validated.revision} for ${validated.id}`,
    );
  }
}

export class CoordinationRequestRepositoryAdapter implements CoordinationRequestRepositoryPort {
  private readonly inMemoryRequests = new Map<string, CoordinationRequestRecord>();
  private readonly inMemoryGrants = new Map<string, string>();

  constructor(private readonly options: CoordinationRequestRepositoryAdapterOptions = {}) {}

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    const target = this.statePath;
    if (target === null) {
      const validated = CoordinationRequest.fromRecord(record).toRecord();
      const existing = this.inMemoryRequests.get(validated.id);
      if (existing !== undefined) {
        refuseRevisionConflict(validated, existing);
      }
      this.inMemoryRequests.set(validated.id, validated);
      this.reindexGrant(validated);
      return;
    }

    const lockPath = `${target}.lock`;
    const validated = CoordinationRequest.fromRecord(record).toRecord();

    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(validated.id);
      if (existing !== undefined) {
        refuseRevisionConflict(validated, existing);
      }
      records.set(validated.id, validated);
      const list = [...records.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(copy);
      await writeJsonAtomically(target, list);
    });
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemoryRequests.get(requestId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = records.get(requestId);
    return found === undefined ? null : copy(found);
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    const target = this.statePath;
    if (target === null) {
      const requestId = this.inMemoryGrants.get(grantId);
      if (requestId === undefined) {
        return null;
      }
      const found = this.inMemoryRequests.get(requestId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = [...records.values()].find((r) => r.grantId === grantId);
    return found === undefined ? null : copy(found);
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    const target = this.statePath;
    const wanted =
      typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : undefined;
    if (target === null) {
      return [...this.inMemoryRequests.values()]
        .filter((record) => wanted === undefined || record.projectId === wanted)
        .sort((left, right) =>
          left.createdAtIso === right.createdAtIso
            ? left.id.localeCompare(right.id)
            : left.createdAtIso.localeCompare(right.createdAtIso),
        )
        .map(copy);
    }
    const records = await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter((record) => wanted === undefined || record.projectId === wanted)
      .sort((left, right) =>
        left.createdAtIso === right.createdAtIso
          ? left.id.localeCompare(right.id)
          : left.createdAtIso.localeCompare(right.createdAtIso),
      )
      .map(copy);
  }

  private reindexGrant(record: CoordinationRequestRecord): void {
    for (const [grantId, requestId] of [...this.inMemoryGrants.entries()]) {
      if (requestId === record.id) {
        this.inMemoryGrants.delete(grantId);
      }
    }
    if (record.grantId !== null) {
      this.inMemoryGrants.set(record.grantId, record.id);
    }
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (!SAFE_FILE_NAME.test(name)) {
      throw new Error(`CoordinationRequestRepositoryAdapter refuses unsafe state file name: ${name}`);
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(path: string): Promise<Map<string, CoordinationRequestRecord>> {
    const records = await readRecordList(
      path,
      'CoordinationRequestRepositoryAdapter',
      (entry) =>
        CoordinationRequest.fromRecord(entry as CoordinationRequestRecord).toRecord(),
    );
    const map = new Map<string, CoordinationRequestRecord>();
    for (const record of records) {
      map.set(record.id, record);
    }
    return map;
  }
}
