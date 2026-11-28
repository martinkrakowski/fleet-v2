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
import type { FenceRefusal } from '../../../domain/fence-token.js';

export type ConductorDriverLeaseResult =
  | { readonly outcome: 'ok'; readonly lease: ConductorDriverLeaseRecord }
  | { readonly outcome: 'refused'; readonly reason: LeaseRefusal };

/**
 * Thrown by `read()` when the lease file exists but its bytes cannot be read
 * as a lease (corrupt, oversized, unknown shape). It is part of the port's
 * contract: an unreadable lease is distinct from an absent one (`null`), and a
 * consumer that must stay unknown on unreadable input checks for this class
 * with `instanceof`. Carries no file content.
 */
export class ConductorDriverLeaseUnreadableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('conductor driver lease is unreadable', options);
    this.name = 'ConductorDriverLeaseUnreadableError';
  }
}

export interface ConductorDriverLeasePort {
  /**
   * The current driver lease, lapsed or not; null when none was ever taken.
   * Rejects with `ConductorDriverLeaseUnreadableError` when the lease file
   * exists but cannot be read (never answered as null).
   */
  read(): Promise<ConductorDriverLeaseRecord | null>;
  acquire(request: LeaseAcquireRequest): Promise<ConductorDriverLeaseResult>;
  renew(request: LeaseRenewRequest): Promise<ConductorDriverLeaseResult>;
  release(request: LeaseHoldRequest): Promise<ConductorDriverLeaseResult>;
  /** null when the request names the current, unexpired lease; else why not. Read-only. */
  check(request: LeaseHoldRequest): Promise<LeaseRefusal | null>;
  /**
   * Verify one `FenceToken` against the current lease without writing.
   * `null` when the token names the current, unexpired lease; else the typed
   * refusal (`invalid-token`, `no-lease`, `stale-fence`, `fence-ahead`,
   * `holder-mismatch`, `lease-expired`, `no-lease-readable`). An unreadable
   * lease file is `no-lease-readable`, never a pass.
   */
  verifyFence(token: unknown, nowIso: string): Promise<FenceRefusal | null>;
}
