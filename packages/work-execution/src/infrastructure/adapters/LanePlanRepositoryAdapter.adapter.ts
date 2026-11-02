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

import type { LanePlanRecord, PlannedLaneRef } from '../../domain/lane-plan-records.js';
import { LANE_PLAN_RECORD_VERSION } from '../../domain/lane-plan-records.js';
import { LanePlan } from '../../domain/entities/LanePlan.js';
import { findLanePlanCycle, type LanePlanGraphPlan } from '../../domain/lane-plan-graph.js';
import type {
  LanePlanRepositoryPort,
  SaveLanePlanResult,
} from '../../application/ports/out/LanePlanRepositoryPort.out-port.js';
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

/** The graph plan of a stored record: stored lanes carry their aliases. */
function lanePlanGraphPlanFromRecord(record: LanePlanRecord): LanePlanGraphPlan {
  return {
    projectId: record.projectId,
    planId: record.planId,
    lanes: record.lanes.map((lane) => ({
      laneId: lane.laneId,
      aliases: lane.aliases,
      after: lane.after,
    })),
    exclusiveOrder: record.exclusiveOrder,
  };
}

function findCycleAcrossPlans(
  records: Iterable<LanePlanRecord>,
  candidate: LanePlanRecord,
): readonly PlannedLaneRef[] | null {
  const plans: LanePlanGraphPlan[] = [];
  for (const storedPlan of records) {
    if (storedPlan.projectId === candidate.projectId && storedPlan.planId === candidate.planId) {
      continue;
    }
    plans.push(lanePlanGraphPlanFromRecord(storedPlan));
  }
  plans.push(lanePlanGraphPlanFromRecord(candidate));
  return findLanePlanCycle(plans);
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

  private throwStaleRevision(key: string, existingRevision: number, newRevision: number): never {
    throw new Error(
      `Stale lane plan revision for ${key}: expected > ${existingRevision}, got ${newRevision}`,
    );
  }

  private async safeStat(target: string): Promise<ChangeSignal['before']> {
    try {
      const stat = await fs.stat(target);
      return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch {
      return null;
    }
  }

  async saveLanePlan(record: LanePlanRecord): Promise<void> {
    const result = await this.saveLanePlanIfAcyclic(record);
    if (result.outcome === 'cycle') {
      throw new Error(`Lane plan cycle detected for ${record.projectId}/${record.planId}`);
    }
  }

  async saveLanePlanIfAcyclic(record: LanePlanRecord): Promise<SaveLanePlanResult> {
    assertStoreWritable(this.options?.readOnly === true, 'LanePlanRepositoryAdapter');
    const key = `${record.projectId}/${record.planId}`;
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.saveInMemoryIfAcyclic(record, key);
    }
    return this.saveFileIfAcyclic(record, key, stateDir);
  }

  private saveInMemoryIfAcyclic(record: LanePlanRecord, key: string): SaveLanePlanResult {
    const existing = this.inMemoryRecords.get(key);
    if (existing !== undefined && existing.revision >= record.revision) {
      this.throwStaleRevision(key, existing.revision, record.revision);
    }
    const cycle = findCycleAcrossPlans(this.inMemoryRecords.values(), record);
    if (cycle !== null) {
      return { outcome: 'cycle', cycle };
    }
    this.inMemoryRecords.set(key, record);
    this.signal({ kind: 'plan', id: key, stateFile: null, before: null, written: null });
    return { outcome: 'saved' };
  }

  private async saveFileIfAcyclic(
    record: LanePlanRecord,
    key: string,
    stateDir: string,
  ): Promise<SaveLanePlanResult> {
    const target = path.join(stateDir, 'lane-plans.json');
    const lockPath = path.join(stateDir, 'lane-plans.json.lock');

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;
    let cycleResult: readonly PlannedLaneRef[] | null = null;

    await withFileLock(lockPath, async () => {
      before = await this.safeStat(target);
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(key);
      if (existing !== undefined && existing.revision >= record.revision) {
        this.throwStaleRevision(key, existing.revision, record.revision);
      }
      const cycle = findCycleAcrossPlans(records.values(), record);
      if (cycle !== null) {
        cycleResult = cycle;
        return;
      }
      records.set(key, record);
      const payload = [...records.values()].map((r) => ({
        ...r,
        schemaVersion: LANE_PLAN_STORE_VERSION_POLICY.writerVersion,
      }));
      await writeJsonAtomically(target, payload);
      written = await this.safeStat(target);
    });

    if (cycleResult !== null) {
      return { outcome: 'cycle', cycle: cycleResult };
    }

    this.signal({
      kind: 'plan',
      id: key,
      stateFile: path.resolve(target),
      before,
      written,
    });
    return { outcome: 'saved' };
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
