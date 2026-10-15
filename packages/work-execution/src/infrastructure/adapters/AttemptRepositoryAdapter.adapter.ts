// @generated adapter scaffold — implemented for migration step 2 (local transactional store).
/**
 * AttemptRepositoryAdapter implements AttemptRepositoryPort
 * (local-transactional-store). A fresh attempt identity is created per dispatch
 * and per fix round; saving over an existing attempt refuses any mutation of
 * immutable identity fields. Records live in memory by default and persist as
 * JSON via atomic temp-file-then-rename writes when `stateDir` is configured.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../application/ports/out/AttemptRepositoryPort.out-port.js';

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

let attemptTempCounter = 0;

function isAttemptRecord(value: unknown): value is AttemptRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.workOrderId === 'string';
}

export class AttemptRepositoryAdapter implements AttemptRepositoryPort {
  private readonly records = new Map<string, AttemptRecord>();
  private loadPromise: Promise<void> | null = null;
  private persistCounter = 0;

  constructor(private readonly options?: AttemptRepositoryAdapterOptions) {}

  async saveAttempt(record: AttemptRecord): Promise<void> {
    await this.ensureLoaded();
    const existing = this.records.get(record.id);
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
    this.records.set(record.id, record);
    await this.persist();
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    await this.ensureLoaded();
    return this.records.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    await this.ensureLoaded();
    return [...this.records.values()]
      .filter((record) => record.workOrderId === workOrderId)
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    await this.ensureLoaded();
    return [...this.records.values()].sort((a, b) =>
      b.updatedAtIso.localeCompare(a.updatedAtIso),
    );
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.loadFromDisk().catch((error: unknown) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) return;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(stateDir, 'attempts.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (isAttemptRecord(item)) this.records.set(item.id, item);
    }
  }

  private async persist(): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) return;
    const target = path.join(stateDir, 'attempts.json');
    const temp = `${target}.${process.pid}-${this.persistCounter++}-${attemptTempCounter++}.tmp`;
    const serialized = JSON.stringify([...this.records.values()], null, 2);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      await fs.writeFile(temp, serialized, 'utf8');
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
