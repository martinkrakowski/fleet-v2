// @generated adapter scaffold — implemented for lane WB4a (local transactional store).
/**
 * LanePlanRepositoryAdapter implements LanePlanRepositoryPort
 * (local-transactional-store). Records live in an in-memory map by default;
 * when `stateDir` is configured each mutation is persisted as JSON via an
 * atomic temp-file-then-rename write under an exclusive lock. Every save is
 * a compare-and-swap on `revision`: a stored revision >= the incoming one
 * throws (fixed message, ids only). Stored records carry `schemaVersion: 1`
 * (Q5a/D6); reads validate through `readStoreRecordSchemaVersion` and strip
 * the key before `LanePlan.create`, which refuses extra fields. An invalid
 * or unknown-version entry is a read error (fail closed), never silence,
 * never quarantine-on-read. With `readOnly` the store never writes: an
 * unreadable file is a read error with no quarantine copy, and every save
 * is refused.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LanePlanRecord } from '../../domain/lane-plan-records.js';
import { LANE_PLAN_RECORD_VERSION } from '../../domain/lane-plan-records.js';
import { LanePlan } from '../../domain/entities/LanePlan.js';
import type { LanePlanRepositoryPort } from '../../application/ports/out/LanePlanRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import {
  assertStoreWritable,
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  rejectUnreadableStateFile,
  StateFileUnknownVersionError,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

/** The schema-version policy of `lane-plans.json` (Q5a, D6). */
export const LANE_PLAN_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('lane-plans.json', {
  writerVersion: LANE_PLAN_RECORD_VERSION,
  acceptedVersions: [1],
});

export interface LanePlanRepositoryAdapterOptions {
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

/** The stored record without its `schemaVersion` key (LanePlan.create refuses extra fields). */
function withoutSchemaVersion(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || key === 'schemaVersion') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && descriptor.enumerable && 'value' in descriptor) {
      out[key] = descriptor.value;
    }
  }
  return out;
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the full `LanePlan.create`
 * body validation on the stripped record. Never throws.
 */
export function parseVersionedLanePlanStateRecord(raw: unknown): VersionedRecordParseResult<LanePlanRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, LANE_PLAN_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  const result = LanePlan.create(withoutSchemaVersion(raw as Record<string, unknown>));
  if (!result.success) {
    return { status: 'invalid' };
  }
  return { status: 'ok', record: result.value.toRecord(), schemaVersion: versionCheck.schemaVersion };
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseLanePlanStateRecord(raw: unknown): LanePlanRecord | undefined {
  const parsed = parseVersionedLanePlanStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

export class LanePlanRepositoryAdapter implements LanePlanRepositoryPort {
  private readonly inMemoryRecords = new Map<string, LanePlanRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options?: LanePlanRepositoryAdapterOptions) {
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

  async saveLanePlan(record: LanePlanRecord): Promise<void> {
    assertStoreWritable(this.options?.readOnly === true, 'LanePlanRepositoryAdapter');
    const stateDir = this.options?.stateDir;
    const key = `${record.projectId}/${record.planId}`;
    const throwStale = (existing: LanePlanRecord): never => {
      throw new Error(
        `Stale lane plan revision for ${key}: expected > ${existing.revision}, got ${record.revision}`,
      );
    };
    if (stateDir === undefined) {
      const existing = this.inMemoryRecords.get(key);
      if (existing !== undefined && existing.revision >= record.revision) {
        throwStale(existing);
      }
      this.inMemoryRecords.set(key, record);
      this.signal({ kind: 'plan', id: key, stateFile: null, before: null, written: null });
      return;
    }

    const target = path.join(stateDir, 'lane-plans.json');
    const lockPath = path.join(stateDir, 'lane-plans.json.lock');

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
      const existing = records.get(key);
      if (existing !== undefined && existing.revision >= record.revision) {
        throwStale(existing);
      }
      records.set(
        key,
        { ...record, schemaVersion: LANE_PLAN_STORE_VERSION_POLICY.writerVersion } as LanePlanRecord,
      );
      await writeJsonAtomically(target, [...records.values()]);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    this.signal({
      kind: 'plan',
      id: key,
      stateFile: path.resolve(target),
      before,
      written,
    });
  }

  async findLanePlan(projectId: string, planId: string): Promise<LanePlanRecord | null> {
    const stateDir = this.options?.stateDir;
    const key = `${projectId}/${planId}`;
    if (stateDir === undefined) {
      return this.inMemoryRecords.get(key) ?? null;
    }
    const target = path.join(stateDir, 'lane-plans.json');
    const records = await this.readRecordsFromDisk(target);
    return records.get(key) ?? null;
  }

  async listLanePlans(projectId?: string): Promise<readonly LanePlanRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const records = [...this.inMemoryRecords.values()];
      if (projectId === undefined) {
        return records;
      }
      return records.filter((record) => record.projectId === projectId);
    }
    const target = path.join(stateDir, 'lane-plans.json');
    const records = await this.readRecordsFromDisk(target);
    const list = [...records.values()];
    if (projectId === undefined) {
      return list;
    }
    return list.filter((record) => record.projectId === projectId);
  }

  private async readRecordsFromDisk(target: string): Promise<Map<string, LanePlanRecord>> {
    const map = new Map<string, LanePlanRecord>();
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
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedLanePlanStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    for (const item of inspection.records) {
      map.set(`${item.projectId}/${item.planId}`, item);
    }
    return map;
  }
}
