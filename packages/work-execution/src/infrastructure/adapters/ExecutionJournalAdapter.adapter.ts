// @generated adapter scaffold — implemented for migration step 2 (local journal and capacity arbitration).
/**
 * ExecutionJournalAdapter implements ExecutionJournalPort
 * (local-transactional-journal-and-capacity-arbitration). Journal entries are
 * append-only evidence with duplicate ids refused; capacity reservations are
 * keyed by id and superseded per attempt so intent is durable before the
 * subprocess runs. In-memory by default, JSON-persisted via atomic
 * temp-file-then-rename writes when `stateDir` is configured.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import type { ExecutionJournalPort } from '../../application/ports/out/ExecutionJournalPort.out-port.js';

export interface ExecutionJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

let journalTempCounter = 0;

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
  private readonly journalEntries: ActionJournalEntryRecord[] = [];
  private readonly reservationsById = new Map<string, CapacityReservationRecord>();
  private loadPromise: Promise<void> | null = null;
  private journalPersistCounter = 0;
  private reservationPersistCounter = 0;

  constructor(private readonly options?: ExecutionJournalAdapterOptions) {}

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    await this.ensureLoaded();
    const duplicate = this.journalEntries.some((existing) => existing.id === entry.id);
    if (duplicate) {
      throw new Error(`Duplicate journal entry id: ${entry.id}`);
    }
    this.journalEntries.push(entry);
    await this.persistJournal();
  }

  async listJournalEntriesForAttempt(
    attemptId: string,
  ): Promise<readonly ActionJournalEntryRecord[]> {
    await this.ensureLoaded();
    return this.journalEntries.filter((entry) => entry.attemptId === attemptId);
  }

  async saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void> {
    await this.ensureLoaded();
    // A reservation supersedes any earlier reservation for the same attempt.
    for (const [id, existing] of this.reservationsById) {
      if (existing.attemptId === reservation.attemptId && id !== reservation.id) {
        this.reservationsById.delete(id);
      }
    }
    this.reservationsById.set(reservation.id, reservation);
    await this.persistReservations();
  }

  async listActiveReservations(
    hostId?: string,
  ): Promise<readonly CapacityReservationRecord[]> {
    await this.ensureLoaded();
    const held = [...this.reservationsById.values()].filter(
      (reservation) => reservation.held === true,
    );
    if (hostId === undefined) return held;
    return held.filter((reservation) => reservation.hostId === hostId);
  }

  async releaseCapacityReservation(attemptId: string, releasedAtIso: string): Promise<boolean> {
    await this.ensureLoaded();
    const held = [...this.reservationsById.values()].find(
      (reservation) => reservation.attemptId === attemptId && reservation.held === true,
    );
    if (held === undefined) return false;
    this.reservationsById.set(held.id, { ...held, held: false, releasedAtIso });
    await this.persistReservations();
    return true;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.loadFromDisk().catch((error: unknown) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) return;
    const journalFile = path.join(stateDir, 'journal.json');
    try {
      const raw = await fs.readFile(journalFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isActionJournalEntryRecord(item)) this.journalEntries.push(item);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const reservationsFile = path.join(stateDir, 'reservations.json');
    try {
      const raw = await fs.readFile(reservationsFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isCapacityReservationRecord(item)) this.reservationsById.set(item.id, item);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persistJournal(): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) return;
    const target = path.join(stateDir, 'journal.json');
    const temp = `${target}.${process.pid}-${this.journalPersistCounter++}-${journalTempCounter++}.tmp`;
    const serialized = JSON.stringify(this.journalEntries, null, 2);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      await fs.writeFile(temp, serialized, 'utf8');
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async persistReservations(): Promise<void> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) return;
    const target = path.join(stateDir, 'reservations.json');
    const temp = `${target}.${process.pid}-${this.reservationPersistCounter++}-${journalTempCounter++}.tmp`;
    const serialized = JSON.stringify([...this.reservationsById.values()], null, 2);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      await fs.writeFile(temp, serialized, 'utf8');
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
