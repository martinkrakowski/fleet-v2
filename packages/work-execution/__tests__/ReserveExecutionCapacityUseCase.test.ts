import { describe, expect, it } from 'vitest';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
} from '../src/domain/execution-records.js';
import type { AttemptRepositoryPort } from '../src/application/ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../src/application/ports/out/ExecutionJournalPort.out-port.js';
import { ReserveExecutionCapacityUseCase } from '../src/application/use-cases/ReserveExecutionCapacityUseCase.use-case.js';
import type { ReserveExecutionCapacityRequest } from '../src/application/ports/in/ReserveExecutionCapacityPort.in-port.js';

class InMemoryJournal implements ExecutionJournalPort {
  readonly reservations = new Map<string, CapacityReservationRecord>();

  async appendJournalEntry(_entry: ActionJournalEntryRecord): Promise<void> {}
  async listJournalEntriesForAttempt(_attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    return [];
  }

  async saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }

  async listActiveReservations(hostId?: string): Promise<readonly CapacityReservationRecord[]> {
    const active = Array.from(this.reservations.values()).filter((r) => r.held);
    if (hostId !== undefined) {
      return active.filter((r) => r.hostId === hostId);
    }
    return active;
  }

  async releaseCapacityReservation(attemptId: string, releasedAtIso: string): Promise<boolean> {
    for (const [id, r] of this.reservations) {
      if (r.attemptId === attemptId && r.held) {
        this.reservations.set(id, { ...r, held: false, releasedAtIso });
        return true;
      }
    }
    return false;
  }

  /** Mirrors the adapter's locked arbitration: duplicate, budget, then lowest free slot. */
  async reserveCapacityAtomically(
    request: ReserveCapacityAtomicallyRequest,
  ): Promise<ReserveCapacityAtomicallyResult> {
    const held = Array.from(this.reservations.values()).filter((r) => r.held);
    const duplicate = held.find((r) => r.attemptId === request.attemptId);
    if (duplicate !== undefined) {
      return {
        outcome: 'duplicate-attempt',
        attemptId: request.attemptId,
        existingReservationId: duplicate.id,
      };
    }
    const heldOnHost = held.filter((r) => r.hostId === request.record?.hostId);
    const maxSlots = request.maxSlots ?? 0;
    if (heldOnHost.length >= maxSlots) {
      return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots };
    }
    const usedSlots = new Set(heldOnHost.map((r) => r.slotIndex));
    let slotIndex = 0;
    while (usedSlots.has(slotIndex)) {
      slotIndex += 1;
    }
    const reservation: CapacityReservationRecord = { ...request.record, slotIndex };
    this.reservations.set(reservation.id, reservation);
    return { outcome: 'reserved', reservation };
  }
}

class InMemoryAttemptRepo implements AttemptRepositoryPort {
  private attempts = new Map<string, AttemptRecord>();

  async findAttemptById(id: string): Promise<AttemptRecord | null> {
    return this.attempts.get(id) ?? null;
  }
  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.attempts.set(record.id, record);
  }
  async listAttemptsByWorkOrder(_workOrderId: string): Promise<readonly AttemptRecord[]> {
    return [];
  }
  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return Array.from(this.attempts.values());
  }
}

