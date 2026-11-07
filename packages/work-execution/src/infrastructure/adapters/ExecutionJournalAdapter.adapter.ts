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
import {
  ACTION_JOURNAL_ENTRY_SCHEMA_VERSION,
  CAPACITY_RESERVATION_SCHEMA_VERSION,
  parseSeatTool,
  readJournalPullRequestRef,
} from '../../domain/execution-records.js';
import type {
  CapacityReservationClaim,
  ExecutionJournalPort,
  ReleaseCapacityReservationIfUnchangedRequest,
  ReleaseCapacityReservationIfUnchangedResult,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
  SelectRecordUnderLockVerdict,
} from '../../application/ports/out/ExecutionJournalPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import {
  assertStoreWritable,
  assertValidSchemaVersionPolicy,
  FileLockTimeoutError,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  rejectUnreadableStateFile,
  StateFileUnreadableError,
  StateFileUnknownVersionError,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';
import { isCanonicalIso } from '../../domain/lane-activity-records.js';
import { containsSecretShape } from '@fleet/shared';

/** The schema-version policy of `journal.json` (Q5a, D6). */
export const JOURNAL_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('journal.json', {
  writerVersion: ACTION_JOURNAL_ENTRY_SCHEMA_VERSION,
  acceptedVersions: [1],
});

/** The schema-version policy of `reservations.json` (Q5a, D6). */
export const RESERVATION_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('reservations.json', {
  writerVersion: CAPACITY_RESERVATION_SCHEMA_VERSION,
  acceptedVersions: [1],
});

export interface ExecutionJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
  /**
   * Read-only: an unreadable file is a read error with no quarantine copy
   * (`StateFileUnreadableReadOnlyError`), and every write throws
   * `ReadOnlyStateStoreError`.
   */
  readonly readOnly?: boolean;
}

function isActionJournalEntryRecord(value: unknown): value is ActionJournalEntryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.attemptId !== 'string') return false;
  // The typed pull-request reference (WB5b) must be a valid forge-only
  // (repository, number) pair; any malformed value fails closed.
  try {
    if (readJournalPullRequestRef(candidate.action as ActionJournalEntryRecord['action'], candidate.pullRequest).kind === 'invalid') {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function isCapacityReservationRecord(value: unknown): value is CapacityReservationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.attemptId === 'string';
}

function isNonEmptyStringField(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validation for `releaseCapacityReservationIfUnchanged` (plan §3.9.2). Returns
 * a detail code only for diagnostics that never carry the offending value.
 * Every failure — including a property read that throws — is `invalid-request`
 * and never an exception.
 */
const FENCED_RELEASE_REQUEST_KEYS = new Set([
  'attemptId',
  'reservationId',
  'attemptRevision',
  'releasedAtIso',
  'readAttemptRevision',
]);

function validateFencedReleaseRequest(request: ReleaseCapacityReservationIfUnchangedRequest): string | null {
  try {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return 'not-an-object';
    }
    const value = request as unknown as Record<string, unknown>;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== FENCED_RELEASE_REQUEST_KEYS.size || keys.some((key) => typeof key !== 'string' || !FENCED_RELEASE_REQUEST_KEYS.has(key))) {
      return 'unknown-or-missing-key';
    }
    for (const field of ['attemptId', 'reservationId'] as const) {
      const candidate = value[field];
      if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        Buffer.byteLength(candidate, 'utf8') > 256 ||
        containsSecretShape(candidate)
      ) {
        return 'invalid-id';
      }
    }
    const revision = value['attemptRevision'];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      return 'invalid-revision';
    }
    if (!isCanonicalIso(value['releasedAtIso'])) {
      return 'invalid-timestamp';
    }
    if (typeof value['readAttemptRevision'] !== 'function') {
      return 'invalid-read-attempt-revision';
    }
    return null;
  } catch {
    return 'unreadable-object';
  }
}

