/**
 * CoordinationRequestRepositoryAdapter implements
 * CoordinationRequestRepositoryPort over a local transactional store: an
 * in-process map that optionally persists to
 * `<stateDir>/coordination-requests.json`.
 *
 * Every stored or loaded record is re-validated by the domain, so a request
 * that would duplicate a consumption, hide a delivery gap or invent a state
 * never becomes readable state. Writes are revision-aware: a stale or
 * conflicting revision is an error rather than a silent overwrite, and lookups
 * return known absence as null instead of synthesizing a request.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import type { CoordinationRequestRepositoryPort } from '../../application/ports/out/CoordinationRequestRepositoryPort.out-port.js';

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

export class CoordinationRequestRepositoryAdapter implements CoordinationRequestRepositoryPort {
  private readonly requests = new Map<string, CoordinationRequestRecord>();
  private readonly grants = new Map<string, string>();
  private loaded = false;

  constructor(private readonly options: CoordinationRequestRepositoryAdapterOptions = {}) {}

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    await this.ensureLoaded();
    const validated = CoordinationRequest.fromRecord(record).toRecord();
    const existing = this.requests.get(validated.id);
    if (existing !== undefined) {
      if (validated.revision < existing.revision) {
        throw new Error(
          `CoordinationRequestRepositoryAdapter refuses stale revision ${validated.revision} for ${validated.id}; stored revision is ${existing.revision}`,
        );
      }
      if (
        validated.revision === existing.revision &&
        JSON.stringify(copy(validated)) !== JSON.stringify(copy(existing))
      ) {
        throw new Error(
          `CoordinationRequestRepositoryAdapter refuses conflicting revision ${validated.revision} for ${validated.id}`,
        );
      }
    }
    this.requests.set(validated.id, validated);
    this.reindexGrant(validated);
    await this.persist();
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    await this.ensureLoaded();
    const found = this.requests.get(requestId);
    return found === undefined ? null : copy(found);
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    await this.ensureLoaded();
    const requestId = this.grants.get(grantId);
    if (requestId === undefined) {
      return null;
    }
    const found = this.requests.get(requestId);
    return found === undefined ? null : copy(found);
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    await this.ensureLoaded();
    const wanted =
      typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : undefined;
    return [...this.requests.values()]
      .filter((record) => wanted === undefined || record.projectId === wanted)
      .sort((left, right) =>
        left.createdAtIso === right.createdAtIso
          ? left.id.localeCompare(right.id)
          : left.createdAtIso.localeCompare(right.createdAtIso),
      )
      .map(copy);
  }

  /** A grant moves with its record; a released grant stops resolving. */
  private reindexGrant(record: CoordinationRequestRecord): void {
    for (const [grantId, requestId] of [...this.grants.entries()]) {
      if (requestId === record.id) {
        this.grants.delete(grantId);
      }
    }
    if (record.grantId !== null) {
      this.grants.set(record.grantId, record.id);
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

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const path = this.statePath;
    if (path === null) {
      return;
    }
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw new Error(
        `CoordinationRequestRepositoryAdapter could not read ${path}: ${describe(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `CoordinationRequestRepositoryAdapter could not parse ${path}: ${describe(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`CoordinationRequestRepositoryAdapter expects a record list in ${path}`);
    }
    for (const entry of parsed) {
      const record = CoordinationRequest.fromRecord(entry as CoordinationRequestRecord).toRecord();
      this.requests.set(record.id, record);
      this.reindexGrant(record);
    }
  }

  private async persist(): Promise<void> {
    const path = this.statePath;
    if (path === null) {
      return;
    }
    const records = [...this.requests.values()].sort((left, right) => left.id.localeCompare(right.id)).map(copy);
    await mkdir(this.options.stateDir as string, { recursive: true });
    await writeFile(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
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
