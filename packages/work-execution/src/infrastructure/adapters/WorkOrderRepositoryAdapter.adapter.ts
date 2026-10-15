// @generated adapter scaffold — implemented for migration step 2 (local transactional store).
/**
 * WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort
 * (local-transactional-store). Records live in an in-memory map by default;
 * when `stateDir` is configured each mutation is persisted as JSON via an
 * atomic temp-file-then-rename write. Optimistic concurrency refuses stale
 * revisions instead of silently overwriting newer state.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import type { WorkOrderRepositoryPort } from '../../application/ports/out/WorkOrderRepositoryPort.out-port.js';

export interface WorkOrderRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

let workOrderTempCounter = 0;

function isWorkOrderRecord(value: unknown): value is WorkOrderRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number';
}

export class WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort {
  private readonly records = new Map<string, WorkOrderRecord>();
  private loadPromise: Promise<void> | null = null;
  private persistCounter = 0;

  constructor(private readonly options?: WorkOrderRepositoryAdapterOptions) {}

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    await this.ensureLoaded();
    const existing = this.records.get(record.id);
    if (existing !== undefined && existing.revision >= record.revision) {
      throw new Error(
        `Stale work order revision for ${record.id}: expected > ${existing.revision}, got ${record.revision}`,
      );
    }
    this.records.set(record.id, record);
    await this.persist();
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    await this.ensureLoaded();
    return this.records.get(workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
    await this.ensureLoaded();
    const records = [...this.records.values()];
    if (projectId === undefined) return records;
    return records.filter((record) => record.projectId === projectId);
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
      raw = await fs.readFile(path.join(stateDir, 'work-orders.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (isWorkOrderRecord(item)) this.records.set(item.id, item);
    }
  }

  private async persist(): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) return;
    const target = path.join(stateDir, 'work-orders.json');
    const temp = `${target}.${process.pid}-${this.persistCounter++}-${workOrderTempCounter++}.tmp`;
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