/** A journal entry in canonical stored shape: every writer stamps `schemaVersion` (Q5a, D6). */
function normalizeJournalEntry(entry: ActionJournalEntryRecord): ActionJournalEntryRecord {
  return { ...entry, schemaVersion: JOURNAL_STORE_VERSION_POLICY.writerVersion };
}

/**
 * The versioned journal reader's record parser, shared with
 * `fleet-v2 state check`: the `schemaVersion` check runs first, then the
 * body's identity check.
 */
export function parseVersionedJournalEntryStateRecord(raw: unknown): VersionedRecordParseResult<ActionJournalEntryRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, JOURNAL_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  if (!isActionJournalEntryRecord(raw)) {
    return { status: 'invalid' };
  }
  return { status: 'ok', record: normalizeJournalEntry(raw), schemaVersion: versionCheck.schemaVersion };
}

/** The journal reader's record parser, shared with `fleet-v2 state check`. */
export function parseJournalEntryStateRecord(raw: unknown): ActionJournalEntryRecord | undefined {
  const parsed = parseVersionedJournalEntryStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

/** A reservation in canonical stored shape: `schemaVersion` plus the host fields' null-normalizations. */
function normalizeReservationRecord(item: CapacityReservationRecord): CapacityReservationRecord {
  return {
    ...item,
    schemaVersion: RESERVATION_STORE_VERSION_POLICY.writerVersion,
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
 * The versioned reservation reader's record parser, shared with
 * `fleet-v2 state check`: the `schemaVersion` check runs first, then the
 * body's identity check, then the host-field normalizations.
 */
export function parseVersionedReservationStateRecord(raw: unknown): VersionedRecordParseResult<CapacityReservationRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, RESERVATION_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  if (!isCapacityReservationRecord(raw)) {
    return { status: 'invalid' };
  }
  return { status: 'ok', record: normalizeReservationRecord(raw), schemaVersion: versionCheck.schemaVersion };
}

/** The reservation reader's record parser, shared with `fleet-v2 state check`. */
export function parseReservationStateRecord(raw: unknown): CapacityReservationRecord | undefined {
  const parsed = parseVersionedReservationStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

/**
 * The checks both fenced-release paths share: the attempt's held reservation
 * must exist and be the requested one, and the attempt's revision must be
 * readable and unchanged. Anything else answers the release result as is.
 */
async function checkFencedReleaseHeld(
  reservations: Iterable<CapacityReservationRecord>,
  request: ReleaseCapacityReservationIfUnchangedRequest,
): Promise<
  | { readonly outcome: 'held'; readonly held: CapacityReservationRecord }
  | Exclude<ReleaseCapacityReservationIfUnchangedResult, { outcome: 'released' | 'refused' }>
> {
  const held = [...reservations].find(
    (reservation) => reservation.attemptId === request.attemptId && reservation.held === true,
  );
  if (held === undefined) return { outcome: 'not-held' };
  if (held.id !== request.reservationId) return { outcome: 'changed' };
  let currentRevision: number | null;
  try {
    currentRevision = await request.readAttemptRevision();
  } catch {
    return { outcome: 'unknown', reason: 'attempt-unknown' };
  }
  if (currentRevision === null) {
    return { outcome: 'unknown', reason: 'attempt-unknown' };
  }
  if (currentRevision !== request.attemptRevision) {
    return { outcome: 'changed' };
  }
  return { outcome: 'held', held };
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
  return { outcome: 'reserved', reservation: normalizeReservationRecord({ ...claim, slotIndex }) };
}

export class ExecutionJournalAdapter implements ExecutionJournalPort {
  private readonly inMemoryJournalEntries: ActionJournalEntryRecord[] = [];
  private readonly inMemoryReservationsById = new Map<string, CapacityReservationRecord>();
  private readonly fencedReleaseChainsByAttemptId = new Map<string, Promise<unknown>>();
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
    assertStoreWritable(this.options?.readOnly === true, 'ExecutionJournalAdapter');
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const duplicate = this.inMemoryJournalEntries.some((existing) => existing.id === entry.id);
      if (duplicate) {
        throw new Error(`Duplicate journal entry id: ${entry.id}`);
      }
      this.inMemoryJournalEntries.push(normalizeJournalEntry(entry));
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
      entries.push(normalizeJournalEntry(entry));
      await writeJsonAtomically(target, entries);
    });
  }

  async listJournalEntriesForAttempt(
    attemptId: string,
  ): Promise<readonly ActionJournalEntryRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryJournalEntries
        .filter((entry) => entry.attemptId === attemptId)
        .map(normalizeJournalEntry);
    }
    const target = path.join(stateDir, 'journal.json');
    const entries = await this.readJournalFromDisk(target);
    return entries.filter((entry) => entry.attemptId === attemptId).map(normalizeJournalEntry);
  }

  async saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void> {
    assertStoreWritable(this.options?.readOnly === true, 'ExecutionJournalAdapter');
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      refuseSupersedingReservation(this.inMemoryReservationsById, reservation);
      this.inMemoryReservationsById.set(reservation.id, normalizeReservationRecord(reservation));
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
      reservations.set(reservation.id, normalizeReservationRecord(reservation));
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
    assertStoreWritable(this.options?.readOnly === true, 'ExecutionJournalAdapter');
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
    assertStoreWritable(this.options?.readOnly === true, 'ExecutionJournalAdapter');
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const held = [...this.inMemoryReservationsById.values()].find(
        (reservation) => reservation.attemptId === attemptId && reservation.held === true,
      );
      if (held === undefined) return false;
      this.inMemoryReservationsById.set(held.id, normalizeReservationRecord({ ...held, held: false, releasedAtIso }));
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
      reservations.set(held.id, normalizeReservationRecord({ ...held, held: false, releasedAtIso }));
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

  async releaseCapacityReservationIfUnchanged(
    rawRequest: ReleaseCapacityReservationIfUnchangedRequest,
  ): Promise<ReleaseCapacityReservationIfUnchangedResult> {
    assertStoreWritable(this.options?.readOnly === true, 'ExecutionJournalAdapter');
    try {
      const validated = validateFencedReleaseRequest(rawRequest);
      if (validated !== null) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      // Snapshot once so a getter cannot answer differently after validation.
      const request: ReleaseCapacityReservationIfUnchangedRequest = {
        attemptId: rawRequest.attemptId,
        reservationId: rawRequest.reservationId,
        attemptRevision: rawRequest.attemptRevision,
        releasedAtIso: rawRequest.releasedAtIso,
        readAttemptRevision: rawRequest.readAttemptRevision,
      };

      const stateDir = this.options?.stateDir;
      if (stateDir === undefined) {
        return await this.releaseInMemoryIfUnchanged(request);
      }

      const target = path.join(stateDir, 'reservations.json');
      const lockPath = path.join(stateDir, 'reservations.json.lock');

      let before: ChangeSignal['before'] = null;
      let written: ChangeSignal['written'] = null;
      let releasedId: string | null = null;

      try {
        const outcome = await withFileLock(lockPath, async (): Promise<
          Exclude<ReleaseCapacityReservationIfUnchangedResult, { outcome: 'unknown'; reason: 'lock-timeout' }>
        > => {
          try {
            const stat = await fs.stat(target);
            before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
          } catch {
            before = null;
          }
          let reservations: Map<string, CapacityReservationRecord>;
          try {
            reservations = await this.readReservationsFromDisk(target);
          } catch (error) {
            if (error instanceof StateFileUnreadableError || error instanceof StateFileUnknownVersionError) {
              return { outcome: 'unknown', reason: 'unreadable' };
            }
            throw error;
          }
          const check = await checkFencedReleaseHeld(reservations.values(), request);
          if (check.outcome !== 'held') {
            return check;
          }
          const held = check.held;
          const priorList = [...reservations.values()];
          reservations.set(
            held.id,
            normalizeReservationRecord({ ...held, held: false, releasedAtIso: request.releasedAtIso }),
          );
          await writeJsonAtomically(target, [...reservations.values()]);
          // The attempt store is not under the reservations lock, so a writer
          // can save a newer attempt revision between the first read and the
          // write above. Re-read the revision after the write: if it moved,
          // restore the prior list (still under the lock) and report `changed`.
          let verifiedRevision: number | null;
          try {
            verifiedRevision = await request.readAttemptRevision();
          } catch {
            verifiedRevision = null;
          }
          if (verifiedRevision !== request.attemptRevision) {
            await writeJsonAtomically(target, priorList);
            return verifiedRevision === null
              ? { outcome: 'unknown', reason: 'attempt-unknown' }
              : { outcome: 'changed' };
          }
          try {
            const stat = await fs.stat(target);
            written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
          } catch {
            written = null;
          }
          releasedId = held.id;
          return { outcome: 'released', reservationId: held.id };
        });

        if (outcome.outcome === 'released' && releasedId !== null) {
          this.signal({
            kind: 'capacity',
            id: releasedId,
            stateFile: path.resolve(target),
            before,
            written,
          });
        }
        return outcome;
      } catch (error) {
        if (error instanceof FileLockTimeoutError) {
          return { outcome: 'unknown', reason: 'lock-timeout' };
        }
        if (error instanceof StateFileUnreadableError || error instanceof StateFileUnknownVersionError) {
          return { outcome: 'unknown', reason: 'unreadable' };
        }
        return { outcome: 'unknown', reason: 'unreadable' };
      }
    } catch {
      return { outcome: 'unknown', reason: 'unreadable' };
    }
  }

  private releaseInMemoryIfUnchanged(
    request: ReleaseCapacityReservationIfUnchangedRequest,
  ): Promise<ReleaseCapacityReservationIfUnchangedResult> {
    // Concurrent releases of the same attempt must not both act on the same
    // held reservation: each find-check-release runs on a per-attempt chain so
    // the second caller re-reads the map only after the first has finished.
    const prior = this.fencedReleaseChainsByAttemptId.get(request.attemptId) ?? Promise.resolve();
    const run = prior
      .then(
        () => this.releaseInMemoryIfUnchangedLocked(request),
        () => this.releaseInMemoryIfUnchangedLocked(request),
      );
    const tail = run.catch(() => undefined);
    this.fencedReleaseChainsByAttemptId.set(request.attemptId, tail);
    // The chain exists only to serialise in-flight releases of the same
    // attempt. Once the latest link settles it has served its purpose; drop it
    // so a long-lived process does not retain one resolved promise per attempt
    // forever. A newer link for the same attempt replaces the entry before the
    // older one settles, so the identity check keeps the newest chain intact.
    void tail.then(() => {
      if (this.fencedReleaseChainsByAttemptId.get(request.attemptId) === tail) {
        this.fencedReleaseChainsByAttemptId.delete(request.attemptId);
      }
    });
    return run;
  }

  private async releaseInMemoryIfUnchangedLocked(
    request: ReleaseCapacityReservationIfUnchangedRequest,
  ): Promise<ReleaseCapacityReservationIfUnchangedResult> {
    const check = await checkFencedReleaseHeld(this.inMemoryReservationsById.values(), request);
    if (check.outcome !== 'held') {
      return check;
    }
    const held = check.held;
    this.inMemoryReservationsById.set(
      held.id,
      normalizeReservationRecord({ ...held, held: false, releasedAtIso: request.releasedAtIso }),
    );
    this.signal({ kind: 'capacity', id: held.id, stateFile: null, before: null, written: null });
    return { outcome: 'released', reservationId: held.id };
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
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedJournalEntryStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
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
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedReservationStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
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
