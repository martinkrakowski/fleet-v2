// @generated adapter scaffold — implemented for migration step 2 (local transactional store).
/**
 * WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort
 * (local-transactional-store). Records live in an in-memory map by default;
 * when `stateDir` is configured each mutation is persisted as JSON via an
 * atomic temp-file-then-rename write under an exclusive lock. Optimistic concurrency refuses stale
 * revisions evaluated against the freshly read record.
 * With `readOnly` the store never writes: an unreadable file is a read
 * error with no quarantine copy, and every save is refused.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import type { WorkOrderRepositoryPort } from '../../application/ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import {
  assertStoreWritable,
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface WorkOrderRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
  /**
   * Read-only (telemetry plan §3.3): an unreadable file is a read error with no quarantine copy
   * (`StateFileUnreadableReadOnlyError`), and every write throws `ReadOnlyStateStoreError`.
   */
  readonly readOnly?: boolean;
}

function isWorkOrderRecord(value: unknown): value is WorkOrderRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number';
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseWorkOrderStateRecord(raw: unknown): WorkOrderRecord | undefined {
  return isWorkOrderRecord(raw) ? raw : undefined;
}

export class WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort {
  private readonly inMemoryRecords = new Map<string, WorkOrderRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options?: WorkOrderRepositoryAdapterOptions) {
    this.changeSignal = options?.changeSignal ?? new NoopChangeSignalAdapter();
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

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    assertStoreWritable(this.options?.readOnly === true, 'WorkOrderRepositoryAdapter');
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const existing = this.inMemoryRecords.get(record.id);
      if (existing !== undefined && existing.revision >= record.revision) {
        throw new Error(
          `Stale work order revision for ${record.id}: expected > ${existing.revision}, got ${record.revision}`,
        );
      }
      this.inMemoryRecords.set(record.id, record);
      this.signal({ kind: 'work-order', id: record.id, stateFile: null, before: null, written: null });
      return;
    }

    const target = path.join(stateDir, 'work-orders.json');
    const lockPath = path.join(stateDir, 'work-orders.json.lock');

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    await withFileLock(lockPath, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(record.id);
      if (existing !== undefined && existing.revision >= record.revision) {
        throw new Error(
          `Stale work order revision for ${record.id}: expected > ${existing.revision}, got ${record.revision}`,
        );
      }
      records.set(record.id, record);
      await writeJsonAtomically(target, [...records.values()]);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    this.signal({
      kind: 'work-order',
      id: record.id,
      stateFile: path.resolve(target),
      before,
      written,
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
    const inspection = inspectRecordListBytes(buffer, parseWorkOrderStateRecord);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    for (const item of inspection.records) {
      map.set(item.id, item);
    }
    return map;
  }
}
