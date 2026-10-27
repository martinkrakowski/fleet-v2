// @generated outbound contract scaffold — refined for lane K3-3.
/**
 * ConductorDriverLeasePort holds the one conductor driver lease of a state
 * directory (plan §3.6, §7). Acquire is by CAS on the fence over a null or
 * lapsed lease, renew and release are by its holder with its fence, check and
 * read never write. The lease is guarded by its own fence under the store's
 * lock, and the fence never goes back: acquiring raises it by one, renewing
 * keeps it, releasing keeps holder and fence and ends the lease at the release
 * time.
 */

import type {
  ConductorDriverLeaseRecord,
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../../../domain/lane-run-lease.js';

export type ConductorDriverLeaseResult =
  | { readonly outcome: 'ok'; readonly lease: ConductorDriverLeaseRecord }
  | { readonly outcome: 'refused'; readonly reason: LeaseRefusal };

export interface ConductorDriverLeasePort {
  /** The current driver lease, lapsed or not; null when none was ever taken. */
  read(): Promise<ConductorDriverLeaseRecord | null>;
  acquire(request: LeaseAcquireRequest): Promise<ConductorDriverLeaseResult>;
  renew(request: LeaseRenewRequest): Promise<ConductorDriverLeaseResult>;
  release(request: LeaseHoldRequest): Promise<ConductorDriverLeaseResult>;
  /** null when the request names the current, unexpired lease; else why not. Read-only. */
  check(request: LeaseHoldRequest): Promise<LeaseRefusal | null>;
}
