// @generated adapter scaffold — implemented for migration step 2 (local journal and capacity arbitration).
/**
 * ExecutionJournalAdapter implements ExecutionJournalPort
 * (local-transactional-journal-and-capacity-arbitration). Journal entries are
 * append-only evidence with duplicate ids refused; capacity reservations are
 * keyed by id and never superseded: a held claim by an attempt that already
 * holds one is refused, and slot arbitration happens inside the reservations
 * lock through a single read-modify-write. In-memory by default, JSON-persisted
 * via atomic temp-file-then-rename writes under exclusive locks when `stateDir`
 * is configured.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../application/ports/out/ExecutionJournalPort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

export interface ExecutionJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

function isActionJournalEntryRecord(value: unknown): value is ActionJournalEntryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.attemptId === 'string';
}

function isCapacityReservationRecord(value: unknown): value is CapacityReservationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.attemptId === 'string';
}

/**
 * One locked read-modify-write decision over the freshly read held
 * reservations: a claim by an attempt that already holds one is refused, a
 * claim over the host's budget is refused, and only a passing claim is
 * assigned the lowest free slot index. Nothing is ever superseded.
 */
function arbitrateReservation(
  request: ReserveCapacityAtomicallyRequest,
  held: readonly CapacityReservationRecord[],
): ReserveCapacityAtomicallyResult {
  const duplicate = held.find((reservation) => reservation.attemptId === request.attemptId);
  if (duplicate !== undefined) {
    return {
      outcome: 'duplicate-attempt',
      attemptId: request.attemptId,
      existingReservationId: duplicate.id,
    };
  }
  const heldOnHost = held.filter(
    (reservation) => reservation.hostId === request.record.hostId,
  );
  if (heldOnHost.length >= request.maxSlots) {
    return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots: request.maxSlots };
  }
  const usedSlots = new Set(heldOnHost.map((reservation) => reservation.slotIndex));
  let slotIndex = 0;
  while (usedSlots.has(slotIndex)) {
    slotIndex += 1;
  }
  return { outcome: 'reserved', reservation: { ...request.record, slotIndex } };
}

export class ExecutionJournalAdapter implements ExecutionJournalPort {
  private readonly inMemoryJournalEntries: ActionJournalEntryRecord[] = [];
  private readonly inMemoryReservationsById = new Map<string, CapacityReservationRecord>();

