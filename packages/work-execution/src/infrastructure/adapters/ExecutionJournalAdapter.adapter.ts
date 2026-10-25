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
import { parseSeatTool } from '../../domain/execution-records.js';
import type {
  CapacityReservationClaim,
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
  SelectRecordUnderLockVerdict,
} from '../../application/ports/out/ExecutionJournalPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import { inspectRecordListBytes, quarantineUnreadable, withFileLock, writeJsonAtomically } from './file-store.js';

export interface ExecutionJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
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

/** The journal reader's record parser, shared with `fleet-v2 state check`. */
export function parseJournalEntryStateRecord(raw: unknown): ActionJournalEntryRecord | undefined {
  return isActionJournalEntryRecord(raw) ? raw : undefined;
}

function isNonEmptyStringField(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The reservation reader's record parser, shared with `fleet-v2 state check`. */
export function parseReservationStateRecord(raw: unknown): CapacityReservationRecord | undefined {
  if (!isCapacityReservationRecord(raw)) return undefined;
  const item = raw;
  return {
    ...item,
    // A reservation stored before `seatTool` existed reads with `null`;
    // it is never defaulted to a declared kind. The host fields (H9a1)
    // read the same way: absent or malformed values read as `null`.
    seatTool: parseSeatTool(item.seatTool) ?? null,
    hostName: isNonEmptyStringField(item.hostName) ? item.hostName : null,
    hostKind: parseSeatTool(item.hostKind) ?? null,
    transport:
      item.transport === 'local' || item.transport === 'ssh'
        ? item.transport
        : null,
    sshAlias: isNonEmptyStringField(item.sshAlias) ? item.sshAlias : null,
    port:
      typeof item.port === 'number' &&
      Number.isInteger(item.port) &&
      item.port > 0
        ? item.port
        : null,
    // The claimed worktree path (H9a2) reads the same way: absent or
    // malformed values read as `null`.
    worktreePath: isNonEmptyStringField(item.worktreePath) ? item.worktreePath : null,
  };
}

/**
 * One locked read-modify-write decision over the freshly read held
 * reservations: a claim by an attempt that already holds one is refused, a
 * claim over the host's budget is refused, and only a passing claim is
 * assigned the lowest free slot index. Nothing is ever superseded. The claim
 * and its host's budget are either the request's own (legacy) or the ones an
 * in-lock `selectRecord` chose (H9a2).
 */
function arbitrateReservation(
  attemptId: string,
  claim: CapacityReservationClaim,
  maxSlots: number,
  held: readonly CapacityReservationRecord[],
): ReserveCapacityAtomicallyResult {
  const duplicate = held.find((reservation) => reservation.attemptId === attemptId);
  if (duplicate !== undefined) {
    return {
      outcome: 'duplicate-attempt',
      attemptId,
      existingReservationId: duplicate.id,
    };
  }
  const heldOnHost = held.filter(
    (reservation) => reservation.hostId === claim.hostId,
  );
  if (heldOnHost.length >= maxSlots) {
    return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots };
  }
  const usedSlots = new Set(heldOnHost.map((reservation) => reservation.slotIndex));
  let slotIndex = 0;
  while (usedSlots.has(slotIndex)) {
    slotIndex += 1;
  }
  return { outcome: 'reserved', reservation: { ...claim, slotIndex } };
}

