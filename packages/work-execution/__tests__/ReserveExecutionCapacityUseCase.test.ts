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

class InMemoryJournal implements ExecutionJournalPort {
  private reservations = new Map<string, CapacityReservationRecord>();

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
    const heldOnHost = held.filter((r) => r.hostId === request.record.hostId);
    if (heldOnHost.length >= request.maxSlots) {
      return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots: request.maxSlots };
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
    });
    expect(zeroResult.outcome).toBe('refused');

    const negativeResult = await useCase.reserveExecutionCapacity({
      reservationId: 'res-2',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      hostId: 'host-1',
      worktreePath: '/tmp/worktree-1',
      maxSlots: -2,
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
    });
    expect(second.outcome).toBe('reserved');
  });
});
