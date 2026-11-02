// @generated adapter stub — edit freely
/**
 * DaemonLeaseAdapter implements DaemonLeasePort: one lease file per scope under
 * `<stateDir>/daemon/leases/<scope>.json` (scopes carry at most one `/`, so a
 * file nests one directory deep). Records are version 1 daemon leases; the pure
 * decisions own the fence, which never goes back, and the adapter never writes
 * a fence value itself. Every mutation runs under the file's shared lock and
 * writes the single record with an atomic temp+rename; an unreadable file is
 * quarantined exactly like the driver lease store, and an acquire/renew/release
 * against one refuses without echoing the stored bytes.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { LaneRunLeaseRecord } from '../../domain/lane-run-records.js';
import type {
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../../domain/lane-run-lease.js';
import {
  checkLeaseHeld,
  decideLeaseAcquire,
  decideLeaseRelease,
  decideLeaseRenew,
} from '../../domain/lane-run-lease.js';
import {
  DAEMON_RECORD_VERSION,
  readDaemonLeaseRecord,
  type DaemonLeaseRecord,
} from '../../domain/daemon-tick.js';
import type {
  DaemonLeasePort,
  DaemonLeaseResult,
} from '../../application/ports/out/DaemonLeasePort.out-port.js';
import {
  StateFileUnknownVersionError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  assertStoreWritable,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface DaemonLeaseAdapterOptions {
  /** When set, leases persist under `<stateDir>/daemon/leases` and reload on use. */
  readonly stateDir?: string;
  /** Read-only mode: reads never quarantine, and every mutation is refused. */
  readonly readOnly?: boolean;
}

const SAFE_SCOPE_COMPONENT = /^[A-Za-z0-9._-]{1,128}$/;

function isSafeScopeComponent(component: string): boolean {
  return (
    component.length > 0 &&
    component !== '.' &&
    component !== '..' &&
    SAFE_SCOPE_COMPONENT.test(component)
  );
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

export class DaemonLeaseAdapter implements DaemonLeasePort {
  private readonly inMemoryLeases = new Map<string, DaemonLeaseRecord>();

  constructor(private readonly options: DaemonLeaseAdapterOptions = {}) {}

  acquire(request: LeaseAcquireRequest & { scope: string }): Promise<DaemonLeaseResult> {
    const { scope, ...leaseRequest } = request;
    return this.mutate(scope, (current) => {
      const decision = decideLeaseAcquire(withoutVersion(current), leaseRequest);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason };
      }
      const candidate = withVersion(decision.lease, scope);
      if (!readDaemonLeaseRecord(candidate).ok) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      return { outcome: 'ok', lease: candidate };
    });
  }

  renew(request: LeaseRenewRequest & { scope: string }): Promise<DaemonLeaseResult> {
    const { scope, ...leaseRequest } = request;
    return this.mutate(scope, (current) => {
      const decision = decideLeaseRenew(withoutVersion(current), leaseRequest);
      return decision.ok
        ? { outcome: 'ok', lease: withVersion(decision.lease, scope) }
        : { outcome: 'refused', reason: decision.reason };
    });
  }

  release(request: LeaseHoldRequest & { scope: string }): Promise<DaemonLeaseResult> {
    const { scope, ...leaseRequest } = request;
    return this.mutate(scope, (current) => {
      const decision = decideLeaseRelease(withoutVersion(current), leaseRequest);
      return decision.ok
        ? { outcome: 'ok', lease: withVersion(decision.lease, scope) }
        : { outcome: 'refused', reason: decision.reason };
    });
  }

  async check(request: LeaseHoldRequest & { scope: string }): Promise<LeaseRefusal | null> {
    const { scope, ...leaseRequest } = request;
    const current = await this.read(scope);
    return checkLeaseHeld(withoutVersion(current), leaseRequest);
  }

  async read(scope: string): Promise<DaemonLeaseRecord | null> {
    const target = this.targetFor(scope);
    if (target === null) {
      const current = this.inMemoryLeases.get(scope);
      return current === undefined ? null : { ...current };
    }
    try {
      return await this.readRecord(target, scope);
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

  /**
   * Run one mutation under the store's guard. `decide` reads the current lease
   * and returns either a saved lease (written) or a refusal (nothing written).
   * An unreadable lease file refuses the mutation without echoing its bytes.
   */
  private async mutate(
    scope: string,
    decide: (current: DaemonLeaseRecord | null) => DaemonLeaseResult,
  ): Promise<DaemonLeaseResult> {
    assertStoreWritable(this.options?.readOnly === true, 'DaemonLeaseAdapter');
    const target = this.targetFor(scope);
    if (target === null) {
      const current = this.inMemoryLeases.get(scope) ?? null;
      const result = decide(current);
      if (result.outcome === 'ok') {
        this.inMemoryLeases.set(scope, result.lease);
      }
      return result;
    }
    return withFileLock(`${target}.lock`, async () => {
      let current: DaemonLeaseRecord | null;
      try {
        current = await this.readRecord(target, scope);
      } catch (error: unknown) {
        if (
          error instanceof StateFileUnreadableError ||
          error instanceof StateFileUnreadableReadOnlyError
        ) {
          return { outcome: 'refused', reason: 'lease-unreadable' };
        }
        throw error;
      }
      const result = decide(current);
      if (result.outcome === 'ok') {
        await writeJsonAtomically(target, result.lease);
      }
      return result;
    });
  }

  private targetFor(scope: string): string | null {
    const { stateDir } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    if (scope.trim().length === 0) {
      throw new Error('DaemonLeaseAdapter refuses an empty lease scope');
    }
    const components = scope.split('/');
    if (components.length > 2) {
      throw new Error('DaemonLeaseAdapter refuses an unsafe lease scope');
    }
    for (const component of components) {
      if (!isSafeScopeComponent(component)) {
        throw new Error('DaemonLeaseAdapter refuses an unsafe lease scope');
      }
    }
    return join(stateDir, 'daemon', 'leases', ...components) + '.json';
  }

  private async readRecord(target: string, expectedScope: string): Promise<DaemonLeaseRecord | null> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (isENOENT(error)) {
        return null;
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString('utf8'));
    } catch {
      return rejectUnreadableStateFile(target, 'not valid JSON', buffer, this.options?.readOnly === true);
    }
    const read = readDaemonLeaseRecord(raw);
    if (!read.ok) {
      if (read.reason === 'unknown-version') {
        throw new StateFileUnknownVersionError(target, 0);
      }
      return rejectUnreadableStateFile(target, read.error, buffer, this.options?.readOnly === true);
    }
    if (read.record.scope !== expectedScope) {
      return rejectUnreadableStateFile(
        target,
        'DaemonLease record scope does not match file path',
        buffer,
        this.options?.readOnly === true,
      );
    }
    return read.record;
  }
}

/** The decision functions take the run-lease shape without the record's version or scope. */
function withoutVersion(lease: DaemonLeaseRecord | null): LaneRunLeaseRecord | null {
  if (lease === null) {
    return null;
  }
  return { holderId: lease.holderId, fence: lease.fence, leaseUntilIso: lease.leaseUntilIso };
}

/** The stored record wraps a decision's lease in version 1 and the scope. */
function withVersion(lease: LaneRunLeaseRecord, scope: string): DaemonLeaseRecord {
  return { version: DAEMON_RECORD_VERSION, scope, ...lease };
}
