// ConductorDriverLeaseKeeper tests — KF-34a2.
/**
 * The one serialised driver-lease keeper: calls run strictly one at a time
 * through a promise-chain mutex; inside the critical section it reads the
 * clock fresh, computes the lease until from it, reads the stored lease and
 * holds it, so two renewals never overlap and a renewal never shortens the
 * lease. It latches: after the first loss every later call returns the same
 * loss without touching the port. Deferred fakes and an ordered trace; time
 * comes from the injected clock; no real timers.
 */

import { describe, expect, it } from 'vitest';

import { ConductorDriverLeaseKeeper } from '../conductor-driver-lease-keeper.js';
import type { ConductorDriverLeasePort } from '../../ports/out/ConductorDriverLeasePort.out-port.js';
import type {
  ConductorDriverLeaseRecord,
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../../../domain/lane-run-lease.js';
import type { ConductorDriverLeaseResult } from '../../ports/out/ConductorDriverLeasePort.out-port.js';

const NOW = '2026-10-27T10:00:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const LATER_UNTIL = '2026-10-27T10:06:00.000Z';
const HOLDER = 'driver-example-1';
const OTHER = 'driver-example-2';

function at(ms: number): string {
  return new Date(Date.parse(NOW) + ms).toISOString();
}

function lease(holderId: string, fence: number, leaseUntilIso: string = LEASE_UNTIL): ConductorDriverLeaseRecord {
  return { version: 1, holderId, fence, leaseUntilIso };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The clock recorder: each read is appended to the shared event trace. */
function recorder(startIso: string = NOW) {
  const events: string[] = [];
  let current = startIso;
  return {
    events,
    now: (): string => {
      events.push('clock');
      return current;
    },
    set: (iso: string): void => {
      current = iso;
    },
  };
}

/** An immediate fake: records calls, and answers per the lease rules. */
class AutoDriverLeasePort implements ConductorDriverLeasePort {
  readonly trace: string[] = [];
  readonly requests: Array<LeaseAcquireRequest | LeaseRenewRequest> = [];
  lease: ConductorDriverLeaseRecord | null = null;
  refuseRenew = false;
  refuseAcquire = false;

  read(): Promise<ConductorDriverLeaseRecord | null> {
    this.trace.push('read');
    return Promise.resolve(this.lease);
  }

  async acquire(request: LeaseAcquireRequest): Promise<ConductorDriverLeaseResult> {
    this.trace.push('acquire');
    this.requests.push(request);
    const currentFence = this.lease?.fence ?? 0;
    if (request.observedFence !== currentFence || this.refuseAcquire) {
      return { outcome: 'refused', reason: 'lease-moved' };
    }
    const next = lease(request.holderId, currentFence + 1, request.leaseUntilIso);
    this.lease = next;
    return { outcome: 'ok', lease: next };
  }

  async renew(request: LeaseRenewRequest): Promise<ConductorDriverLeaseResult> {
    this.trace.push('renew');
    this.requests.push(request);
    if (
      this.refuseRenew ||
      this.lease === null ||
      this.lease.holderId !== request.holderId ||
      this.lease.fence !== request.fence
    ) {
      return { outcome: 'refused', reason: 'lease-not-held' };
    }
    const next = { ...this.lease, leaseUntilIso: request.leaseUntilIso } as ConductorDriverLeaseRecord;
    this.lease = next;
    return { outcome: 'ok', lease: next };
  }

  release(request: LeaseHoldRequest): Promise<ConductorDriverLeaseResult> {
    this.trace.push('release');
    return Promise.resolve({ outcome: 'ok', lease: this.lease ?? lease(request.holderId, 1) });
  }

  check(_request: LeaseHoldRequest): Promise<LeaseRefusal | null> {
    this.trace.push('check');
    return Promise.resolve(null);
  }
}

/** A deferred fake: each acquire/renew blocks until `resolveNext`. */
class BlockingDriverLeasePort implements ConductorDriverLeasePort {
  readonly events: string[];
  readonly pending: Array<{ resolve: (result: ConductorDriverLeaseResult) => void }> = [];
  lease: ConductorDriverLeaseRecord | null = null;

  constructor(events: string[]) {
    this.events = events;
  }

  read(): Promise<ConductorDriverLeaseRecord | null> {
    this.events.push('read');
    return Promise.resolve(this.lease);
  }

  acquire(_request: LeaseAcquireRequest): Promise<ConductorDriverLeaseResult> {
    this.events.push('acquire');
    return this.block();
  }

  renew(_request: LeaseRenewRequest): Promise<ConductorDriverLeaseResult> {
    this.events.push('renew');
    return this.block();
  }

  release(request: LeaseHoldRequest): Promise<ConductorDriverLeaseResult> {
    this.events.push('release');
    return Promise.resolve({ outcome: 'ok', lease: this.lease ?? lease(request.holderId, 1) });
  }

  check(_request: LeaseHoldRequest): Promise<LeaseRefusal | null> {
    this.events.push('check');
    return Promise.resolve(null);
  }

  private block(): Promise<ConductorDriverLeaseResult> {
    const d = deferred<ConductorDriverLeaseResult>();
    this.pending.push(d);
    return d.promise;
  }

  resolveNext(result: ConductorDriverLeaseResult): void {
    const next = this.pending.shift();
    if (result.outcome === 'ok') {
      this.lease = result.lease;
    }
    next?.resolve(result);
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('ConductorDriverLeaseKeeper', () => {
  it('two concurrent renew() calls: the second\'s port call starts only after the first resolves', async () => {
    const clock = recorder();
    const port = new BlockingDriverLeasePort(clock.events);
    const events = clock.events;
    const keeper = new ConductorDriverLeaseKeeper({ driverLease: port, holderId: HOLDER, now: clock.now });

    const first = keeper.renew();
    await flushMicrotasks();
    expect(events).toEqual(['clock', 'read', 'acquire']);

    const second = keeper.renew();
    await flushMicrotasks();
    // The promise-chain mutex keeps the second call out of the port until the first resolves.
    expect(events).toEqual(['clock', 'read', 'acquire']);

    port.resolveNext({ outcome: 'ok', lease: lease(HOLDER, 1) });
    await expect(first).resolves.toEqual({ outcome: 'held', nowIso: NOW });

    await flushMicrotasks();
    expect(events).toEqual(['clock', 'read', 'acquire', 'clock', 'read', 'renew']);
    port.resolveNext({ outcome: 'ok', lease: lease(HOLDER, 1, LATER_UNTIL) });
    await expect(second).resolves.toEqual({ outcome: 'held', nowIso: NOW });
  });

  it('the second reads the clock after the first completes (trace order)', async () => {
    const clock = recorder();
    const port = new BlockingDriverLeasePort(clock.events);
    const events = clock.events;
    const keeper = new ConductorDriverLeaseKeeper({ driverLease: port, holderId: HOLDER, now: clock.now });

    const first = keeper.renew();
    await flushMicrotasks();
    const second = keeper.renew();
    await flushMicrotasks();
    expect(events).toEqual(['clock', 'read', 'acquire']);

    port.resolveNext({ outcome: 'ok', lease: lease(HOLDER, 1) });
    await expect(first).resolves.toEqual({ outcome: 'held', nowIso: NOW });
    await flushMicrotasks();
    // The second's clock read happens only after the first's port call completed.
    expect(events).toEqual(['clock', 'read', 'acquire', 'clock', 'read', 'renew']);
    port.resolveNext({ outcome: 'ok', lease: lease(HOLDER, 1, LATER_UNTIL) });
    await expect(second).resolves.toEqual({ outcome: 'held', nowIso: NOW });
  });

  it('three renewals with clock values t, t+1, t+2 send non-decreasing leaseUntilIso', async () => {
    const port = new AutoDriverLeasePort();
    const clock = recorder();
    const keeper = new ConductorDriverLeaseKeeper({ driverLease: port, holderId: HOLDER, now: clock.now });

    await expect(keeper.renew()).resolves.toEqual({ outcome: 'held', nowIso: NOW });
    expect(port.lease).toEqual(lease(HOLDER, 1, at(300_000)));

    clock.set(at(1_000));
    await expect(keeper.renew()).resolves.toEqual({ outcome: 'held', nowIso: at(1_000) });
    expect(port.lease).toEqual(lease(HOLDER, 1, at(301_000)));

    clock.set(at(2_000));
    await expect(keeper.renew()).resolves.toEqual({ outcome: 'held', nowIso: at(2_000) });
    expect(port.lease).toEqual(lease(HOLDER, 1, at(302_000)));

    const leaseUntils = port.requests.map((request) => request.leaseUntilIso);
    expect(leaseUntils).toEqual([at(300_000), at(301_000), at(302_000)]);
    expect([...leaseUntils].sort()).toEqual(leaseUntils);
  });

  it('after a lost driver-lease-held, later calls make no port call and return the same lost', async () => {
    const port = new AutoDriverLeasePort();
    port.lease = lease(OTHER, 1); // a live lease held by another holder
    const clock = recorder();
    const keeper = new ConductorDriverLeaseKeeper({ driverLease: port, holderId: HOLDER, now: clock.now });

    await expect(keeper.renew()).resolves.toEqual({ outcome: 'lost', reason: 'driver-lease-held' });
    expect(port.trace).toEqual(['read']);
    await expect(keeper.renew()).resolves.toEqual({ outcome: 'lost', reason: 'driver-lease-held' });
    expect(port.trace).toEqual(['read']);
  });

  it('after a lost driver-lease-refused, later calls make no port call and return the same lost', async () => {
    const port = new AutoDriverLeasePort();
    port.lease = lease(HOLDER, 1); // held by this holder, so the renewal is attempted
    port.refuseRenew = true;
    const clock = recorder();
    const keeper = new ConductorDriverLeaseKeeper({ driverLease: port, holderId: HOLDER, now: clock.now });

    await expect(keeper.renew()).resolves.toEqual({ outcome: 'lost', reason: 'driver-lease-refused' });
    expect(port.trace).toEqual(['read', 'renew']);
    await expect(keeper.renew()).resolves.toEqual({ outcome: 'lost', reason: 'driver-lease-refused' });
    expect(port.trace).toEqual(['read', 'renew']);
  });

  it('an invalid clock answers invalid-clock and sends nothing', async () => {
    const port = new AutoDriverLeasePort();
    const keeper = new ConductorDriverLeaseKeeper({
      driverLease: port,
      holderId: HOLDER,
      now: () => 'not-an-iso-time',
    });

    await expect(keeper.renew()).resolves.toEqual({ outcome: 'invalid-clock' });
    expect(port.trace).toEqual([]);
  });
});
