import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import type {
  BusyWorktreeCheck,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../application/ports/out/ExecutionJournalPort.out-port.js';
import { ExecutionJournalAdapter } from './ExecutionJournalAdapter.adapter.js';

describe('ExecutionJournalAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-journal-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps both entries when two instances append to the same stateDir and refuses duplicate ids', async () => {
    const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
    const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });

    const entry1: ActionJournalEntryRecord = {
      id: 'entry-1',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'commit-1',
      status: 'intent-recorded',
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      sessionId: null,
      detail: 'first entry from A',
    };

    const entry2: ActionJournalEntryRecord = {
      id: 'entry-2',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'commit-1',
      status: 'completed',
      recordedAtIso: '2026-10-15T10:01:00.000Z',
      sessionId: null,
      detail: 'second entry from B',
    };

    // Both instances append different entries
    await Promise.all([adapterA.appendJournalEntry(entry1), adapterB.appendJournalEntry(entry2)]);

    // Both entries must survive
    const entriesFromA = await adapterA.listJournalEntriesForAttempt('att-1');
    const entriesFromB = await adapterB.listJournalEntriesForAttempt('att-1');

    expect([...entriesFromA.map((e) => e.id)].sort()).toEqual(['entry-1', 'entry-2']);
    expect([...entriesFromB.map((e) => e.id)].sort()).toEqual(['entry-1', 'entry-2']);

    // Duplicate id must be refused even when attempted by a second adapter instance
    await expect(adapterB.appendJournalEntry(entry1)).rejects.toThrow(
      'Duplicate journal entry id: entry-1',
    );
  });

  it('keeps both reservations when two instances save capacity reservations to the same stateDir', async () => {
    const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
    const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });

    const res1: CapacityReservationRecord = {
      id: 'res-1',
      attemptId: 'att-1',
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      reservedAtIso: '2026-10-15T10:00:00.000Z',
      releasedAtIso: null,
    };

    const res2: CapacityReservationRecord = {
      id: 'res-2',
      attemptId: 'att-2',
      hostId: 'host-1',
      slotIndex: 1,
      held: true,
      seatTool: 'opencode',
      reservedAtIso: '2026-10-15T10:01:00.000Z',
      releasedAtIso: null,
    };

    await Promise.all([adapterA.saveCapacityReservation(res1), adapterB.saveCapacityReservation(res2)]);

    const activeA = await adapterA.listActiveReservations();
    const activeB = await adapterB.listActiveReservations();

    expect(activeA.map((r) => r.id).sort()).toEqual(['res-1', 'res-2']);
    expect(activeB.map((r) => r.id).sort()).toEqual(['res-1', 'res-2']);

    // Releasing one reservation in adapterA is immediately visible in adapterB
    const released = await adapterA.releaseCapacityReservation('att-1', '2026-10-15T10:05:00.000Z');
    expect(released).toBe(true);

    const activeAfterRelease = await adapterB.listActiveReservations();
    expect(activeAfterRelease.map((r) => r.id)).toEqual(['res-2']);
  });

  it('throws and preserves file content when appending to a corrupt journal file', async () => {
    const filePath = path.join(tempDir, 'journal.json');
    const corruptContent = '{ corrupt journal';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const entry: ActionJournalEntryRecord = {
      id: 'entry-corrupt',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'commit-1',
      status: 'intent-recorded',
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      sessionId: null,
      detail: 'test entry',
    };

    await expect(adapter.appendJournalEntry(entry)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });

  it('throws and preserves file content when saving to a corrupt reservations file', async () => {
    const filePath = path.join(tempDir, 'reservations.json');
    const corruptContent = '{ corrupt reservations';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const res: CapacityReservationRecord = {
      id: 'res-corrupt',
      attemptId: 'att-1',
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      reservedAtIso: '2026-10-15T10:00:00.000Z',
      releasedAtIso: null,
    };

    await expect(adapter.saveCapacityReservation(res)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });

  it('reads a reservation persisted before seatTool existed with seatTool null (H8)', async () => {
    // Pre-H8 file shape: no seatTool field on the record at all.
    await fs.writeFile(
      path.join(tempDir, 'reservations.json'),
      JSON.stringify([
        {
          id: 'res-legacy',
          attemptId: 'att-legacy',
          hostId: 'host-1',
          slotIndex: 0,
          held: true,
          reservedAtIso: '2026-10-15T10:00:00.000Z',
          releasedAtIso: null,
        },
      ]),
      'utf8',
    );

    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const active = await adapter.listActiveReservations('host-1');
    expect(active.map((r) => r.id)).toEqual(['res-legacy']);
    expect(active[0]?.seatTool).toBeNull();
  });

  it('reads a pre-H9a reservation with all host fields null (H9a1)', async () => {
    // Pre-H9a file shape: seatTool present, no host fields at all.
    await fs.writeFile(
      path.join(tempDir, 'reservations.json'),
      JSON.stringify([
        {
          id: 'res-legacy-h9a',
          attemptId: 'att-legacy-h9a',
          hostId: 'host-1',
          slotIndex: 0,
          held: true,
          seatTool: 'opencode',
          reservedAtIso: '2026-10-16T10:00:00.000Z',
          releasedAtIso: null,
        },
      ]),
      'utf8',
    );

    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const active = await adapter.listActiveReservations('host-1');
    expect(active.map((r) => r.id)).toEqual(['res-legacy-h9a']);
    expect(active[0]?.hostName).toBeNull();
    expect(active[0]?.hostKind).toBeNull();
    expect(active[0]?.transport).toBeNull();
    expect(active[0]?.sshAlias).toBeNull();
    expect(active[0]?.port).toBeNull();
  });

  it('round-trips a reservation with host fields through disk (H9a1)', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    await adapter.saveCapacityReservation({
      id: 'res-host',
      attemptId: 'att-host',
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: 'lanehost',
      hostKind: 'opencode',
      transport: 'ssh',
      sshAlias: 'm',
      port: 4166,
      reservedAtIso: '2026-10-16T10:00:00.000Z',
      releasedAtIso: null,
    });

    const reloaded = new ExecutionJournalAdapter({ stateDir: tempDir });
    const active = await reloaded.listActiveReservations('host-1');
    expect(active.map((r) => r.id)).toEqual(['res-host']);
    expect(active[0]?.hostName).toBe('lanehost');
    expect(active[0]?.hostKind).toBe('opencode');
    expect(active[0]?.transport).toBe('ssh');
    expect(active[0]?.sshAlias).toBe('m');
    expect(active[0]?.port).toBe(4166);
  });
});

