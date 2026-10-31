/**
 * ConductorDriverLeaseKeeper: the one place that takes and renews the state
 * directory's driver lease during a pass (KF-34a2). Calls run strictly one at
 * a time through a promise-chain mutex, so two renewals never overlap and a
 * renewal never shortens the lease: inside the critical section it reads the
 * clock fresh, computes the lease until from it, reads the stored lease and
 * calls `holdLease`, so the new `leaseUntilIso` is never older than the
 * previous renewal's. It latches: after the first loss every later call
 * returns the same loss without touching the port.
 */

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';
import type { LeaseAcquireRequest, LeaseRenewRequest } from '../../domain/lane-run-lease.js';
import type { LaneRunLeaseRecord } from '../../domain/lane-run-records.js';
import { CONDUCTOR_LEASE_MS } from '../ports/in/RunConductorPassPort.in-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';

export type ConductorDriverLeaseRenewResult =
  | { readonly outcome: 'held'; readonly nowIso: string }
  | { readonly outcome: 'lost'; readonly reason: 'driver-lease-held' | 'driver-lease-refused' }
  | { readonly outcome: 'invalid-clock' };

/** `nowIso` advanced by the driver lease window, normalised. */
function leaseUntilIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) + CONDUCTOR_LEASE_MS).toISOString();
}

/** The stored driver lease without its version: the shared lease shape. */
function withoutLeaseVersion(lease: LaneRunLeaseRecord | null): LaneRunLeaseRecord | null {
  if (lease === null) {
    return null;
  }
  return { holderId: lease.holderId, fence: lease.fence, leaseUntilIso: lease.leaseUntilIso };
}

export type HoldLeaseResult =
  | { readonly outcome: 'held'; readonly lease: LaneRunLeaseRecord }
  | { readonly outcome: 'held-by-other' }
  | { readonly outcome: 'refused' };

/** Take or renew one lease by CAS; another live holder is 'held-by-other', a refused write 'refused'. Shared by the keeper and the pass's run leases. */
export async function holdConductorLease(
  current: LaneRunLeaseRecord | null,
  holderId: string,
  nowIso: string,
  until: string,
  renew: (request: LeaseRenewRequest) => Promise<LaneRunLeaseRecord | null>,
  acquire: (request: LeaseAcquireRequest) => Promise<LaneRunLeaseRecord | null>,
): Promise<HoldLeaseResult> {
  if (current !== null && current.holderId !== holderId && !isLeaseLapsed(current, nowIso)) {
    return { outcome: 'held-by-other' };
  }
  let lease: LaneRunLeaseRecord | null;
  if (current !== null && current.holderId === holderId && !isLeaseLapsed(current, nowIso)) {
    lease = await renew({ holderId, fence: current.fence, leaseUntilIso: until, nowIso });
  } else {
    lease = await acquire({ holderId, observedFence: current?.fence ?? 0, leaseUntilIso: until, nowIso });
  }
  if (lease === null) {
    return { outcome: 'refused' };
  }
  return { outcome: 'held', lease };
}

export interface ConductorDriverLeaseKeeperDependencies {
  /** The state directory's driver lease port (the one lease of the directory). */
  readonly driverLease: ConductorDriverLeasePort;
  /** The pass's holder id: the process identity that owns the lease while live. */
  readonly holderId: string;
  /** The keeper clock, read fresh inside each critical section. */
  readonly now: () => string;
}

export class ConductorDriverLeaseKeeper {
  /** The promise-chain mutex: the next call is chained after the previous one settles. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Latched after the first loss: later calls return it without touching the port. */
  private latched: Extract<ConductorDriverLeaseRenewResult, { readonly outcome: 'lost' }> | null = null;

  constructor(private readonly deps: ConductorDriverLeaseKeeperDependencies) {}

  /** Run one driver-lease take or renewal, strictly one at a time; latches on loss. */
  renew(): Promise<ConductorDriverLeaseRenewResult> {
    const latched = this.latched;
    if (latched !== null) {
      return Promise.resolve(latched);
    }
    const call = this.chain.then(() => this.renewUnlocked());
    this.chain = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  /** The critical section: read the clock, compute the lease until, then hold the lease. */
  private async renewUnlocked(): Promise<ConductorDriverLeaseRenewResult> {
    const latched = this.latched;
    if (latched !== null) {
      return latched;
    }
    const nowIso = this.deps.now();
    if (!isZonedIsoDateTime(nowIso)) {
      return { outcome: 'invalid-clock' };
    }
    const until = leaseUntilIso(nowIso);
    const renew = (renew: LeaseRenewRequest) =>
      this.deps.driverLease.renew(renew).then((result) =>
        result.outcome === 'ok' ? withoutLeaseVersion(result.lease) : null,
      );
    const acquire = (acquire: LeaseAcquireRequest) =>
      this.deps.driverLease.acquire(acquire).then((result) =>
        result.outcome === 'ok' ? withoutLeaseVersion(result.lease) : null,
      );
    const driverLease = withoutLeaseVersion(await this.deps.driverLease.read());
    const held = await holdConductorLease(driverLease, this.deps.holderId, nowIso, until, renew, acquire);
    if (held.outcome === 'held-by-other') {
      this.latched = { outcome: 'lost', reason: 'driver-lease-held' };
      return this.latched;
    }
    if (held.outcome === 'refused') {
      this.latched = { outcome: 'lost', reason: 'driver-lease-refused' };
      return this.latched;
    }
    return { outcome: 'held', nowIso };
  }
}
