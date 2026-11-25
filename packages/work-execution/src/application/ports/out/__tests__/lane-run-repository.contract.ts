import { describe, expect, it } from 'vitest';

import type { LaneRunRepositoryPort } from '../LaneRunRepositoryPort.out-port.js';
import type { LaneRunRecord } from '../../../../domain/lane-run-records.js';
import { LANE_RUN_LEASE_MAX_MS } from '../../../../domain/lane-run-lease.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
const AFTER = '2026-10-27T10:03:00.000Z';

/**
 * K1-1's VALID run record; overrides are spread last so tests can tweak one
 * field. The seat-plan reference is a sha256-shaped hex string built at
 * runtime, never a real credential or a literal fixture.
 */
function validRun(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: 1,
    runId: 'run-01JB0000000000000000000000',
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
    schemaVersion: 1,
    ...overrides,
  };
}

const ACQUIRE = { holderId: 'driver-example-1', observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW };
const HOLD = { holderId: 'driver-example-1', fence: 1, nowIso: NOW };

/**
 * The shared contract suite for LaneRunRepositoryPort. It runs against the
 * real adapter in both its modes (in-memory and file-backed) so the two
 * cannot drift. Holds no `.test.ts` suffix: the runners that import it
 * collect it.
 *
 * Hostile-input note: every malformed value below is a small fixed O(1)
 * fixture, so each check costs O(1) and no deadline or budget bound applies.
 */