describe('ReserveExecutionCapacityUseCase (Appendix A)', () => {
  it('refuses non-integer maxSlots', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const result = await useCase.reserveExecutionCapacity({
      reservationId: 'res-1',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: 1.5,
      seatTool: 'opencode',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('positive integer');
    }
  });

  it('refuses non-positive maxSlots', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const zeroResult = await useCase.reserveExecutionCapacity({
      reservationId: 'res-1',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: 0,
      seatTool: 'opencode',
    });
    expect(zeroResult.outcome).toBe('refused');

    const negativeResult = await useCase.reserveExecutionCapacity({
      reservationId: 'res-2',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: -2,
      seatTool: 'opencode',
    });
    expect(negativeResult.outcome).toBe('refused');
  });

  it('refuses a second reservation for the same attempt', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    // First reservation succeeds
    const first = await useCase.reserveExecutionCapacity({
      reservationId: 'res-first',
      attemptId: 'att-same-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: 2,
      seatTool: 'opencode',
    });
    expect(first.outcome).toBe('reserved');

    // Second reservation for the same attempt on same host must be refused
    const second = await useCase.reserveExecutionCapacity({
      reservationId: 'res-second',
      attemptId: 'att-same-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-2',
      maxSlots: 2,
      seatTool: 'opencode',
    });
    expect(second.outcome).toBe('refused');
    if (second.outcome === 'refused') {
      expect(second.reason).toContain('att-same-1 already holds an active capacity reservation');
    }

    // Second reservation for the same attempt on different host must also be refused
    const differentHost = await useCase.reserveExecutionCapacity({
      reservationId: 'res-third',
      attemptId: 'att-same-1',
      workOrderId: 'wo-1',
      hostId: 'host-2',
      worktreePath: '/tmp/worktree-3',
      maxSlots: 2,
      seatTool: 'opencode',
    });
    expect(differentHost.outcome).toBe('refused');
    if (differentHost.outcome === 'refused') {
      expect(differentHost.reason).toContain('att-same-1 already holds an active capacity reservation');
    }
  });

  it('allows reservation after earlier reservation is released', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    // First reservation
    const first = await useCase.reserveExecutionCapacity({
      reservationId: 'res-rel-1',
      attemptId: 'att-rel-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: 2,
      seatTool: 'opencode',
    });
    expect(first.outcome).toBe('reserved');

    // Release the reservation
    await journal.releaseCapacityReservation('att-rel-1', '2026-10-15T11:00:00Z');

    // Now another reservation can be created for the same attempt
    const second = await useCase.reserveExecutionCapacity({
      reservationId: 'res-rel-2',
      attemptId: 'att-rel-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: 2,
      seatTool: 'opencode',
    });
    expect(second.outcome).toBe('reserved');
  });

  // --- H9a1: the reservation records the lane-runner host -----------------

  function baseRequest(
    overrides: Partial<ReserveExecutionCapacityRequest> = {},
  ) {
    return {
      reservationId: 'res-host',
      attemptId: 'att-host',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: 2,
      seatTool: 'opencode' as const,
      ...overrides,
    };
  }

  it('records the host fields on the reservation when a host is given (H9a1)', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const result = await useCase.reserveExecutionCapacity(
      baseRequest({
        host: {
          hostName: 'midnight',
          hostKind: 'opencode',
          transport: 'ssh',
          sshAlias: 'm',
          port: 4166,
        },
      }) as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') throw new Error('expected a reservation');
    expect(result.reservation.hostName).toBe('midnight');
    expect(result.reservation.hostKind).toBe('opencode');
    expect(result.reservation.transport).toBe('ssh');
    expect(result.reservation.sshAlias).toBe('m');
    expect(result.reservation.port).toBe(4166);
    // The claim is also recorded in the journal's durable record.
    expect(journal.reservations.get('res-host')).toMatchObject({
      hostName: 'midnight',
      hostKind: 'opencode',
      transport: 'ssh',
      sshAlias: 'm',
      port: 4166,
    });
  });

  it('records null host fields when no host is given (H9a1)', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const result = await useCase.reserveExecutionCapacity(
      baseRequest() as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
    );
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') throw new Error('expected a reservation');
    expect(result.reservation.hostName).toBeNull();
    expect(result.reservation.hostKind).toBeNull();
    expect(result.reservation.transport).toBeNull();
    expect(result.reservation.sshAlias).toBeNull();
    expect(result.reservation.port).toBeNull();
  });

  it('refuses malformed host objects with a reason naming the field (H9a1)', async () => {
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new ReserveExecutionCapacityUseCase({ journal, attemptRepo });

    const cases: readonly [unknown, string][] = [
      [42, 'host must be an object'],
      [{ hostName: '   ', hostKind: 'opencode', transport: 'local', sshAlias: null, port: null }, 'host.hostName must be a non-empty string'],
      [{ hostName: 'm', hostKind: 'claude', transport: 'local', sshAlias: null, port: null }, 'host.hostKind must be a declared runner kind (opencode or agy)'],
      [{ hostName: 'm', hostKind: 'opencode', transport: 'teleport', sshAlias: null, port: null }, 'host.transport must be "local" or "ssh"'],
      [{ hostName: 'm', hostKind: 'opencode', transport: 'ssh', sshAlias: null, port: null }, 'host.sshAlias is required when host.transport is "ssh"'],
      [{ hostName: 'm', hostKind: 'opencode', transport: 'ssh', sshAlias: 'm', port: 0 }, 'host.port must be a positive integer or null'],
      [{ hostName: 'm', hostKind: 'opencode', transport: 'local', sshAlias: null, port: 1.5 }, 'host.port must be a positive integer or null'],
    ];
    for (const [host, reason] of cases) {
      const result = await useCase.reserveExecutionCapacity(
        baseRequest({ host: host as never }) as Parameters<ReserveExecutionCapacityUseCase['reserveExecutionCapacity']>[0],
      );
      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') {
        expect(result.reason).toBe(reason);
      }
    }
    // Nothing was recorded by a refused request.
    expect(journal.reservations.size).toBe(0);
  });
});
