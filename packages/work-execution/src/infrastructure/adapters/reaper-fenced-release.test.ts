import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CapacityReservationRecord } from '../../domain/execution-records.js';
import type {
  ReleaseCapacityReservationIfUnchangedRequest,
} from '../../application/ports/out/ExecutionJournalPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { ExecutionJournalAdapter } from './ExecutionJournalAdapter.adapter.js';

function heldReservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'att-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: '2026-11-06T10:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

function fencedRequest(
  overrides: Partial<ReleaseCapacityReservationIfUnchangedRequest> = {},
): ReleaseCapacityReservationIfUnchangedRequest {
  return {
    attemptId: 'att-1',
    reservationId: 'res-1',
    attemptRevision: 3,
    releasedAtIso: '2026-11-06T11:00:00.000Z',
    readAttemptRevision: () => Promise.resolve(3),
    ...overrides,
  };
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

describe('ExecutionJournalAdapter fenced capacity release (plan §3.9.2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reaper-release-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('releases the reservation while the attempt still reads at the observed revision', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());

    const result = await adapter.releaseCapacityReservationIfUnchanged(fencedRequest());

    expect(result).toEqual({ outcome: 'released', reservationId: 'res-1' });
    const active = await adapter.listActiveReservations();
    expect(active.map((r) => r.id)).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(tempDir, 'reservations.json'), 'utf8')) as Array<{
      id: string;
      held: boolean;
      releasedAtIso: string | null;
    }>;
    const released = stored.find((r) => r.id === 'res-1');
    expect(released?.held).toBe(false);
    expect(released?.releasedAtIso).toBe('2026-11-06T11:00:00.000Z');
  });

  it('reports changed and writes nothing when the attempt revision moved', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());
    const target = path.join(tempDir, 'reservations.json');
    const before = await fileSha256(target);

    const result = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ readAttemptRevision: () => Promise.resolve(4) }),
    );

    expect(result).toEqual({ outcome: 'changed' });
    const active = await adapter.listActiveReservations();
    expect(active.map((r) => r.id)).toEqual(['res-1']);
    expect(await fileSha256(target)).toBe(before);
  });

  it('reports changed and restores the reservation when the attempt revision moves during the release', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());
    let reads = 0;

    const result = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ readAttemptRevision: () => Promise.resolve(++reads === 1 ? 3 : 4) }),
    );

    expect(result).toEqual({ outcome: 'changed' });
    const active = await adapter.listActiveReservations();
    expect(active.map((r) => r.id)).toEqual(['res-1']);
    expect(active[0]?.releasedAtIso).toBeNull();
  });

  it('stays typed in memory when a request getter throws after validation', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.saveCapacityReservation(heldReservation());
    let reads = 0;
    const request = fencedRequest();
    Object.defineProperty(request, 'attemptId', {
      enumerable: true,
      get: () => {
        if (++reads > 1) throw new Error('boom');
        return 'att-1';
      },
    });

    const result = await adapter.releaseCapacityReservationIfUnchanged(request);

    expect(result).toEqual({ outcome: 'unknown', reason: 'unreadable' });
  });

  it('refuses a request carrying an extra symbol key', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const request = { ...fencedRequest(), [Symbol('extra')]: 1 };

    await expect(adapter.releaseCapacityReservationIfUnchanged(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
  });

  it('reports changed when the observed reservation is not the held one', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());

    const result = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ reservationId: 'res-other' }),
    );

    expect(result).toEqual({ outcome: 'changed' });
    const active = await adapter.listActiveReservations();
    expect(active.map((r) => r.id)).toEqual(['res-1']);
  });

  it('is idempotent: a second fenced release finds nothing held and writes nothing', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());
    const first = await adapter.releaseCapacityReservationIfUnchanged(fencedRequest());
    expect(first).toEqual({ outcome: 'released', reservationId: 'res-1' });
    const target = path.join(tempDir, 'reservations.json');
    const before = await fileSha256(target);

    const second = await adapter.releaseCapacityReservationIfUnchanged(fencedRequest());

    expect(second).toEqual({ outcome: 'not-held' });
    expect(await fileSha256(target)).toBe(before);
  });

  it('reports unknown and holds the reservation when the attempt revision cannot be read', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());

    const result = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({
        readAttemptRevision: () => Promise.reject(new Error('attempt store unavailable')),
      }),
    );

    expect(result).toEqual({ outcome: 'unknown', reason: 'attempt-unknown' });
    const active = await adapter.listActiveReservations();
    expect(active.map((r) => r.id)).toEqual(['res-1']);
  });

  it('reports unknown when the attempt reads back as null (file backed)', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());
    const target = path.join(tempDir, 'reservations.json');
    const before = await fileSha256(target);

    const result = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ readAttemptRevision: () => Promise.resolve(null) }),
    );

    expect(result).toEqual({ outcome: 'unknown', reason: 'attempt-unknown' });
    expect((await adapter.listActiveReservations()).map((r) => r.id)).toEqual(['res-1']);
    expect(await fileSha256(target)).toBe(before);
  });

  it('reports unknown when the attempt reads back as null in memory', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.saveCapacityReservation(heldReservation({ id: 'res-mem', attemptId: 'att-mem' }));

    const result = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({
        attemptId: 'att-mem',
        reservationId: 'res-mem',
        readAttemptRevision: () => Promise.resolve(null),
      }),
    );

    expect(result).toEqual({ outcome: 'unknown', reason: 'attempt-unknown' });
    expect((await adapter.listActiveReservations()).map((r) => r.id)).toEqual(['res-mem']);
  });

  it('serialises concurrent in-memory releases so exactly one reports released', async () => {
    const signals: ChangeSignal[] = [];
    const signalPort: ChangeSignalPort = {
      emit(signal: ChangeSignal): void {
        signals.push(signal);
      },
    };
    const adapter = new ExecutionJournalAdapter({ changeSignal: signalPort });
    await adapter.saveCapacityReservation(heldReservation({ id: 'res-mem', attemptId: 'att-mem' }));
    signals.length = 0;

    // The first caller's callback is still pending when the second call starts,
    // so the second must wait for the chain instead of acting on the same held
    // reservation.
    let releaseFirst: (revision: number) => void = () => {};
    const firstGate = new Promise<number>((resolve) => {
      releaseFirst = resolve;
    });
    const first = adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({
        attemptId: 'att-mem',
        reservationId: 'res-mem',
        readAttemptRevision: () => firstGate,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Resolving the gate and issuing the second call in the same synchronous
    // block: the second call joins the per-attempt chain before the first's
    // release continuation has run, which is exactly the reported race window.
    releaseFirst(3);
    const second = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ attemptId: 'att-mem', reservationId: 'res-mem' }),
    );
    expect(second).toEqual({ outcome: 'not-held' });
    expect(await first).toEqual({ outcome: 'released', reservationId: 'res-mem' });
    expect(signals.filter((signal) => signal.kind === 'capacity').length).toBe(1);
  });

  it('retains no serialisation entry once releases of many distinct attempts settle', async () => {
    const adapter = new ExecutionJournalAdapter();
    const attempts = Array.from({ length: 16 }, (_, i) => ({
      attemptId: `att-many-${i}`,
      reservationId: `res-many-${i}`,
    }));
    for (const { attemptId, reservationId } of attempts) {
      await adapter.saveCapacityReservation(heldReservation({ id: reservationId, attemptId }));
    }
    const chains = (adapter as unknown as { fencedReleaseChainsByAttemptId: Map<string, Promise<unknown>> })
      .fencedReleaseChainsByAttemptId;

    await Promise.all(
      attempts.map(({ attemptId, reservationId }) =>
        adapter.releaseCapacityReservationIfUnchanged(fencedRequest({ attemptId, reservationId })),
      ),
    );
    // The chain cleanup runs one turn after the release settles.
    await new Promise((resolve) => setImmediate(resolve));

    expect(chains.size).toBe(0);
  });

  it('reports unknown when the reservations store is unreadable', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation(heldReservation());
    const target = path.join(tempDir, 'reservations.json');
    await fs.writeFile(target, '{ corrupt reservations', 'utf8');
    const corruptBytes = await fileSha256(target);

    const result = await adapter.releaseCapacityReservationIfUnchanged(fencedRequest());

    expect(result).toEqual({ outcome: 'unknown', reason: 'unreadable' });
    // An unreadable store is never `not-held` and never `released`: nothing
    // was written and the next pass can still complete on the same file.
    expect(await fileSha256(target)).toBe(corruptBytes);
  });

  it('refuses a malformed request without throwing', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const badInputs: Array<{ label: string; value: unknown }> = [
      { label: 'null', value: null },
      { label: 'non-object', value: 'release' },
      { label: 'sparse array', value: [] },
      { label: 'missing field', value: { attemptId: 'att-1', reservationId: 'res-1', attemptRevision: 3 } },
      {
        label: 'wrong-typed field',
        value: {
          attemptId: 'att-1',
          reservationId: 'res-1',
          attemptRevision: '3',
          releasedAtIso: '2026-11-06T11:00:00.000Z',
          readAttemptRevision: () => Promise.resolve(3),
        },
      },
      {
        label: 'unknown key',
        value: {
          attemptId: 'att-1',
          reservationId: 'res-1',
          attemptRevision: 3,
          releasedAtIso: '2026-11-06T11:00:00.000Z',
          readAttemptRevision: () => Promise.resolve(3),
          outcome: 'released',
        },
      },
      {
        label: 'getter throws',
        value: Object.defineProperties(
          {},
          {
            attemptId: {
              get() {
                throw new Error('getter refused');
              },
              enumerable: true,
            },
          },
        ),
      },
    ];

    for (const bad of badInputs) {
      const result = await adapter.releaseCapacityReservationIfUnchanged(
        bad.value as ReleaseCapacityReservationIfUnchangedRequest,
      );
      expect(result, bad.label).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
  });

  it('never echoes a path or a secret-shaped value', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const secretAttempt = fakeSecretShape();
    const refused = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ attemptId: secretAttempt }),
    );
    expect(refused).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    await adapter.saveCapacityReservation(heldReservation());
    const unknown = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({
        readAttemptRevision: () => Promise.reject(new Error(`/private/${tempDir}/secrets ${secretAttempt}`)),
      }),
    );
    expect(unknown).toEqual({ outcome: 'unknown', reason: 'attempt-unknown' });

    const serialised = JSON.stringify([refused, unknown]);
    expect(serialised).not.toContain('fleet-reaper-release-test');
    expect(serialised).not.toContain(fakeSecretShape());
    expect(serialised.startsWith('[{"outcome":')).toBe(true);
  });

  it('releases the held reservation in memory and reports changed when the attempt moved', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.saveCapacityReservation(heldReservation({ id: 'res-mem', attemptId: 'att-mem' }));

    const changed = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({
        attemptId: 'att-mem',
        reservationId: 'res-mem',
        readAttemptRevision: () => Promise.resolve(7),
      }),
    );
    expect(changed).toEqual({ outcome: 'changed' });
    expect((await adapter.listActiveReservations()).map((r) => r.id)).toEqual(['res-mem']);

    const released = await adapter.releaseCapacityReservationIfUnchanged(
      fencedRequest({ attemptId: 'att-mem', reservationId: 'res-mem' }),
    );
    expect(released).toEqual({ outcome: 'released', reservationId: 'res-mem' });
    expect((await adapter.listActiveReservations()).map((r) => r.id)).toEqual([]);
  });

  it('emits exactly one capacity change signal for a released reservation', async () => {
    const signals: ChangeSignal[] = [];
    const signalPort: ChangeSignalPort = {
      emit(signal: ChangeSignal): void {
        signals.push(signal);
      },
    };
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signalPort });
    await adapter.saveCapacityReservation(heldReservation());
    signals.length = 0;

    const released = await adapter.releaseCapacityReservationIfUnchanged(fencedRequest());
    expect(released).toEqual({ outcome: 'released', reservationId: 'res-1' });

    const capacitySignals = signals.filter((signal) => signal.kind === 'capacity');
    expect(capacitySignals.length).toBe(1);
    expect(capacitySignals[0]?.id).toBe('res-1');
  });
});