export function describeLaneRunRepositoryContract(
  label: string,
  createPort: () => LaneRunRepositoryPort,
): void {
  describe(`LaneRunRepositoryPort contract (${label})`, () => {
    it('create stores a valid run at revision 1 with no lease and get returns an equal copy', async () => {
      const port = createPort();
      const result = await port.create(validRun());
      expect(result).toEqual({
        outcome: 'saved',
        record: expect.objectContaining({ runId: 'run-01JB0000000000000000000000' }),
      } as const);
      if (result.outcome !== 'saved') {
        throw new Error('expected create to save');
      }
      expect(result.record.revision).toBe(1);
      expect(result.record.lease).toBeNull();

      const found = await port.get('run-01JB0000000000000000000000');
      expect(found).toEqual(result.record);
    });

    it('create refuses a duplicate run id with run-exists', async () => {
      const port = createPort();
      await port.create(validRun());
      expect(await port.create(validRun())).toEqual({
        outcome: 'refused',
        reason: 'run-exists',
      } as const);
    });

    it('create refuses an invalid record, non-1 revision, or non-null lease with invalid-record', async () => {
      const port = createPort();
      // Invalid record: a non-ULID run id.
      expect(await port.create(validRun({ runId: 'not-a-run-id' }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-record',
      } as const);
      expect(await port.create(null as unknown as LaneRunRecord)).toEqual({
        outcome: 'refused',
        reason: 'invalid-record',
      } as const);
      // Revision !== 1.
      expect(await port.create(validRun({ revision: 2 }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-record',
      } as const);
      // Non-null lease.
      expect(
        await port.create(validRun({ lease: { holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN } })),
      ).toEqual({ outcome: 'refused', reason: 'invalid-record' } as const);

      const stored = await port.get('run-01JB0000000000000000000000');
      expect(stored).toBeNull();
    });

    it('get returns null for an unknown run id', async () => {
      const port = createPort();
      expect(await port.get('run-01JC0000000000000000000000')).toBeNull();
      expect(await port.get('')).toBeNull();
      expect(await port.get('not-a-run-id')).toBeNull();
      expect(await port.get(42 as unknown as string)).toBeNull();
    });

    it('list returns every created run sorted by runId', async () => {
      const port = createPort();
      await port.create(validRun({ runId: 'run-01JB0000000000000000000002' }));
      await port.create(validRun({ runId: 'run-01JB0000000000000000000001' }));
      await port.create(validRun({ runId: 'run-01JB0000000000000000000003' }));

      const listed = await port.list();
      expect(listed.map((run) => run.runId)).toEqual([
        'run-01JB0000000000000000000001',
        'run-01JB0000000000000000000002',
        'run-01JB0000000000000000000003',
      ]);
    });

    it('save refuses an unknown run id with run-not-found', async () => {
      const port = createPort();
      const result = await port.save(validRun({ revision: 1 }), HOLD);
      expect(result).toEqual({ outcome: 'refused', reason: 'run-not-found' } as const);
    });

    it('save with a held lease at stored.revision + 1 lands and raises revision by one', async () => {
      const port = createPort();
      await port.create(validRun());
      const acquired = await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);
      expect(acquired.outcome).toBe('saved');

      const stored = (await port.get('run-01JB0000000000000000000000'))!;
      const result = await port.save(
        { ...stored, cursors: { 'first-pass': 1, fix: null, review: null }, revision: stored.revision + 1 },
        HOLD,
      );
      expect(result).toEqual({
        outcome: 'saved',
        record: expect.objectContaining({ revision: 2 }),
      } as const);
      expect((await port.get('run-01JB0000000000000000000000'))!.cursors['first-pass']).toBe(1);
      expect((await port.get('run-01JB0000000000000000000000'))!.revision).toBe(2);
    });

    it('save with a stale revision returns stale-revision and stores nothing', async () => {
      const port = createPort();
      await port.create(validRun());
      await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);
      const stored = (await port.get('run-01JB0000000000000000000000'))!;

      expect(
        await port.save(
          { ...stored, cursors: { 'first-pass': 9, fix: null, review: null }, revision: stored.revision },
          HOLD,
        ),
      ).toEqual({ outcome: 'refused', reason: 'stale-revision' } as const);
      expect((await port.get('run-01JB0000000000000000000000'))!.cursors['first-pass']).toBe(0);
    });

    it('save without a held lease returns lease-not-held and stores nothing', async () => {
      const port = createPort();
      await port.create(validRun());
      const stored = (await port.get('run-01JB0000000000000000000000'))!;

      // No lease is held at all (null lease), wrong holder, wrong fence.
      expect(await port.save({ ...stored, revision: stored.revision + 1 }, HOLD)).toEqual({
        outcome: 'refused',
        reason: 'lease-not-held',
      } as const);
      expect(
        await port.save(
          { ...stored, revision: stored.revision + 1 },
          { ...HOLD, holderId: 'driver-example-other' },
        ),
      ).toEqual({ outcome: 'refused', reason: 'lease-not-held' } as const);
      expect((await port.get('run-01JB0000000000000000000000'))!.revision).toBe(1);
    });

    it('save with an expired lease returns lease-expired and stores nothing', async () => {
      const port = createPort();
      await port.create(validRun());
      await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);
      const stored = (await port.get('run-01JB0000000000000000000000'))!;

      expect(
        await port.save({ ...stored, revision: stored.revision + 1 }, { ...HOLD, nowIso: AFTER }),
      ).toEqual({ outcome: 'refused', reason: 'lease-expired' } as const);
      expect((await port.get('run-01JB0000000000000000000000'))!.revision).toBe(1);
    });

    it('save that changes the lease returns lease-changed and stores nothing', async () => {
      const port = createPort();
      await port.create(validRun());
      await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);
      const stored = (await port.get('run-01JB0000000000000000000000'))!;

      expect(
        await port.save(
          {
            ...stored,
            revision: stored.revision + 1,
            lease: { ...stored.lease!, holderId: 'driver-example-other' },
          },
          HOLD,
        ),
      ).toEqual({ outcome: 'refused', reason: 'lease-changed' } as const);
      expect((await port.get('run-01JB0000000000000000000000'))!.lease!.holderId).toBe('driver-example-1');
    });

    it('save that changes immutable identity returns identity-changed and stores nothing', async () => {
      const port = createPort();
      await port.create(validRun());
      await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);
      const stored = (await port.get('run-01JB0000000000000000000000'))!;
      const next = { ...stored, revision: stored.revision + 1 };

      expect(await port.save({ ...next, workOrderId: 'wo-example-other' }, HOLD)).toEqual({
        outcome: 'refused',
        reason: 'identity-changed',
      } as const);
      expect(await port.save({ ...next, tier: 1 }, HOLD)).toEqual({
        outcome: 'refused',
        reason: 'identity-changed',
      } as const);
      expect(await port.save({ ...next, seatPlanRef: 'b'.repeat(64) }, HOLD)).toEqual({
        outcome: 'refused',
        reason: 'identity-changed',
      } as const);
      expect(await port.save({ ...next, runPolicyRevision: 'policy-example-other' }, HOLD)).toEqual({
        outcome: 'refused',
        reason: 'identity-changed',
      } as const);
      // Nothing stored: the revision is still 1 and the identity is intact.
      const unchanged = (await port.get('run-01JB0000000000000000000000'))!;
      expect(unchanged.revision).toBe(1);
      expect(unchanged.workOrderId).toBe('wo-example-1');
      expect(unchanged.seatPlanRef).toBe('a'.repeat(64));
    });

    it('acquireLease on an unknown run id returns run-not-found', async () => {
      const port = createPort();
      expect(
        await port.acquireLease('run-01JC0000000000000000000000', ACQUIRE),
      ).toEqual({ outcome: 'refused', reason: 'run-not-found' } as const);
    });

    it('acquireLease while a lease is live returns lease-held and keeps the first holder', async () => {
      const port = createPort();
      await port.create(validRun());
      expect((await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE)).outcome).toBe('saved');

      const second = await port.acquireLease('run-01JB0000000000000000000000', {
        ...ACQUIRE,
        holderId: 'driver-example-other',
        observedFence: 1,
      });
      expect(second).toEqual({ outcome: 'refused', reason: 'lease-held' } as const);
      const kept = (await port.get('run-01JB0000000000000000000000'))!.lease!;
      expect(kept.holderId).toBe('driver-example-1');
      expect(kept.fence).toBe(1);
    });

    it('acquireLease with a stale observedFence returns lease-moved', async () => {
      const port = createPort();
      await port.create(validRun());
      const runId = 'run-01JB0000000000000000000000';
      expect((await port.acquireLease(runId, ACQUIRE)).outcome).toBe('saved');
      // The fence is now 1 but the caller observed the pre-lease fence 0, and
      // the first lease has expired by AFTER: the fence check fires.
      const stale = await port.acquireLease(runId, {
        ...ACQUIRE,
        holderId: 'driver-example-other',
        nowIso: AFTER,
        leaseUntilIso: '2026-10-27T10:05:00.000Z',
        observedFence: 0,
      });
      expect(stale).toEqual({ outcome: 'refused', reason: 'lease-moved' } as const);
      // Nothing changed: the expired lease record keeps its holder and fence.
      const kept = (await port.get(runId))!.lease!;
      expect(kept.holderId).toBe('driver-example-1');
      expect(kept.fence).toBe(1);
    });

    it('renewLease and releaseLease by a non-holder are refused with lease-not-held and change nothing', async () => {
      const port = createPort();
      await port.create(validRun());
      await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);
      const before = (await port.get('run-01JB0000000000000000000000'))!.lease;

      const stranger = { ...HOLD, holderId: 'driver-example-other' };
      expect(
        await port.renewLease('run-01JB0000000000000000000000', { ...stranger, leaseUntilIso: AFTER }),
      ).toEqual({ outcome: 'refused', reason: 'lease-not-held' } as const);
      expect(await port.releaseLease('run-01JB0000000000000000000000', stranger)).toEqual({
        outcome: 'refused',
        reason: 'lease-not-held',
      } as const);
      expect((await port.get('run-01JB0000000000000000000000'))!.lease).toEqual(before);
    });

    it('renewLease and releaseLease on an unknown run id return run-not-found', async () => {
      const port = createPort();
      const absent = 'run-01JC0000000000000000000000';
      expect(
        await port.renewLease(absent, { ...HOLD, leaseUntilIso: IN_2_MIN }),
      ).toEqual({ outcome: 'refused', reason: 'run-not-found' } as const);
      expect(await port.releaseLease(absent, HOLD)).toEqual({
        outcome: 'refused',
        reason: 'run-not-found',
      } as const);
    });

    it('lease operations refuse malformed request inputs with invalid-request', async () => {
      const port = createPort();
      await port.create(validRun());
      const runId = 'run-01JB0000000000000000000000';

      // Small fixed O(1) hostile fixtures; every check below is O(1), so no
      // deadline or budget bound applies.
      const malformed: readonly unknown[] = [
        null,
        undefined,
        42,
        'driver-example-1',
        Object.assign([ACQUIRE.holderId], { 1: ACQUIRE.observedFence, length: 3 }), // array-like with a hole
        JSON.parse( // an own '__proto__' key (a prototype-polluting key set) beside the real fields
          '{"__proto__": {"polluted": true}, "holderId": "driver-example-1", "observedFence": 0, "leaseUntilIso": "' +
          IN_2_MIN +
          '", "nowIso": "' +
          NOW +
          '"}',
        ),
        {
          get holderId(): string {
            throw new Error('getter refused to run');
          },
          observedFence: 0,
          leaseUntilIso: IN_2_MIN,
          nowIso: NOW,
        }, // a getter that throws
        // A Proxy that lies in its ownKeys/getOwnPropertyDescriptor traps is
        // refused (the read throws and is caught). A Proxy that is honest in
        // those reflection traps is accepted even with a lying `get` trap —
        // the reader never runs `get`, and that honest-reflection Proxy is
        // the stated accepted residual.
        new Proxy({ ...ACQUIRE }, {
          ownKeys(): ArrayLike<string | symbol> {
            throw new Error('proxy ownKeys refused');
          },
        }),
        { ...ACQUIRE, leaseUntilIso: 'x'.repeat(100_000_001) }, // an enormous length value
        JSON.parse('{"__proto__": {"polluted": true}}'), // a prototype-polluting key
      ];

      for (const request of malformed) {
        const acquired = await port.acquireLease(runId, request as Parameters<LaneRunRepositoryPort['acquireLease']>[1]);
        expect(acquired).toEqual({ outcome: 'refused', reason: 'invalid-request' } as const);
        const renewed = await port.renewLease(runId, request as Parameters<LaneRunRepositoryPort['renewLease']>[1]);
        expect(renewed).toEqual({ outcome: 'refused', reason: 'invalid-request' } as const);
        const released = await port.releaseLease(runId, request as Parameters<LaneRunRepositoryPort['releaseLease']>[1]);
        expect(released).toEqual({ outcome: 'refused', reason: 'invalid-request' } as const);
      }
      expect((await port.get(runId))!.lease).toBeNull();
    });

    it('returned records are copies: mutating nested fields changes nothing stored', async () => {
      const port = createPort();
      const created = await port.create(validRun());
      if (created.outcome !== 'saved') {
        throw new Error('expected create to save');
      }
      await port.acquireLease('run-01JB0000000000000000000000', ACQUIRE);

      const mutate = (record: LaneRunRecord): void => {
        (record.attemptIds as string[]).push('attempt-example-rogue');
        (record.cursors as Record<string, unknown>)['first-pass'] = 99;
        if (record.lease !== null) {
          (record.lease as { holderId: string }).holderId = 'driver-example-rogue';
        }
      };

      mutate(created.record);
      const fromGet = (await port.get('run-01JB0000000000000000000000'))!;
      mutate(fromGet);
      const listed = await port.list();
      mutate(listed[0]!);

      const stored = (await port.get('run-01JB0000000000000000000000'))!;
      expect(stored.attemptIds).toEqual(['attempt-example-1']);
      expect(stored.cursors['first-pass']).toBe(0);
      expect(stored.lease!.holderId).toBe('driver-example-1');

      // A save through the port returns a fresh copy too.
      const saved = await port.save(
        { ...stored, cursors: { 'first-pass': 1, fix: null, review: null }, revision: stored.revision + 1 },
        HOLD,
      );
      if (saved.outcome !== 'saved') {
        throw new Error('expected save to land');
      }
      mutate(saved.record);
      const storedAfter = (await port.get('run-01JB0000000000000000000000'))!;
      expect(storedAfter.cursors['first-pass']).toBe(1);
      expect(storedAfter.attemptIds).toEqual(['attempt-example-1']);
    });

    it(`lease windows never exceed LANE_RUN_LEASE_MAX_MS (${LANE_RUN_LEASE_MAX_MS} ms)`, async () => {
      const port = createPort();
      await port.create(validRun());
      const runId = 'run-01JB0000000000000000000000';
      const beyond = new Date(Date.parse(NOW) + LANE_RUN_LEASE_MAX_MS + 1).toISOString();
      expect(
        await port.acquireLease(runId, { ...ACQUIRE, leaseUntilIso: beyond }),
      ).toEqual({ outcome: 'refused', reason: 'invalid-request' } as const);
      expect((await port.get(runId))!.lease).toBeNull();
    });
  });
}
