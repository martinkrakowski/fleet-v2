// @generated adapter scaffold — implemented for migration step 2 (local transactional store).
/**
 * WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort
 * (local-transactional-store). Records live in an in-memory map by default;
 * when `stateDir` is configured each mutation is persisted as JSON via an
 * atomic temp-file-then-rename write under an exclusive lock. Optimistic concurrency refuses stale
 * revisions evaluated against the freshly read record.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import type { WorkOrderRepositoryPort } from '../../application/ports/out/WorkOrderRepositoryPort.out-port.js';
import { quarantineUnreadable, withFileLock, writeJsonAtomically } from './file-store.js';

export interface WorkOrderRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

function isWorkOrderRecord(value: unknown): value is WorkOrderRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number';
}

export class WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort {
  private readonly inMemoryRecords = new Map<string, WorkOrderRecord>();

  constructor(private readonly options?: WorkOrderRepositoryAdapterOptions) {}

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const existing = this.inMemoryRecords.get(record.id);
      if (existing !== undefined && existing.revision >= record.revision) {
        throw new Error(
          `Stale work order revision for ${record.id}: expected > ${existing.revision}, got ${record.revision}`,
        );
      }
      this.inMemoryRecords.set(record.id, record);
      return;
    }

    const target = path.join(stateDir, 'work-orders.json');
    const lockPath = path.join(stateDir, 'work-orders.json.lock');

    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(record.id);
      if (existing !== undefined && existing.revision >= record.revision) {
        throw new Error(
          `Stale work order revision for ${record.id}: expected > ${existing.revision}, got ${record.revision}`,
        );
      }
      records.set(record.id, record);
      await writeJsonAtomically(target, [...records.values()]);
    });
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryRecords.get(workOrderId) ?? null;
    }
    const target = path.join(stateDir, 'work-orders.json');
    const records = await this.readRecordsFromDisk(target);
    return records.get(workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const records = [...this.inMemoryRecords.values()];
      if (projectId === undefined) return records;
      return records.filter((record) => record.projectId === projectId);
    }
    const target = path.join(stateDir, 'work-orders.json');
    const records = await this.readRecordsFromDisk(target);
    const list = [...records.values()];
    if (projectId === undefined) return list;
    return list.filter((record) => record.projectId === projectId);
  }

  private async readRecordsFromDisk(target: string): Promise<Map<string, WorkOrderRecord>> {
    const map = new Map<string, WorkOrderRecord>();
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
      if (!isWorkOrderRecord(rawItem)) {
        await quarantineUnreadable(target, `record ${index} failed validation`, buffer);
      }
      const item = rawItem as WorkOrderRecord;
      map.set(item.id, item);
    }
    return map;
  }
}