describe('ExecutionJournalAdapter atomic capacity arbitration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-journal-race-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeClaim(
    overrides: { id?: string; attemptId?: string; hostId?: string; maxSlots?: number } = {},
  ): ReserveCapacityAtomicallyRequest {
    const attemptId = overrides.attemptId ?? 'att-race';
    return {
      attemptId,
      maxSlots: overrides.maxSlots ?? 2,
      record: {
        id: overrides.id ?? 'res-race',
        attemptId,
        hostId: overrides.hostId ?? 'host-1',
        seatTool: 'opencode',
        held: true,
        reservedAtIso: '2026-10-15T11:00:00.000Z',
        releasedAtIso: null,
      },
    };
  }

  /**
   * Latch for reservation races, not sleeps: the reservations lock file is
   * held by the test while both claims are issued, so both are in flight
   * and already contending on the lock before either can read or write.
   * Removing the gate opens the race; the lock itself arbitrates the rest.
   */
  async function raceUnderReservationsGate<T>(
    issue: () => Promise<T>,
  ): Promise<T> {
    const lockPath = path.join(tempDir, 'reservations.json.lock');
    await fs.writeFile(lockPath, 'race-gate-held-by-test', 'utf8');
    const racing = issue();
    await fs.rm(lockPath, { force: true });
    return await racing;
  }

  async function readPersistedReservations(): Promise<CapacityReservationRecord[]> {
    const raw = await fs.readFile(path.join(tempDir, 'reservations.json'), 'utf8');
    return JSON.parse(raw) as CapacityReservationRecord[];
  }

  it('lets exactly one of two racing claims for the same attempt reserve', async () => {
    const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
    const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });

    const [fromA, fromB] = await raceUnderReservationsGate(() =>
      Promise.all([
        adapterA.reserveCapacityAtomically(makeClaim({ id: 'res-race-a' })),
        adapterB.reserveCapacityAtomically(makeClaim({ id: 'res-race-b' })),
      ]),
    );

    const results: ReserveCapacityAtomicallyResult[] = [fromA, fromB];
    const reserved = results.filter((result) => result.outcome === 'reserved');
    const refused = results.filter((result) => result.outcome === 'duplicate-attempt');
    expect(reserved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    if (reserved[0]?.outcome !== 'reserved' || refused[0]?.outcome !== 'duplicate-attempt') {
      throw new Error('expected exactly one reserved and one duplicate-attempt result');
    }

    // The refusal names the claim that won, and exactly one reservation —
    // the winner's, never both — is durable for the attempt.
    const persisted = await readPersistedReservations();
    expect(persisted.map((reservation) => reservation.attemptId)).toEqual(['att-race']);
    expect(reserved[0].reservation.id).toBe(persisted[0]?.id);
    expect(refused[0].existingReservationId).toBe(persisted[0]?.id);

    // The losing claim wrote nothing: the file still holds one record only.
    expect(await adapterB.listActiveReservations('host-1')).toHaveLength(1);
  });

  it('lets exactly one of two attempts racing for the last slot reserve', async () => {
    const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
    const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });

    // One slot of the host's budget of two is already held.
    const seeded = await adapterA.reserveCapacityAtomically(
      makeClaim({ id: 'res-held', attemptId: 'att-held' }),
    );
    expect(seeded.outcome).toBe('reserved');

    const [fromA, fromB] = await raceUnderReservationsGate(() =>
      Promise.all([
        adapterA.reserveCapacityAtomically(
          makeClaim({ id: 'res-last-a', attemptId: 'att-last-a' }),
        ),
        adapterB.reserveCapacityAtomically(
          makeClaim({ id: 'res-last-b', attemptId: 'att-last-b' }),
        ),
      ]),
    );

    const results: ReserveCapacityAtomicallyResult[] = [fromA, fromB];
    const reserved = results.filter((result) => result.outcome === 'reserved');
    const refused = results.filter((result) => result.outcome === 'no-free-slot');
    expect(reserved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    if (reserved[0]?.outcome !== 'reserved' || refused[0]?.outcome !== 'no-free-slot') {
      throw new Error('expected exactly one reserved and one no-free-slot result');
    }
    expect(refused[0].heldCount).toBe(2);
    expect(refused[0].maxSlots).toBe(2);

    // The budget is exactly full, the two held slots are distinct, and the
    // losing attempt wrote nothing.
    const persisted = await readPersistedReservations();
    expect(persisted).toHaveLength(2);
    expect(persisted.every((reservation) => reservation.held)).toBe(true);
    expect(new Set(persisted.map((reservation) => reservation.slotIndex)).size).toBe(2);
    expect(persisted.map((reservation) => reservation.attemptId).sort()).toEqual(
      ['att-held', reserved[0].reservation.attemptId].sort(),
    );
  });

  it('refuses sequentially to supersede a held reservation for the same attempt and preserves the file', async () => {
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const first = await adapter.reserveCapacityAtomically(makeClaim({ id: 'res-first' }));
    expect(first.outcome).toBe('reserved');

    await expect(
      adapter.saveCapacityReservation({
        id: 'res-second',
        attemptId: 'att-race',
        hostId: 'host-1',
        slotIndex: 1,
        held: true,
        seatTool: 'opencode',
        reservedAtIso: '2026-10-15T11:01:00.000Z',
        releasedAtIso: null,
      }),
    ).rejects.toThrow(
      'ExecutionJournalAdapter refuses to supersede held reservation res-first of attempt att-race',
    );

    // A second claim through the atomic path is refused too — never superseded.
    const duplicate = await adapter.reserveCapacityAtomically(
      makeClaim({ id: 'res-second' }),
    );
    expect(duplicate).toEqual({
      outcome: 'duplicate-attempt',
      attemptId: 'att-race',
      existingReservationId: 'res-first',
    });

    const persisted = await readPersistedReservations();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe('res-first');
  });
});

