// @generated adapter scaffold — implemented for migration step 2 (local journal and capacity arbitration).
/**
 * ExecutionJournalAdapter implements ExecutionJournalPort
 * (local-transactional-journal-and-capacity-arbitration). Journal entries are
 * append-only evidence with duplicate ids refused; capacity reservations are
 * keyed by id and superseded per attempt so intent is durable before the
 * subprocess runs. In-memory by default, JSON-persisted via atomic
 * temp-file-then-rename writes under exclusive locks when `stateDir` is configured.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import type { ExecutionJournalPort } from '../../application/ports/out/ExecutionJournalPort.out-port.js';
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
      for (const [id, existing] of this.inMemoryReservationsById) {
        if (existing.attemptId === reservation.attemptId && id !== reservation.id) {
          this.inMemoryReservationsById.delete(id);
        }
      }
      this.inMemoryReservationsById.set(reservation.id, reservation);
      return;
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    await withFileLock(lockPath, async () => {
      const reservations = await this.readReservationsFromDisk(target);
      // A reservation supersedes any earlier reservation for the same attempt.
      for (const [id, existing] of reservations) {
        if (existing.attemptId === reservation.attemptId && id !== reservation.id) {
          reservations.delete(id);
        }
      }
      reservations.set(reservation.id, reservation);
      await writeJsonAtomically(target, [...reservations.values()]);
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
