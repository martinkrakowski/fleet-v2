// @generated outbound contract scaffold — refined for lane DT3.
/**
 * Hold one daemon job lease by scope (plan §3.4): acquire by CAS over a null
 * or lapsed lease, renew and release by its holder with its fence, and check
 * or read without writing; the fence never goes back. The pure decisions in
 * `lane-run-lease.js` own every fence value; this port only carries the scope
 * alongside them.
 */
import type {
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../../../domain/lane-run-lease.js';
import type { DaemonLeaseRecord } from '../../../domain/daemon-tick.js';

export interface DaemonLeasePort {
  acquire(request: LeaseAcquireRequest & { scope: string }): Promise<DaemonLeaseResult>;
  renew(request: LeaseRenewRequest & { scope: string }): Promise<DaemonLeaseResult>;
  release(request: LeaseHoldRequest & { scope: string }): Promise<DaemonLeaseResult>;
  check(request: LeaseHoldRequest & { scope: string }): Promise<LeaseRefusal | null>;
  read(scope: string): Promise<DaemonLeaseRecord | null>;
}

export type DaemonLeaseResult =
  | { readonly outcome: 'ok'; readonly lease: DaemonLeaseRecord }
  | { readonly outcome: 'refused'; readonly reason: string };