describe('ExecutionJournalAdapter in-memory atomic capacity arbitration', () => {
  function makeClaim(
    overrides: { id?: string; attemptId?: string } = {},
  ): ReserveCapacityAtomicallyRequest {
    const attemptId = overrides.attemptId ?? 'att-mem-race';
    return {
      attemptId,
      maxSlots: 2,
      record: {
        id: overrides.id ?? 'res-mem-race',
        attemptId,
        hostId: 'host-1',
        seatTool: 'opencode',
        held: true,
        reservedAtIso: '2026-10-15T11:00:00.000Z',
        releasedAtIso: null,
      },
    };
  }

  /** A not-busy verdict that still yields, widening the race window. */
  const notBusy = async (): Promise<BusyWorktreeCheck> => ({ outcome: 'ok' });

  it('lets exactly one of two same-process racing claims reserve', async () => {
    const adapter = new ExecutionJournalAdapter({});
    const results = await Promise.all([
      adapter.reserveCapacityAtomically(makeClaim({ id: 'res-mem-a' })),
      adapter.reserveCapacityAtomically(makeClaim({ id: 'res-mem-b' })),
    ]);
    const reserved = results.filter((result) => result.outcome === 'reserved');
    const refused = results.filter((result) => result.outcome === 'duplicate-attempt');
    expect(reserved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await adapter.listActiveReservations('host-1')).toHaveLength(1);
  });

  it('lets exactly one of two same-process racing claims reserve across the busy-check await', async () => {
    const adapter = new ExecutionJournalAdapter({});
    const results = await Promise.all([
      adapter.reserveCapacityAtomically({ ...makeClaim({ id: 'res-mem-a' }), checkBusyWorktree: notBusy }),
      adapter.reserveCapacityAtomically({ ...makeClaim({ id: 'res-mem-b' }), checkBusyWorktree: notBusy }),
    ]);
    const reserved = results.filter((result) => result.outcome === 'reserved');
    const refused = results.filter((result) => result.outcome === 'duplicate-attempt');
    expect(reserved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await adapter.listActiveReservations('host-1')).toHaveLength(1);
  });

  // H9a fix (review): with the in-lock `selectRecord` the same exclusion must
  // hold — two concurrent reserves fighting for the last slot on a host yield
  // exactly one `reserved`, never two reservations on a one-slot host.
  it('gives exactly one reserved when two concurrent selectRecord claims race for the last slot', async () => {
    const adapter = new ExecutionJournalAdapter({});
    const makeSelectClaim = (overrides: { id?: string; attemptId?: string } = {}) => {
      const attemptId = overrides.attemptId ?? 'att-mem-select';
      const request: ReserveCapacityAtomicallyRequest = {
        attemptId,
        selectRecord: async (held) => {
          const heldOnHost = held.filter((reservation) => reservation.held && (reservation.hostName ?? reservation.hostId) === 'host-solo');
          if (heldOnHost.length >= 1) {
            return { outcome: 'no-capacity' as const };
          }
          return {
            outcome: 'selected' as const,
            maxSlots: 1,
            record: {
              id: overrides.id ?? 'res-mem-select',
              attemptId,
              hostId: 'host-solo',
              hostName: 'host-solo',
              hostKind: 'opencode' as const,
              transport: 'local' as const,
              sshAlias: null,
              port: null,
              worktreePath: `/srv/worktrees/${attemptId}`,
              seatTool: 'opencode' as const,
              held: true,
              reservedAtIso: '2026-10-15T11:00:00.000Z',
              releasedAtIso: null,
            },
          };
        },
      };
      return request;
    };
    const results = await Promise.all([
      adapter.reserveCapacityAtomically(makeSelectClaim({ id: 'res-sel-a', attemptId: 'att-sel-a' })),
      adapter.reserveCapacityAtomically(makeSelectClaim({ id: 'res-sel-b', attemptId: 'att-sel-b' })),
    ]);
    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(['no-capacity', 'reserved']);
    expect(
      (await adapter.listActiveReservations('host-solo')).map((reservation) => reservation.id).sort(),
    ).toHaveLength(1);
  });
});
