import { describe, expect, it } from 'vitest';

import {
  isOrchestratorRequestClaimable,
  OrchestratorRequest,
} from '../entities/OrchestratorRequest.js';
import type { OrchestratorRequestResult } from '../entities/OrchestratorRequest.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const ID = '01JB0000000000000000000000';
const VALID = {
  requestId: ID, revision: 1, kind: 'dispatch-attempt', projectId: 'example-project',
  target: { attemptId: 'attempt-example-1' },
  requestedBy: { via: 'web', sessionId: 'web-session-example' },
  createdAtIso: '2026-10-27T10:00:00.000Z', expiresAtIso: '2026-10-27T10:30:00.000Z',
  updatedAtIso: '2026-10-27T10:00:00.000Z', state: 'queued', fence: 0, claimCount: 0,
  claim: null, deferredUntilIso: null, reason: null, linked: null,
};

function validWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID, ...overrides };
}

function succeed(result: OrchestratorRequestResult): OrchestratorRequest {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

const A = { orchestratorId: 'orch-example-1', expectedRevision: 1 };
const LINKED = { attemptId: 'attempt-example-1', journalKey: `request/${ID}` };
const REASON = { reasonKind: 'policy', detail: null };

describe('OrchestratorRequest transitions', () => {
  it('claims, renews and completes on the happy path', () => {
    const request = succeed(OrchestratorRequest.create(VALID));

    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    expect(claimed.getState()).toBe('claimed');
    expect(claimed.getRevision()).toBe(2);
    expect(claimed.getFence()).toBe(1);
    expect(claimed.toRecord().claim).toEqual({
      orchestratorId: 'orch-example-1',
      fence: 1,
      leaseUntilIso: '2026-10-27T10:02:10.000Z',
    });

    const renewed = succeed(
      claimed.renewClaim({ ...A, fence: 1, expectedRevision: 2 }, '2026-10-27T10:01:00Z'),
    );
    expect(renewed.getState()).toBe('claimed');
    expect(renewed.getRevision()).toBe(3);
    expect(renewed.toRecord().claim?.leaseUntilIso).toBe('2026-10-27T10:03:00.000Z');

    const completed = succeed(
      renewed.complete(
        { ...A, fence: 1, expectedRevision: 3 },
        LINKED,
        '2026-10-27T10:01:30Z',
      ),
    );
    expect(completed.getState()).toBe('dispatched');
    expect(completed.getRevision()).toBe(4);
    expect(completed.toRecord().claim).toEqual({
      orchestratorId: 'orch-example-1',
      fence: 1,
      leaseUntilIso: '2026-10-27T10:03:00.000Z',
    });
    expect(completed.isTerminal()).toBe(true);
  });

  it('refuses every claim mutation from a stale revision, fence, holder or lease', () => {
    const request = succeed(OrchestratorRequest.create(VALID));
    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const original = claimed.toRecord();
    const holder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };

    const mutations: Array<[(h: unknown, now: string) => OrchestratorRequestResult]> = [
      [(h, now) => claimed.renewClaim(h, now)],
      [(h, now) => claimed.complete(h, LINKED, now)],
      [(h, now) => claimed.refuse(h, REASON, now)],
      [(h, now) => claimed.defer(h, '2026-10-27T10:10:00Z', REASON, now)],
    ];

    for (const [mutate] of mutations) {
      const stale = mutate({ ...holder, expectedRevision: 1 }, '2026-10-27T10:00:20Z');
      expect(stale.success).toBe(false);
      if (!stale.success) {
        expect(stale.code).toBe('revision');
        expect(stale.error.message).toBe('OrchestratorRequest revision does not match the record');
      }
      const wrongFence = mutate({ ...holder, fence: 2 }, '2026-10-27T10:00:20Z');
      expect(wrongFence.success).toBe(false);
      if (!wrongFence.success) {
        expect(wrongFence.code).toBe('holder');
        expect(wrongFence.error.message).toBe('OrchestratorRequest caller does not hold the current claim');
      }
      const wrongHolder = mutate({ ...holder, orchestratorId: 'orch-example-2' }, '2026-10-27T10:00:20Z');
      expect(wrongHolder.success).toBe(false);
      if (!wrongHolder.success) {
        expect(wrongHolder.code).toBe('holder');
      }
      for (const now of ['2026-10-27T10:02:10.000Z', '2026-10-27T10:02:11Z']) {
        const lapsed = mutate(holder, now);
        expect(lapsed.success).toBe(false);
        if (!lapsed.success) {
          expect(lapsed.code).toBe('lease');
          expect(lapsed.error.message).toBe('OrchestratorRequest claim lease has expired');
        }
      }
      expect(claimed.toRecord()).toEqual(original);
    }

    const cancelRequested = succeed(claimed.requestCancel(2, '2026-10-27T10:00:30Z'));
    expect(cancelRequested.getState()).toBe('cancel-requested');
    const cancelOriginal = cancelRequested.toRecord();
    const cancelHolder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 3 };

    const staleCancel = cancelRequested.confirmCancel({ ...cancelHolder, expectedRevision: 2 }, '2026-10-27T10:00:40Z');
    expect(staleCancel.success).toBe(false);
    if (!staleCancel.success) {
      expect(staleCancel.code).toBe('revision');
    }
    const wrongFenceCancel = cancelRequested.confirmCancel({ ...cancelHolder, fence: 2 }, '2026-10-27T10:00:40Z');
    expect(wrongFenceCancel.success).toBe(false);
    if (!wrongFenceCancel.success) {
      expect(wrongFenceCancel.code).toBe('holder');
    }
    const wrongHolderCancel = cancelRequested.confirmCancel(
      { ...cancelHolder, orchestratorId: 'orch-example-2' },
      '2026-10-27T10:00:40Z',
    );
    expect(wrongHolderCancel.success).toBe(false);
    if (!wrongHolderCancel.success) {
      expect(wrongHolderCancel.code).toBe('holder');
    }
    const lapsedCancel = cancelRequested.confirmCancel(cancelHolder, '2026-10-27T10:02:10.000Z');
    expect(lapsedCancel.success).toBe(false);
    if (!lapsedCancel.success) {
      expect(lapsedCancel.code).toBe('lease');
    }
    expect(cancelRequested.toRecord()).toEqual(cancelOriginal);
  });

  it('a stale claimant fails after a re-queue hands the claim to someone else', () => {
    const request = succeed(OrchestratorRequest.create(VALID));
    const B = { orchestratorId: 'orch-example-2', expectedRevision: 1 };

    const claimedByA = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    expect(claimedByA.getFence()).toBe(1);

    const requeued = succeed(claimedByA.expireLapsedClaim('2026-10-27T10:02:10.000Z'));
    expect(requeued.getState()).toBe('queued');
    expect(requeued.toRecord().claimCount).toBe(1);
    expect(requeued.getFence()).toBe(1);
    expect(requeued.toRecord().claim).toBeNull();

    const claimedByB = succeed(requeued.claim({ ...B, expectedRevision: requeued.getRevision() }, '2026-10-27T10:02:20Z'));
    expect(claimedByB.getFence()).toBe(2);

    const staleComplete = claimedByB.complete(
      { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: claimedByB.getRevision() },
      LINKED,
      '2026-10-27T10:02:30Z',
    );
    expect(staleComplete.success).toBe(false);
    if (!staleComplete.success) {
      expect(staleComplete.code).toBe('holder');
    }

    const fineComplete = succeed(
      claimedByB.complete(
        { orchestratorId: 'orch-example-2', fence: 2, expectedRevision: claimedByB.getRevision() },
        LINKED,
        '2026-10-27T10:02:30Z',
      ),
    );
    expect(fineComplete.getState()).toBe('dispatched');
  });

  it('two lost claims stall the request and every method on it is refused', () => {
    const request = succeed(OrchestratorRequest.create(VALID));

    const first = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const requeued = succeed(first.expireLapsedClaim('2026-10-27T10:02:10.000Z'));
    expect(requeued.toRecord().claimCount).toBe(1);

    const second = succeed(requeued.claim({ ...A, expectedRevision: requeued.getRevision() }, '2026-10-27T10:02:20Z'));
    const stalled = succeed(second.expireLapsedClaim('2026-10-27T10:04:20.000Z'));
    expect(stalled.getState()).toBe('stalled');
    expect(stalled.toRecord().claimCount).toBe(2);
    expect(stalled.getFence()).toBe(2);

    const claimResult = stalled.claim({ ...A, expectedRevision: stalled.getRevision() }, '2026-10-27T10:04:30Z');
    expect(claimResult.success).toBe(false);
    if (!claimResult.success) {
      expect(claimResult.code).toBe('state');
    }

    const holder = { orchestratorId: 'orch-example-1', fence: 2, expectedRevision: stalled.getRevision() };
    const now = '2026-10-27T10:04:30Z';
    expect(stalled.renewClaim(holder, now).success).toBe(false);
    expect(stalled.complete(holder, LINKED, now).success).toBe(false);
    expect(stalled.refuse(holder, REASON, now).success).toBe(false);
    expect(stalled.defer(holder, '2026-10-27T10:10:00Z', { reasonKind: 'capacity', detail: null }, now).success).toBe(false);
    expect(stalled.confirmCancel(holder, now).success).toBe(false);
    expect(stalled.requestCancel(stalled.getRevision(), now).success).toBe(false);
    expect(stalled.expireLapsedClaim(now).success).toBe(false);
    expect(stalled.expireUnclaimed(now).success).toBe(false);
  });

  it('expires unclaimed requests at their deadline and never under a claimant', () => {
    const request = succeed(OrchestratorRequest.create(VALID));

    expect(request.claim(A, '2026-10-27T10:29:59Z').success).toBe(true);

    const expiredClaim = request.claim(A, '2026-10-27T10:30:00.000Z');
    expect(expiredClaim.success).toBe(false);
    if (!expiredClaim.success) {
      expect(expiredClaim.code).toBe('expired');
      expect(expiredClaim.error.message).toBe('OrchestratorRequest has expired unclaimed');
    }

    const lateSweep = request.expireUnclaimed('2026-10-27T10:29:59.999Z');
    expect(lateSweep.success).toBe(false);
    if (!lateSweep.success) {
      expect(lateSweep.code).toBe('state');
      expect(lateSweep.error.message).toBe('OrchestratorRequest is not an unclaimed request past its expiry');
    }

    const swept = succeed(request.expireUnclaimed('2026-10-27T10:30:00.000Z'));
    expect(swept.getState()).toBe('expired');
    expect(swept.toRecord().reason).toBeNull();
    expect(swept.toRecord().deferredUntilIso).toBeNull();
    expect(swept.isTerminal()).toBe(true);

    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const claimedSweep = claimed.expireUnclaimed('2026-10-27T10:31:00Z');
    expect(claimedSweep.success).toBe(false);
    if (!claimedSweep.success) {
      expect(claimedSweep.code).toBe('state');
    }
  });

  it('defers a claimed request and re-issues a higher fence afterwards', () => {
    const request = succeed(OrchestratorRequest.create(VALID));
    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const holder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };
    const reason = { reasonKind: 'capacity', detail: null };

    const deferred = succeed(claimed.defer(holder, '2026-10-27T10:10:00Z', reason, '2026-10-27T10:00:30Z'));
    expect(deferred.getState()).toBe('deferred');
    expect(deferred.toRecord().claim).toBeNull();
    expect(deferred.toRecord().deferredUntilIso).toBe('2026-10-27T10:10:00.000Z');
    expect(deferred.toRecord().reason).toEqual(reason);

    const pending = deferred.claim({ ...A, expectedRevision: deferred.getRevision() }, '2026-10-27T10:09:59Z');
    expect(pending.success).toBe(false);
    if (!pending.success) {
      expect(pending.code).toBe('state');
      expect(pending.error.message).toBe('OrchestratorRequest is deferred until later');
    }

    const reclaimed = succeed(deferred.claim({ ...A, expectedRevision: deferred.getRevision() }, '2026-10-27T10:10:00Z'));
    expect(reclaimed.getState()).toBe('claimed');
    expect(reclaimed.getFence()).toBe(2);

    for (const until of ['2026-10-27T10:31:00Z', '2026-10-27T10:00:40Z', '2026-10-27T10:00:39Z']) {
      const refused = claimed.defer(holder, until, reason, '2026-10-27T10:00:40Z');
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error.message).toBe('OrchestratorRequest defer must end after now and no later than its expiry');
      }
    }

    const cancelRequested = succeed(claimed.requestCancel(2, '2026-10-27T10:00:50Z'));
    const deferCancel = cancelRequested.defer(
      { ...holder, expectedRevision: cancelRequested.getRevision() },
      '2026-10-27T10:10:00Z',
      reason,
      '2026-10-27T10:01:00Z',
    );
    expect(deferCancel.success).toBe(false);
    if (!deferCancel.success) {
      expect(deferCancel.code).toBe('state');
    }
  });

  it('refuses with the typed reason and rejects overlong, secret or unknown reasons', () => {
    const request = succeed(OrchestratorRequest.create(VALID));
    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const holder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };

    const reason = { reasonKind: 'policy', detail: 'dispatch-attempt is refused while the conductor is enabled' };
    const refused = succeed(claimed.refuse(holder, reason, '2026-10-27T10:00:20Z'));
    expect(refused.getState()).toBe('refused');
    expect(refused.toRecord().reason).toEqual(reason);
    expect(refused.toRecord().claim).toEqual({
      orchestratorId: 'orch-example-1',
      fence: 1,
      leaseUntilIso: '2026-10-27T10:02:10.000Z',
    });
    expect(refused.isTerminal()).toBe(true);

    const overlong = claimed.refuse(holder, { reasonKind: 'policy', detail: 'a'.repeat(1025) }, '2026-10-27T10:00:20Z');
    expect(overlong.success).toBe(false);
    if (!overlong.success) {
      expect(overlong.code).toBe('invalid');
    }

    const secretDetail = claimed.refuse(holder, { reasonKind: 'policy', detail: fakeSecretShape() }, '2026-10-27T10:00:20Z');
    expect(secretDetail.success).toBe(false);
    if (!secretDetail.success) {
      expect(secretDetail.code).toBe('invalid');
      expect(secretDetail.error.message).not.toContain(fakeSecretShape());
    }

    const busyReason = claimed.refuse(holder, { reasonKind: 'busy', detail: null }, '2026-10-27T10:00:20Z');
    expect(busyReason.success).toBe(false);
    if (!busyReason.success) {
      expect(busyReason.code).toBe('invalid');
    }
  });

  it('lets the owner cancel queued, deferred and claimed requests', () => {
    const request = succeed(OrchestratorRequest.create(VALID));

    const queuedCancelled = succeed(request.requestCancel(1, '2026-10-27T10:00:05Z'));
    expect(queuedCancelled.getState()).toBe('cancelled');
    expect(queuedCancelled.toRecord().claim).toBeNull();
    expect(queuedCancelled.toRecord().reason).toBeNull();
    expect(queuedCancelled.toRecord().deferredUntilIso).toBeNull();
    expect(queuedCancelled.isTerminal()).toBe(true);

    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const holder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };

    const deferred = succeed(claimed.defer(holder, '2026-10-27T10:10:00Z', { reasonKind: 'capacity', detail: null }, '2026-10-27T10:00:20Z'));
    const deferredCancelled = succeed(deferred.requestCancel(deferred.getRevision(), '2026-10-27T10:00:30Z'));
    expect(deferredCancelled.getState()).toBe('cancelled');
    expect(deferredCancelled.toRecord().reason).toBeNull();
    expect(deferredCancelled.toRecord().deferredUntilIso).toBeNull();

    const cancelRequested = succeed(claimed.requestCancel(2, '2026-10-27T10:00:30Z'));
    expect(cancelRequested.getState()).toBe('cancel-requested');
    expect(cancelRequested.toRecord().claim).toEqual({
      orchestratorId: 'orch-example-1',
      fence: 1,
      leaseUntilIso: '2026-10-27T10:02:10.000Z',
    });
    expect(cancelRequested.getRevision()).toBe(3);

    const again = cancelRequested.requestCancel(3, '2026-10-27T10:00:35Z');
    expect(again.success).toBe(true);
    if (again.success) {
      expect(again.value).toBe(cancelRequested);
      expect(again.value.getRevision()).toBe(3);
    }

    const confirmed = succeed(
      cancelRequested.confirmCancel(
        { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 3 },
        '2026-10-27T10:00:40Z',
      ),
    );
    expect(confirmed.getState()).toBe('cancelled');
    expect(confirmed.toRecord().claim).toBeNull();
    expect(confirmed.getRevision()).toBe(4);

    const cancelRequested2 = succeed(claimed.requestCancel(2, '2026-10-27T10:00:30Z'));
    const dispatched = succeed(
      cancelRequested2.complete(
        { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 3 },
        LINKED,
        '2026-10-27T10:00:45Z',
      ),
    );
    expect(dispatched.getState()).toBe('dispatched');

    const cancelDispatched = dispatched.requestCancel(dispatched.getRevision(), '2026-10-27T10:01:00Z');
    expect(cancelDispatched.success).toBe(false);
    if (!cancelDispatched.success) {
      expect(cancelDispatched.code).toBe('state');
      expect(cancelDispatched.error.message).toBe('OrchestratorRequest cannot cancel from its current state');
    }

    const cancelRequested3 = succeed(claimed.requestCancel(2, '2026-10-27T10:00:30Z'));
    const lapsedCancelled = succeed(cancelRequested3.expireLapsedClaim('2026-10-27T10:02:10.000Z'));
    expect(lapsedCancelled.getState()).toBe('cancelled');
    expect(lapsedCancelled.toRecord().claimCount).toBe(0);
  });

  it('validates the dispatch link of complete', () => {
    const request = succeed(OrchestratorRequest.create(VALID));
    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const holder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };

    const wrongKey = claimed.complete(holder, { runId: 'r', journalKey: `request/${ID}` }, '2026-10-27T10:00:20Z');
    expect(wrongKey.success).toBe(false);
    if (!wrongKey.success) {
      expect(wrongKey.code).toBe('invalid');
    }

    const wrongJournal = claimed.complete(holder, { attemptId: 'attempt-example-1', journalKey: 'request/OTHER' }, '2026-10-27T10:00:20Z');
    expect(wrongJournal.success).toBe(false);
    if (!wrongJournal.success) {
      expect(wrongJournal.code).toBe('invalid');
    }

    const startRun = succeed(OrchestratorRequest.create(validWith({ kind: 'start-lane-run', target: { workOrderId: 'work-order-1' } })));
    const claimedRun = succeed(startRun.claim(A, '2026-10-27T10:00:10Z'));
    const completedRun = succeed(
      claimedRun.complete(holder, { runId: 'run-example-1', journalKey: `request/${ID}` }, '2026-10-27T10:00:20Z'),
    );
    expect(completedRun.getState()).toBe('dispatched');
    expect((completedRun.toRecord().linked as { runId: string }).runId).toBe('run-example-1');
  });

  it('never throws on hostile holders, now values, linked and reason inputs', () => {
    const request = succeed(OrchestratorRequest.create(VALID));
    const claimed = succeed(request.claim(A, '2026-10-27T10:00:10Z'));
    const holder = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };

    const allMethods: Array<() => OrchestratorRequestResult> = [
      () => claimed.claim(A, undefined as unknown as string),
      () => claimed.renewClaim(holder, undefined as unknown as string),
      () => claimed.complete(holder, LINKED, undefined as unknown as string),
      () => claimed.refuse(holder, REASON, undefined as unknown as string),
      () => claimed.defer(holder, '2026-10-27T10:10:00Z', REASON, undefined as unknown as string),
      () => claimed.confirmCancel(holder, undefined as unknown as string),
      () => claimed.requestCancel(2, undefined as unknown as string),
      () => claimed.expireLapsedClaim(undefined as unknown as string),
      () => claimed.expireUnclaimed(undefined as unknown as string),
    ];
    for (const method of allMethods) {
      const result = method();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain('boom');
      }
    }

    const hostileHolders: unknown[] = [
      null,
      [],
      42,
      (() => {
        const h = { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 };
        Object.defineProperty(h, 'fence', {
          get() {
            throw new Error('boom');
          },
          enumerable: true,
        });
        return h;
      })(),
      new Proxy({ orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 }, {
        ownKeys() {
          throw new Error('boom');
        },
      }),
    ];

    const cancelRequested = succeed(claimed.requestCancel(2, '2026-10-27T10:00:30Z'));
    for (const hostile of hostileHolders) {
      expect(claimed.renewClaim(hostile, '2026-10-27T10:00:20Z').success).toBe(false);
      expect(claimed.complete(hostile, LINKED, '2026-10-27T10:00:20Z').success).toBe(false);
      expect(claimed.refuse(hostile, REASON, '2026-10-27T10:00:20Z').success).toBe(false);
      expect(claimed.defer(hostile, '2026-10-27T10:10:00Z', REASON, '2026-10-27T10:00:20Z').success).toBe(false);
      expect(cancelRequested.confirmCancel(hostile, '2026-10-27T10:00:40Z').success).toBe(false);
    }

    const hostileLinked: unknown[] = [
      (() => {
        const link = { attemptId: 'attempt-example-1', journalKey: `request/${ID}` };
        Object.defineProperty(link, 'journalKey', {
          get() {
            throw new Error('boom');
          },
          enumerable: true,
        });
        return link;
      })(),
      new Proxy({ attemptId: 'attempt-example-1', journalKey: `request/${ID}` }, {
        ownKeys() {
          throw new Error('boom');
        },
      }),
    ];
    for (const hostile of hostileLinked) {
      const result = claimed.complete(holder, hostile, '2026-10-27T10:00:20Z');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain('boom');
      }
    }

    const hostileReasons: unknown[] = [
      (() => {
        const reason = { reasonKind: 'policy', detail: 'x' };
        Object.defineProperty(reason, 'detail', {
          get() {
            throw new Error('boom');
          },
          enumerable: true,
        });
        return reason;
      })(),
      new Proxy({ reasonKind: 'policy', detail: 'x' }, {
        ownKeys() {
          throw new Error('boom');
        },
      }),
    ];
    for (const hostile of hostileReasons) {
      const result = claimed.refuse(holder, hostile, '2026-10-27T10:00:20Z');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain('boom');
      }
    }
  });

  it('isOrchestratorRequestClaimable follows state, deferral and expiry', () => {
    const queued = succeed(OrchestratorRequest.create(VALID));
    expect(isOrchestratorRequestClaimable(queued.toRecord(), '2026-10-27T10:00:00Z')).toBe(true);
    expect(isOrchestratorRequestClaimable(queued.toRecord(), '2026-10-27T10:30:00.000Z')).toBe(false);
    expect(isOrchestratorRequestClaimable(queued.toRecord(), undefined)).toBe(false);
    expect(isOrchestratorRequestClaimable(queued.toRecord(), 'not-a-time')).toBe(false);

    const claimed = succeed(queued.claim(A, '2026-10-27T10:00:10Z'));
    expect(isOrchestratorRequestClaimable(claimed.toRecord(), '2026-10-27T10:00:20Z')).toBe(false);

    const deferred = succeed(
      claimed.defer(
        { orchestratorId: 'orch-example-1', fence: 1, expectedRevision: 2 },
        '2026-10-27T10:10:00Z',
        { reasonKind: 'capacity', detail: null },
        '2026-10-27T10:00:30Z',
      ),
    );
    expect(isOrchestratorRequestClaimable(deferred.toRecord(), '2026-10-27T10:09:59Z')).toBe(false);
    expect(isOrchestratorRequestClaimable(deferred.toRecord(), '2026-10-27T10:10:00Z')).toBe(true);
  });
});
