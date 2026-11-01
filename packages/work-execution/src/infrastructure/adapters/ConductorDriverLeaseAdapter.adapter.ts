// @generated adapter scaffold — refined for lane K3-3.
/**
 * ConductorDriverLeaseAdapter implements ConductorDriverLeasePort over the one
 * driver lease of a state directory (plan §3.6, §7): an in-process record
 * that optionally persists to `<stateDir>/conductor-driver-lease.json` under
 * the shared exclusive lock with an atomic rename, the exact bytes quarantined
 * when the file is unreadable. It never shares another store's file.
 *
 * Two design rules shared by the K3 lanes:
 * 1. A lease change never moves the run's `revision`. `revision` is the CAS
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
 * The adapter always writes exactly one record; a reader takes the record with
 * the highest fence (the last of equal fences), so any list of valid records
 * reads the same way in `state check` and in the store. The file joins
 * `fleet-v2 state check` and `state restore`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { LaneRunLeaseRecord } from '../../domain/lane-run-records.js';
import type {
  ConductorDriverLeaseRecord,
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../../domain/lane-run-lease.js';
import {
  CONDUCTOR_DRIVER_LEASE_RECORD_VERSION,
  checkLeaseHeld,
  decideLeaseAcquire,
  decideLeaseRelease,
  decideLeaseRenew,
  readConductorDriverLease,
} from '../../domain/lane-run-lease.js';
import type {
  ConductorDriverLeasePort,
  ConductorDriverLeaseResult,
} from '../../application/ports/out/ConductorDriverLeasePort.out-port.js';
import {
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  assertStoreWritable,
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface ConductorDriverLeaseAdapterOptions {
  /** When set, the lease persists here and reloads on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Read-only mode: an unreadable marker reads as `null` without quarantining or writing. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'conductor-driver-lease.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'run-journal.json',
  'lane-runs.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseConductorDriverLeaseStateRecord(raw: unknown): ConductorDriverLeaseRecord | undefined {
  try {
    const result = readConductorDriverLease(raw);
    if (!result.ok) {
      return undefined;
    }
    return result.record;
  } catch {
    return undefined;
  }
}

/** The decision functions take K1-1's lease shape without the record's version. */
function withoutVersion(lease: ConductorDriverLeaseRecord | null): LaneRunLeaseRecord | null {
  if (lease === null) {
    return null;
  }
  return { holderId: lease.holderId, fence: lease.fence, leaseUntilIso: lease.leaseUntilIso };
}

/** The stored record wraps a decision's lease in version 1. */
function withVersion(lease: LaneRunLeaseRecord): ConductorDriverLeaseRecord {
  return { version: CONDUCTOR_DRIVER_LEASE_RECORD_VERSION, ...lease };
}

/**
 * The current lease of a list: the record with the highest fence, the last of
 * equal fences; an empty list is none.
 */
function currentLeaseOf(records: readonly ConductorDriverLeaseRecord[]): ConductorDriverLeaseRecord | null {
  let current: ConductorDriverLeaseRecord | null = null;
  for (const record of records) {
    if (current === null || record.fence >= current.fence) {
      current = record;
    }
  }
  return current;
}

export class ConductorDriverLeaseAdapter implements ConductorDriverLeasePort {
  private inMemoryLease: ConductorDriverLeaseRecord | null = null;

  constructor(private readonly options: ConductorDriverLeaseAdapterOptions = {}) {}

  async read(): Promise<ConductorDriverLeaseRecord | null> {
    const target = this.statePath;
    if (target === null) {
      const current = this.inMemoryLease;
      return current === null ? null : { ...current };
    }
    try {
      const current = currentLeaseOf(await this.readRecordsFromDisk(target));
      return current === null ? null : { ...current };
    } catch (error: unknown) {
      if (
        this.options?.readOnly === true &&
        (error instanceof StateFileUnreadableError ||
          error instanceof StateFileUnreadableReadOnlyError)
      ) {
        return null;
      }
      throw error;
    }
  }

  acquire(request: LeaseAcquireRequest): Promise<ConductorDriverLeaseResult> {
    return this.mutate((current) => {
      const decision = decideLeaseAcquire(withoutVersion(current), request);
      return decision.ok
        ? { outcome: 'ok', lease: withVersion(decision.lease) }
        : { outcome: 'refused', reason: decision.reason };
    });
  }

  renew(request: LeaseRenewRequest): Promise<ConductorDriverLeaseResult> {
    return this.mutate((current) => {
      const decision = decideLeaseRenew(withoutVersion(current), request);
      return decision.ok
        ? { outcome: 'ok', lease: withVersion(decision.lease) }
        : { outcome: 'refused', reason: decision.reason };
    });
  }

  release(request: LeaseHoldRequest): Promise<ConductorDriverLeaseResult> {
    return this.mutate((current) => {
      const decision = decideLeaseRelease(withoutVersion(current), request);
      return decision.ok
        ? { outcome: 'ok', lease: withVersion(decision.lease) }
        : { outcome: 'refused', reason: decision.reason };
    });
  }

  async check(request: LeaseHoldRequest): Promise<LeaseRefusal | null> {
    return checkLeaseHeld(withoutVersion(await this.read()), request);
  }

  /**
   * Run one write under the store's guard. `decide` reads the current lease
   * and returns either a saved lease (written) or a refusal (nothing written).
   */
  private async mutate(
    decide: (current: ConductorDriverLeaseRecord | null) => ConductorDriverLeaseResult,
  ): Promise<ConductorDriverLeaseResult> {
    assertStoreWritable(this.options?.readOnly === true, 'ConductorDriverLeaseAdapter');
    const target = this.statePath;
    if (target === null) {
      const result = decide(this.inMemoryLease);
      if (result.outcome === 'ok') {
        this.inMemoryLease = result.lease;
      }
      return result;
    }
    return withFileLock(`${target}.lock`, async () => {
      const current = currentLeaseOf(await this.readRecordsFromDisk(target));
      const result = decide(current);
      if (result.outcome === 'ok') {
        await writeJsonAtomically(target, [result.lease]);
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
        'ConductorDriverLeaseAdapter refuses a fileName that collides with another store',
      );
    }
    if (!SAFE_FILE_NAME.test(name) || name === "." || name === "..") {
      throw new Error('ConductorDriverLeaseAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(target: string): Promise<readonly ConductorDriverLeaseRecord[]> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const inspection = inspectRecordListBytes(buffer, parseConductorDriverLeaseStateRecord);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    return inspection.records;
  }
}
