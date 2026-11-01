// @generated adapter scaffold — refined for lane K3-2.
/**
 * LaneRunRepositoryAdapter implements LaneRunRepositoryPort over a local JSON
 * store: an in-process map keyed by run id that optionally persists to
 * `<stateDir>/lane-runs.json` under an exclusive lock with an atomic rename,
 * the exact bytes quarantined when the file is unreadable. It never shares
 * another store's file.
 *
 * Two design rules shared by the K3 lanes:
 * 1. A lease change never moves the run's revision. `revision` is the CAS
 *    revision of the run's content, and a web stop or resume carries it
 *    (§3.8); if every renewal bumped it, a heartbeat every poll would refuse
 *    every web request as stale. The lease is guarded by its own fence under
 *    the store's lock instead.
 * 2. The fence never goes back. Acquiring a lease raises the fence by one;
 *    renewing keeps it; releasing keeps holder and fence and sets
 *    `leaseUntilIso` to the release time. A lease is never set back to
 *    `null` once taken, so a holder that lost its lease can never match a
 *    later lease by fence.
 *
 * A save is accepted only when both hold under the store's guard: the record
 * is at the stored revision + 1 (CAS), and the caller holds the stored run
 * lease (holder and fence match, not expired at the caller's nowIso). It
 * never changes the lease, the run's identity or its earlier attempts.
 * Lease operations apply K3-1's decisions to the stored record's lease and
 * never move `revision`. There is no change signal in this lane. With
 * `readOnly` the store never writes: an unreadable file is a read error with
 * no quarantine copy, and every create, save and lease write is refused.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_SCHEMA_VERSION } from '../../domain/lane-run-records.js';
import { LaneRun } from '../../domain/entities/LaneRun.js';
import type {
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRenewRequest,
} from '../../domain/lane-run-lease.js';
import {
  checkLeaseHeld,
  decideLeaseAcquire,
  decideLeaseRelease,
  decideLeaseRenew,
} from '../../domain/lane-run-lease.js';
import type {
  LaneRunRepositoryPort,
  LaneRunRepositoryResult,
} from '../../application/ports/out/LaneRunRepositoryPort.out-port.js';
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

/** The schema-version policy of `lane-runs.json` (Q5a, D6). */
export const LANE_RUN_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('lane-runs.json', {
  writerVersion: LANE_RUN_SCHEMA_VERSION,
  acceptedVersions: [1],
});

export interface LaneRunRepositoryAdapterOptions {
  /** When set, runs persist here and reload on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /**
   * Read-only (telemetry plan §3.3): an unreadable file is a read error with no quarantine copy
   * (`StateFileUnreadableReadOnlyError`), and every write throws `ReadOnlyStateStoreError`.
   */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'lane-runs.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'run-journal.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Fresh copies: nested objects are copied so callers cannot mutate the store. */
function copy(record: LaneRunRecord): LaneRunRecord {
  return {
    version: record.version,
    runId: record.runId,
    workOrderId: record.workOrderId,
    tier: record.tier,
    seatPlanRef: record.seatPlanRef,
    cursors: { ...record.cursors },
    round: record.round,
    attemptIds: [...record.attemptIds],
    prNumber: record.prNumber,
    parked: record.parked === null ? null : { ...record.parked },
    parkCount: record.parkCount,
    lease: record.lease === null ? null : { ...record.lease },
    revision: record.revision,
    runPolicyRevision: record.runPolicyRevision,
    ...(record.branchName === undefined ? {} : { branchName: record.branchName }),
    ...(record.baseBranch === undefined ? {} : { baseBranch: record.baseBranch }),
    schemaVersion: LANE_RUN_STORE_VERSION_POLICY.writerVersion,
  };
}

/** True when two leases are identical in holder, fence and time. */
function leasesEqual(left: LaneRunRecord['lease'], right: LaneRunRecord['lease']): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.holderId === right.holderId &&
    left.fence === right.fence &&
    left.leaseUntilIso === right.leaseUntilIso
  );
}

/** True when `prefix` is a prefix (possibly equal) of `list`. */
function isPrefix(prefix: readonly string[], list: readonly string[]): boolean {
  if (prefix.length > list.length) {
    return false;
  }
  return prefix.every((value, index) => value === list[index]);
}

/** A save may not move the run's identity or drop any earlier attempt. */
function identityChanged(stored: LaneRunRecord, candidate: LaneRunRecord): boolean {
  return (
    stored.workOrderId !== candidate.workOrderId ||
    stored.tier !== candidate.tier ||
    stored.seatPlanRef !== candidate.seatPlanRef ||
    stored.runPolicyRevision !== candidate.runPolicyRevision ||
    stored.branchName !== candidate.branchName ||
    stored.baseBranch !== candidate.baseBranch ||
    !isPrefix(stored.attemptIds, candidate.attemptIds)
  );
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the full `LaneRun.create`
 * body validation. Never throws: a version failure or malformed entry is a
 * fixed status, and the exact bytes are quarantined (or refused) by the
 * store reader.
 */
export function parseVersionedLaneRunStateRecord(raw: unknown): VersionedRecordParseResult<LaneRunRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, LANE_RUN_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  try {
    const result = LaneRun.create(raw);
    if (!result.success) {
      return { status: 'invalid' };
    }
    return { status: 'ok', record: copy(result.value.toRecord()), schemaVersion: versionCheck.schemaVersion };
  } catch {
    return { status: 'invalid' };
  }
}

