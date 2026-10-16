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

import type { AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../application/ports/out/AttemptRepositoryPort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

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

export class AttemptRepositoryAdapter implements AttemptRepositoryPort {
  private readonly inMemoryRecords = new Map<string, AttemptRecord>();

  constructor(private readonly options?: AttemptRepositoryAdapterOptions) {}

  async saveAttempt(record: AttemptRecord): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const existing = this.inMemoryRecords.get(record.id);
      if (existing !== undefined) {
        const changed = immutableAttemptIdentityFields.filter(
          (field) => existing[field] !== record[field],
        );
        if (changed.length > 0) {
          throw new Error(
            `Immutable attempt identity changed for ${record.id}: ${changed.join(', ')}`,
          );
        }
      }
      this.inMemoryRecords.set(record.id, record);
      return;
    }

    const target = path.join(stateDir, 'attempts.json');
    const lockPath = path.join(stateDir, 'attempts.json.lock');

    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(record.id);
      if (existing !== undefined) {
        const changed = immutableAttemptIdentityFields.filter(
          (field) => existing[field] !== record[field],
        );
        if (changed.length > 0) {
          throw new Error(
            `Immutable attempt identity changed for ${record.id}: ${changed.join(', ')}`,
          );
        }
      }
      records.set(record.id, record);
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
    let raw: string;
    try {
      raw = await fs.readFile(target, 'utf8');
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return map;
    }
    if (!Array.isArray(parsed)) return map;
    for (const item of parsed) {
      if (isAttemptRecord(item)) map.set(item.id, item);
    }
    return map;
  }
}
