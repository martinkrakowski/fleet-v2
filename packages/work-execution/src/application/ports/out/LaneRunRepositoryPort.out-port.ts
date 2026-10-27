// @generated outbound contract scaffold — refined for lane K3-2.
/**
 * LaneRunRepositoryPort persists lane runs (plan §3.2, §3.6). Writes are
 * accepted only under the store's guard: a save lands only at the stored
 * revision plus one (CAS) and only from the current, unexpired run-lease
 * holder with its fence, so two drivers can never both act on one run
 * (§3.6 "Leases"). A lease change never moves the revision (§3.8: a web stop
 * or resume carries the run's expectedRevision); the lease is guarded by its
 * own fence instead. Every write returns a typed result, and a refusal writes
 * nothing.
 */

import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type {
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../../../domain/lane-run-lease.js';

export type LaneRunRepositoryRefusal =
  | 'invalid-record' | 'run-exists' | 'run-not-found' | 'stale-revision' | 'lease-changed'
  | 'identity-changed' | LeaseRefusal;

export type LaneRunRepositoryResult =
  | { readonly outcome: 'saved'; readonly record: LaneRunRecord }
  | { readonly outcome: 'refused'; readonly reason: LaneRunRepositoryRefusal };

export interface LaneRunRepositoryPort {
  /** A new run: revision 1, lease null; an existing run id → run-exists. */
  create(record: LaneRunRecord): Promise<LaneRunRepositoryResult>;
  /** CAS save by the current run-lease holder; see the rules in the adapter. */
  save(record: LaneRunRecord, guard: LeaseHoldRequest): Promise<LaneRunRepositoryResult>;
  /** Known absence is null; a malformed run id is null. */
  get(runId: string): Promise<LaneRunRecord | null>;
  /** Every run, sorted by runId (a ULID, so creation order). */
  list(): Promise<readonly LaneRunRecord[]>;
  acquireLease(runId: string, request: LeaseAcquireRequest): Promise<LaneRunRepositoryResult>;
  renewLease(runId: string, request: LeaseRenewRequest): Promise<LaneRunRepositoryResult>;
  releaseLease(runId: string, request: LeaseHoldRequest): Promise<LaneRunRepositoryResult>;
}
