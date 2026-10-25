// @generated adapter scaffold — implemented for migration step 2 (local transactional store).
/**
 * AttemptRepositoryAdapter implements AttemptRepositoryPort
 * (local-transactional-store). A fresh attempt identity is created per dispatch
 * and per fix round; saving over an existing attempt refuses any mutation of
 * immutable identity fields. Records live in memory by default and persist as
 * JSON via atomic temp-file-then-rename writes under an exclusive lock when `stateDir` is configured.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { AttemptRecord, AttemptRunnerRecord, RunnerKind } from '../../domain/execution-records.js';
import {
  AttemptRevisionConflictError,
  type AttemptRepositoryPort,
} from '../../application/ports/out/AttemptRepositoryPort.out-port.js';
import { quarantineUnreadable, withFileLock, writeJsonAtomically } from './file-store.js';

export interface AttemptRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

/** Identity established at dispatch time; lifecycle fields may change, these may not. */
const immutableAttemptIdentityFields = [
  'workOrderId',
  'kind',
  'fixNumber',
  'priorAttemptId',
  'worktreePath',
  'baseCommit',
] as const;

function isAttemptRecord(value: unknown): value is AttemptRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.workOrderId === 'string';
}

/**
 * Records persisted before lane O14c1 carry no runner `kind` and always had
 * an opencode port. Reading them normalizes to `kind: 'opencode'` and a
 * `remotePort` of `null` when absent, so downstream code never sees a record
 * without a kind and never crashes on a missing port.
 *
 * Records persisted before the host name existed (lane H3a) normalize the
 * same way: `hostName: null`. Those are legacy records whose ssh alias lives in
 * `host`, and after-dispatch actions apply the legacy rule to them.
 */
function normalizeRecord(record: AttemptRecord): AttemptRecord {
  // A missing or non-integer revision reads as 0, so every record coming out
  // of the repository carries an integer revision.
  const revision = Number.isInteger(record.revision) ? record.revision! : 0;
  const runner = record.runner;
  if (runner === undefined || runner === null) {
    return revision === record.revision ? record : { ...record, revision };
  }
  const raw = runner as AttemptRunnerRecord & { kind?: RunnerKind; hostName?: string | null };
  const kind: RunnerKind = raw.kind === 'agy' ? 'agy' : 'opencode';
  const hostName = typeof raw.hostName === 'string' && raw.hostName.trim() !== '' ? raw.hostName : null;
  if (kind === runner.kind && runner.remotePort !== undefined && runner.hostName === hostName) {
    return revision === record.revision ? record : { ...record, revision };
  }
  return {
    ...record,
    revision,
    runner: {
      ...runner,
      kind,
      remotePort: runner.remotePort ?? null,
      hostName,
    },
  };
}

export class AttemptRepositoryAdapter implements AttemptRepositoryPort {
  private readonly inMemoryRecords = new Map<string, AttemptRecord>();

  constructor(private readonly options?: AttemptRepositoryAdapterOptions) {}

  async saveAttempt(record: AttemptRecord): Promise<void> {
    const stateDir = this.options?.stateDir;
    const guardExisting = (existing: AttemptRecord): void => {
      // Immutable identity fields are guarded first: a stale revision must
      // never mask an identity mutation.
      const changed = immutableAttemptIdentityFields.filter(
        (field) => existing[field] !== record[field],
      );
      if (changed.length > 0) {
        throw new Error(
          `Immutable attempt identity changed for ${record.id}: ${changed.join(', ')}`,
        );
      }
      // Compare-and-swap: the writer must build on exactly the stored
      // revision, so its revision is stored + 1. Missing revisions on either
      // side count as 0.
      const expected = existing.revision ?? 0;
      const actual = record.revision ?? 0;
      if (actual !== expected + 1) {
        throw new AttemptRevisionConflictError(record.id, expected, actual);
      }
    };

    if (stateDir === undefined) {
      const existing = this.inMemoryRecords.get(record.id);
      if (existing !== undefined) {
        guardExisting(existing);
      }
      this.inMemoryRecords.set(record.id, normalizeRecord(record));
      return;
    }

    const target = path.join(stateDir, 'attempts.json');
    const lockPath = path.join(stateDir, 'attempts.json.lock');

    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(record.id);
      if (existing !== undefined) {
        guardExisting(existing);
      }
      records.set(record.id, normalizeRecord(record));
      await writeJsonAtomically(target, [...records.values()]);
    });
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryRecords.get(attemptId) ?? null;
    }
    const target = path.join(stateDir, 'attempts.json');
    const records = await this.readRecordsFromDisk(target);
    return records.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return [...this.inMemoryRecords.values()]
        .filter((record) => record.workOrderId === workOrderId)
        .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
    }
    const target = path.join(stateDir, 'attempts.json');
    const records = await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter((record) => record.workOrderId === workOrderId)
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return [...this.inMemoryRecords.values()].sort((a, b) =>
        b.updatedAtIso.localeCompare(a.updatedAtIso),
      );
    }
    const target = path.join(stateDir, 'attempts.json');
    const records = await this.readRecordsFromDisk(target);
    return [...records.values()].sort((a, b) =>
      b.updatedAtIso.localeCompare(a.updatedAtIso),
    );
  }

  private async readRecordsFromDisk(target: string): Promise<Map<string, AttemptRecord>> {
    const map = new Map<string, AttemptRecord>();
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return map;
      }
      throw error;
    }
    const raw = buffer.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await quarantineUnreadable(target, 'not valid JSON', buffer);
    }
    if (!Array.isArray(parsed)) {
      await quarantineUnreadable(target, 'expects a record list', buffer);
    }
    const records = parsed as unknown[];
    for (const [index, rawItem] of records.entries()) {
      if (!isAttemptRecord(rawItem)) {
        await quarantineUnreadable(target, `record ${index} failed validation`, buffer);
      }
      const item = rawItem as AttemptRecord;
      map.set(item.id, normalizeRecord(item));
    }
    return map;
  }
}