export class ExecutionJournalAdapter implements ExecutionJournalPort {
  private readonly inMemoryJournalEntries: ActionJournalEntryRecord[] = [];
  private readonly inMemoryReservationsById = new Map<string, CapacityReservationRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options?: ExecutionJournalAdapterOptions) {
    this.changeSignal = options?.changeSignal ?? new NoopChangeSignalAdapter();
  }

  get signalEmitFailures(): number {
    return this.signalEmitFailuresCount;
  }

  private signal(sig: ChangeSignal): void {
    try {
      this.changeSignal.emit(sig);
    } catch {
      this.signalEmitFailuresCount += 1;
    }
  }

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
      this.signal({ kind: 'capacity', id: reservation.id, stateFile: null, before: null, written: null });
      return;
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    await withFileLock(lockPath, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const reservations = await this.readReservationsFromDisk(target);
      refuseSupersedingReservation(reservations, reservation);
      reservations.set(reservation.id, reservation);
      await writeJsonAtomically(target, [...reservations.values()]);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    this.signal({
      kind: 'capacity',
      id: reservation.id,
      stateFile: path.resolve(target),
      before,
      written,
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

    /**
     * In-lock record selection (H9a2): without a selector the request's own
     * claim and budget arbitrate; with one, the selector decides under the
     * lock on the freshly read held reservations. A `no-capacity` or refused
     * verdict ends the claim without writing.
     */
    const selectUnderLock = async (
      held: readonly CapacityReservationRecord[],
    ): Promise<SelectRecordUnderLockVerdict> => {
      if (request.selectRecord === undefined) {
        if (request.record === undefined || request.maxSlots === undefined) {
          throw new Error(
            'reserveCapacityAtomically requires record and maxSlots when selectRecord is not supplied',
          );
        }
        return { outcome: 'selected', record: request.record, maxSlots: request.maxSlots };
      }
      return await request.selectRecord(held);
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
        const chosen = await selectUnderLock(held);
        if (chosen.outcome !== 'selected') {
          return chosen;
        }
        const busy = await busyUnderLock(held);
        if (busy !== null) {
          return busy;
        }
        const fresh = [...this.inMemoryReservationsById.values()].filter(
          (reservation) => reservation.held === true,
        );
        if (
          (request.checkBusyWorktree !== undefined || request.selectRecord !== undefined) &&
          (fresh.length !== held.length ||
            fresh.some((reservation) => !held.includes(reservation)))
        ) {
          continue;
        }
        const result = arbitrateReservation(
          request.attemptId,
          chosen.record,
          chosen.maxSlots,
          fresh,
        );
        if (result.outcome === 'reserved') {
          this.inMemoryReservationsById.set(result.reservation.id, result.reservation);
          this.signal({
            kind: 'capacity',
            id: result.reservation.id,
            stateFile: null,
            before: null,
            written: null,
          });
        }
        return result;
      }
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    const result = await withFileLock(lockPath, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const reservations = await this.readReservationsFromDisk(target);
      const held = [...reservations.values()].filter(
        (reservation) => reservation.held === true,
      );
      const chosen = await selectUnderLock(held);
      if (chosen.outcome !== 'selected') {
        return chosen;
      }
      const busy = await busyUnderLock(held);
      if (busy !== null) {
        return busy;
      }
      const chose = arbitrateReservation(request.attemptId, chosen.record, chosen.maxSlots, held);
      if (chose.outcome === 'reserved') {
        reservations.set(chose.reservation.id, chose.reservation);
        await writeJsonAtomically(target, [...reservations.values()]);
        try {
          const stat = await fs.stat(target);
          written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
        } catch {
          written = null;
        }
      }
      return chose;
    });

    if (result.outcome === 'reserved') {
      this.signal({
        kind: 'capacity',
        id: result.reservation.id,
        stateFile: path.resolve(target),
        before,
        written,
      });
    }
    return result;
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
      this.signal({ kind: 'capacity', id: held.id, stateFile: null, before: null, written: null });
      return true;
    }

    const target = path.join(stateDir, 'reservations.json');
    const lockPath = path.join(stateDir, 'reservations.json.lock');

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;
    let releasedId: string | null = null;

    const released = await withFileLock(lockPath, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const reservations = await this.readReservationsFromDisk(target);
      const held = [...reservations.values()].find(
        (reservation) => reservation.attemptId === attemptId && reservation.held === true,
      );
      if (held === undefined) return false;
      reservations.set(held.id, { ...held, held: false, releasedAtIso });
      await writeJsonAtomically(target, [...reservations.values()]);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
      releasedId = held.id;
      return true;
    });

    if (released && releasedId !== null) {
      this.signal({
        kind: 'capacity',
        id: releasedId,
        stateFile: path.resolve(target),
        before,
        written,
      });
    }
    return released;
  }

  private async readJournalFromDisk(target: string): Promise<ActionJournalEntryRecord[]> {
    const entries: ActionJournalEntryRecord[] = [];
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
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
    const inspection = inspectRecordListBytes(buffer, parseJournalEntryStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(target, inspection.detail, buffer);
    }
    return [...inspection.records];
  }

  private async readReservationsFromDisk(target: string): Promise<Map<string, CapacityReservationRecord>> {
    const map = new Map<string, CapacityReservationRecord>();
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
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
    const inspection = inspectRecordListBytes(buffer, parseReservationStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(target, inspection.detail, buffer);
    }
    for (const item of inspection.records) {
      map.set(item.id, item);
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