/** The reader's record parser, shared with `fleet-v2 state check`. Never throws. */
export function parseLaneRunStateRecord(raw: unknown): LaneRunRecord | undefined {
  const parsed = parseVersionedLaneRunStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

export class LaneRunRepositoryAdapter implements LaneRunRepositoryPort {
  private readonly inMemoryRuns = new Map<string, LaneRunRecord>();

  constructor(private readonly options: LaneRunRepositoryAdapterOptions = {}) {}

  async create(record: LaneRunRecord): Promise<LaneRunRepositoryResult> {
    const validatedResult = LaneRun.create(record);
    if (!validatedResult.success) {
      return { outcome: 'refused', reason: 'invalid-record' };
    }
    const validated = validatedResult.value.toRecord();
    if (validated.revision !== 1 || validated.lease !== null) {
      return { outcome: 'refused', reason: 'invalid-record' };
    }
    return this.mutate(validated.runId, (stored) => {
      if (stored !== undefined) {
        return { outcome: 'refused', reason: 'run-exists' };
      }
      return { outcome: 'saved', record: validated };
    });
  }

  async save(record: LaneRunRecord, guard: LeaseHoldRequest): Promise<LaneRunRepositoryResult> {
    const validatedResult = LaneRun.create(record);
    if (!validatedResult.success) {
      return { outcome: 'refused', reason: 'invalid-record' };
    }
    const validated = validatedResult.value.toRecord();
    return this.mutate(validated.runId, (stored) => {
      if (stored === undefined) {
        return { outcome: 'refused', reason: 'run-not-found' };
      }
      if (validated.revision !== stored.revision + 1) {
        return { outcome: 'refused', reason: 'stale-revision' };
      }
      const heldReason = checkLeaseHeld(stored.lease, guard);
      if (heldReason !== null) {
        return { outcome: 'refused', reason: heldReason };
      }
      if (!leasesEqual(validated.lease, stored.lease)) {
        return { outcome: 'refused', reason: 'lease-changed' };
      }
      if (identityChanged(stored, validated)) {
        return { outcome: 'refused', reason: 'identity-changed' };
      }
      return { outcome: 'saved', record: validated };
    });
  }

  async get(runId: string): Promise<LaneRunRecord | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemoryRuns.get(runId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = records.get(runId);
    return found === undefined ? null : copy(found);
  }

  async list(): Promise<readonly LaneRunRecord[]> {
    const target = this.statePath;
    const records =
      target === null ? this.inMemoryRuns : await this.readRecordsFromDisk(target);
    return [...records.values()]
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map(copy);
  }

  async acquireLease(runId: string, request: LeaseAcquireRequest): Promise<LaneRunRepositoryResult> {
    return this.mutate(runId, (stored) => {
      if (stored === undefined) {
        return { outcome: 'refused', reason: 'run-not-found' };
      }
      const decision = decideLeaseAcquire(stored.lease, request);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason };
      }
      return { outcome: 'saved', record: { ...stored, lease: decision.lease } };
    });
  }

  async renewLease(runId: string, request: LeaseRenewRequest): Promise<LaneRunRepositoryResult> {
    return this.mutate(runId, (stored) => {
      if (stored === undefined) {
        return { outcome: 'refused', reason: 'run-not-found' };
      }
      const decision = decideLeaseRenew(stored.lease, request);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason };
      }
      return { outcome: 'saved', record: { ...stored, lease: decision.lease } };
    });
  }

  async releaseLease(runId: string, request: LeaseHoldRequest): Promise<LaneRunRepositoryResult> {
    return this.mutate(runId, (stored) => {
      if (stored === undefined) {
        return { outcome: 'refused', reason: 'run-not-found' };
      }
      const decision = decideLeaseRelease(stored.lease, request);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason };
      }
      return { outcome: 'saved', record: { ...stored, lease: decision.lease } };
    });
  }

  /**
   * Run one write under the store's guard. `decide` reads the stored run and
   * returns either a saved record (written) or a refusal (nothing written).
   */
  private async mutate(
    runId: string,
    decide: (stored: LaneRunRecord | undefined) => LaneRunRepositoryResult,
  ): Promise<LaneRunRepositoryResult> {
    assertStoreWritable(this.options.readOnly === true, 'LaneRunRepositoryAdapter');
    const target = this.statePath;
    if (target === null) {
      const stored = this.inMemoryRuns.get(runId);
      const result = decide(stored);
      if (result.outcome === 'saved') {
        const saved = copy(result.record);
        this.inMemoryRuns.set(runId, saved);
        return { outcome: 'saved', record: copy(saved) };
      }
      return result;
    }
    return withFileLock(`${target}.lock`, async () => {
      const records = await this.readRecordsFromDisk(target);
      const stored = records.get(runId);
      const result = decide(stored);
      if (result.outcome === 'saved') {
        const saved = copy(result.record);
        records.set(runId, saved);
        const list = [...records.values()]
          .sort((left, right) => left.runId.localeCompare(right.runId))
          .map(copy);
        await writeJsonAtomically(target, list);
        return { outcome: 'saved', record: copy(saved) };
      }
      return result;
    });
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error(
        'LaneRunRepositoryAdapter refuses a fileName that collides with another store',
      );
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('LaneRunRepositoryAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(target: string): Promise<Map<string, LaneRunRecord>> {
    const records = new Map<string, LaneRunRecord>();
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return records;
      }
      throw error;
    }
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedLaneRunStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options.readOnly === true);
    }
    for (const item of inspection.records) {
      records.set(item.runId, item);
    }
    return records;
  }
}