  constructor(private readonly options?: ExecutionJournalAdapterOptions) {}

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const duplicate = this.inMemoryJournalEntries.some((existing) => existing.id === entry.id);
      if (duplicate) {
        throw new Error(`Duplicate journal entry id: ${entry.id}`);
      }
      this.inMemoryJournalEntries.push(entry);
      return;
    }

    const target = path.join(stateDir, 'journal.json');
    const lockPath = path.join(stateDir, 'journal.json.lock');

    await withFileLock(lockPath, async () => {
      const entries = await this.readJournalFromDisk(target);
      const duplicate = entries.some((existing) => existing.id === entry.id);
      if (duplicate) {
        throw new Error(`Duplicate journal entry id: ${entry.id}`);
      }
      entries.push(entry);
      await writeJsonAtomically(target, entries);
    });
  }

  async listJournalEntriesForAttempt(
    attemptId: string,
  ): Promise<readonly ActionJournalEntryRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryJournalEntries.filter((entry) => entry.attemptId === attemptId);
    }
    const target = path.join(stateDir, 'journal.json');
    const entries = await this.readJournalFromDisk(target);
    return entries.filter((entry) => entry.attemptId === attemptId);
  }

  async saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      refuseSupersedingReservation(this.inMemoryReservationsById, reservation);
      this.inMemoryReservationsById.set(reservation.id, reservation);
      return;
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    await withFileLock(lockPath, async () => {
      const reservations = await this.readReservationsFromDisk(target);
      refuseSupersedingReservation(reservations, reservation);
      reservations.set(reservation.id, reservation);
      await writeJsonAtomically(target, [...reservations.values()]);
    });
  }

  async reserveCapacityAtomically(
    request: ReserveCapacityAtomicallyRequest,
  ): Promise<ReserveCapacityAtomicallyResult> {
    /** Busy-worktree verdict, decided under the lock when a check is supplied. */
    const busyUnderLock = async (
      held: readonly CapacityReservationRecord[],
    ): Promise<ReserveCapacityAtomicallyResult | null> => {
      if (request.checkBusyWorktree === undefined) {
        return null;
      }
      const verdict = await request.checkBusyWorktree(held);
      return verdict.outcome === 'busy-worktree'
        ? { outcome: 'busy-worktree', blockingAttemptId: verdict.blockingAttemptId }
        : null;
    };

    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      // In-memory branch: the busy-worktree verdict is re-run whenever the
      // held set changed while the check was in flight, and the final
      // check-and-append is synchronous (no await between re-reading the
      // held reservations and appending), so two same-process claims can
      // never both observe the same empty reservation set (as on main).
      for (;;) {
        const held = [...this.inMemoryReservationsById.values()].filter(
          (reservation) => reservation.held === true,
        );
        const busy = await busyUnderLock(held);
        if (busy !== null) {
          return busy;
        }
        const fresh = [...this.inMemoryReservationsById.values()].filter(
          (reservation) => reservation.held === true,
        );
        if (
          request.checkBusyWorktree !== undefined &&
          (fresh.length !== held.length ||
            fresh.some((reservation) => !held.includes(reservation)))
        ) {
          continue;
        }
        const result = arbitrateReservation(request, fresh);
        if (result.outcome === 'reserved') {
          this.inMemoryReservationsById.set(result.reservation.id, result.reservation);
        }
        return result;
      }
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    return await withFileLock(lockPath, async () => {
      const reservations = await this.readReservationsFromDisk(target);
      const held = [...reservations.values()].filter(
        (reservation) => reservation.held === true,
      );
      const busy = await busyUnderLock(held);
      if (busy !== null) {
        return busy;
      }
      const result = arbitrateReservation(request, held);
      if (result.outcome === 'reserved') {
        reservations.set(result.reservation.id, result.reservation);
        await writeJsonAtomically(target, [...reservations.values()]);
      }
      return result;
    });
  }

  async listActiveReservations(
    hostId?: string,
  ): Promise<readonly CapacityReservationRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const held = [...this.inMemoryReservationsById.values()].filter(
        (reservation) => reservation.held === true,
      );
      if (hostId === undefined) return held;
      return held.filter((reservation) => reservation.hostId === hostId);
    }
    const target = path.join(stateDir, 'reservations.json');
    const reservations = await this.readReservationsFromDisk(target);
    const held = [...reservations.values()].filter(
      (reservation) => reservation.held === true,
    );
    if (hostId === undefined) return held;
    return held.filter((reservation) => reservation.hostId === hostId);
  }

  async releaseCapacityReservation(attemptId: string, releasedAtIso: string): Promise<boolean> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const held = [...this.inMemoryReservationsById.values()].find(
        (reservation) => reservation.attemptId === attemptId && reservation.held === true,
      );
      if (held === undefined) return false;
      this.inMemoryReservationsById.set(held.id, { ...held, held: false, releasedAtIso });
      return true;
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    return await withFileLock(lockPath, async () => {
      const reservations = await this.readReservationsFromDisk(target);
      const held = [...reservations.values()].find(
        (reservation) => reservation.attemptId === attemptId && reservation.held === true,
      );
      if (held === undefined) return false;
      reservations.set(held.id, { ...held, held: false, releasedAtIso });
      await writeJsonAtomically(target, [...reservations.values()]);
      return true;
    });
  }

  private async readJournalFromDisk(target: string): Promise<ActionJournalEntryRecord[]> {
    const entries: ActionJournalEntryRecord[] = [];
    let raw: string;
    try {
      raw = await fs.readFile(target, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return entries;
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`ExecutionJournalAdapter expects a record list in ${target}`);
    }
    for (const item of parsed) {
      if (isActionJournalEntryRecord(item)) entries.push(item);
    }
    return entries;
  }

  private async readReservationsFromDisk(target: string): Promise<Map<string, CapacityReservationRecord>> {
    const map = new Map<string, CapacityReservationRecord>();
    let raw: string;
    try {
      raw = await fs.readFile(target, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return map;
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`ExecutionJournalAdapter expects a record list in ${target}`);
    }
    for (const item of parsed) {
      if (isCapacityReservationRecord(item)) map.set(item.id, item);
    }
    return map;
  }
}

/**
 * A held reservation never silently replaces another reservation for the
 * same attempt: saving one under a different id is refused while the earlier
 * claim is still held, so the caller must reconcile or release it first.
 */
function refuseSupersedingReservation(
  reservations: ReadonlyMap<string, CapacityReservationRecord>,
  reservation: CapacityReservationRecord,
): void {
  if (reservation.held !== true) {
    return;
  }
  for (const [id, existing] of reservations) {
    if (
      existing.attemptId === reservation.attemptId &&
      id !== reservation.id &&
      existing.held === true
    ) {
      throw new Error(
        `ExecutionJournalAdapter refuses to supersede held reservation ${id} of attempt ${reservation.attemptId}`,
      );
    }
  }
}
