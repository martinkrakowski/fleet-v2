// @generated adapter scaffold — implemented for lane SR3 (local transactional store).
/**
 * SeatObservationRepositoryAdapter implements SeatObservationRepositoryPort
 * (local-transactional-store). An append-only store of observations recorded
 * outside fleet's runner (plan §3.5.5): a stored observation is never
 * rewritten or removed, a repeated `observationId` is refused as duplicate.
 * Records live in an in-memory array by default; when `stateDir` is
 * configured they persist in `seat-observations.json`, written via an atomic
 * temp-file-then-rename write under an exclusive lock. Stored records carry
 * `schemaVersion: 1` (Q5a/D6); reads validate through the shared parser and an
 * unreadable file is a read error (fail closed) that keeps a quarantine copy.
 */

import * as path from 'node:path';

import {
  SEAT_OBSERVATION_OUTCOMES,
  type SeatObservationRecord,
} from '../../domain/execution-records.js';
import type {
  AppendSeatObservationOutcome,
  SeatObservationRepositoryPort,
} from '../../application/ports/out/SeatObservationRepositoryPort.out-port.js';
import {
  assertValidSchemaVersionPolicy,
  readOrQuarantineVersionedRecordList,
  readStoreRecordSchemaVersion,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

/** The schema-version policy of `seat-observations.json` (Q5a, D6). */
export const SEAT_OBSERVATION_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy(
  'seat-observations.json',
  { writerVersion: 1, acceptedVersions: [1] },
);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isParseableIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the body validation (identity,
 * outcome, subject, `via`). Pure and never throws. The returned record
 * carries no `schemaVersion` key.
 */
export function parseVersionedSeatObservationStateRecord(
  raw: unknown,
): VersionedRecordParseResult<SeatObservationRecord> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, SEAT_OBSERVATION_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    const candidate = raw as Record<string, unknown>;
    if (
      candidate.version !== 1
    ) {
      return { status: 'unknown-version' };
    }
    const subject =
      typeof candidate.subject === 'object' && candidate.subject !== null
        ? (candidate.subject as Record<string, unknown>)
        : undefined;
    const subjectKeys = subject === undefined ? [] : Object.keys(subject);
    const subjectValid =
      subject !== undefined &&
      subjectKeys.length === 1 &&
      ((subjectKeys[0] === 'attemptId' && isNonEmptyString(subject.attemptId)) ||
        (subjectKeys[0] === 'reviewRequestId' && isNonEmptyString(subject.reviewRequestId)));
    if (
      !isNonEmptyString(candidate.observationId) ||
      !isNonEmptyString(candidate.seatId) ||
      !SEAT_OBSERVATION_OUTCOMES.includes(candidate.outcome as never) ||
      !isParseableIsoDate(candidate.observedAtIso) ||
      !subjectValid ||
      (candidate.via !== 'cli' && candidate.via !== 'mcp')
    ) {
      return { status: 'invalid' };
    }
    return {
      status: 'ok',
      record: {
        version: 1,
        observationId: candidate.observationId,
        seatId: candidate.seatId,
        outcome: candidate.outcome as SeatObservationRecord['outcome'],
        observedAtIso: candidate.observedAtIso,
        // A fresh object, never the caller's: a later mutation of the nested
        // subject cannot change what the adapter validated and writes.
        subject: { ...(candidate.subject as Record<string, unknown>) } as SeatObservationRecord['subject'],
        via: candidate.via,
      },
      schemaVersion: versionCheck.schemaVersion,
    };
  } catch {
    // A hostile getter on `raw` must never throw out of the parser.
    return { status: 'invalid' };
  }
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseSeatObservationStateRecord(raw: unknown): SeatObservationRecord | undefined {
  const parsed = parseVersionedSeatObservationStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

export interface SeatObservationRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

const SEAT_OBSERVATION_STORE_NAME = 'seat-observations.json';

function isUnsafeStoreId(value: string): boolean {
  return value === '' || value === '.' || value === '..';
}

export class SeatObservationRepositoryAdapter implements SeatObservationRepositoryPort {
  private readonly options: SeatObservationRepositoryAdapterOptions | undefined;
  private readonly inMemoryRecords: SeatObservationRecord[] = [];

  constructor(options?: SeatObservationRepositoryAdapterOptions) {
    this.options = options;
  }

  async appendSeatObservation(input: SeatObservationRecord): Promise<AppendSeatObservationOutcome> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('SeatObservationRepositoryAdapter refuses an invalid observation record');
    }
    // Snapshot first (structuredClone reads every property, getters included,
    // exactly once), so validation and storage see the same plain data.
    const record = structuredClone(input);
    if (isUnsafeStoreId(record.observationId) || isUnsafeStoreId(record.seatId)) {
      throw new Error('SeatObservationRepositoryAdapter refuses an unsafe observation id or seat id');
    }
    if (!SEAT_OBSERVATION_OUTCOMES.includes(record.outcome)) {
      throw new Error('SeatObservationRepositoryAdapter refuses an unknown outcome');
    }
    if (record.via !== 'cli' && record.via !== 'mcp') {
      throw new Error('SeatObservationRepositoryAdapter refuses an unknown via');
    }
    // Validate the whole record (subject shape, timestamp, identity) through
    // the reader's own parser BEFORE storing, so a record the reader would
    // reject can never be written and make the store unreadable. The parsed
    // copy is what is stored: unknown extra top-level keys are dropped.
    const parsed = parseSeatObservationStateRecord({
      ...record,
      schemaVersion: SEAT_OBSERVATION_STORE_VERSION_POLICY.writerVersion,
    });
    if (parsed === undefined) {
      throw new Error('SeatObservationRepositoryAdapter refuses an invalid observation record');
    }
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.appendInMemory(parsed);
    }
    return this.appendOnDisk(parsed, stateDir);
  }

  async listSeatObservations(seatId?: string): Promise<readonly SeatObservationRecord[]> {
    const stateDir = this.options?.stateDir;
    const records =
      stateDir === undefined
        ? this.inMemoryRecords.map((record) => structuredClone(record))
        : await this.readRecordsFromDisk(path.join(stateDir, SEAT_OBSERVATION_STORE_NAME));
    if (seatId === undefined) {
      return records;
    }
    return records.filter((record) => record.seatId === seatId);
  }

  private appendInMemory(record: SeatObservationRecord): AppendSeatObservationOutcome {
    if (this.inMemoryRecords.some((stored) => stored.observationId === record.observationId)) {
      return 'duplicate';
    }
    // Store a deep copy so a caller retaining a mutable alias (including the
    // nested `subject` object) cannot change a stored observation without
    // going through the append path.
    this.inMemoryRecords.push(structuredClone(record));
    return 'appended';
  }

  private async appendOnDisk(
    record: SeatObservationRecord,
    stateDir: string,
  ): Promise<AppendSeatObservationOutcome> {
    const target = path.join(stateDir, SEAT_OBSERVATION_STORE_NAME);
    const lockPath = path.join(stateDir, `${SEAT_OBSERVATION_STORE_NAME}.lock`);
    let outcome: AppendSeatObservationOutcome = 'appended';
    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target, true);
      if (records.some((stored) => stored.observationId === record.observationId)) {
        outcome = 'duplicate';
        return;
      }
      records.push(record);
      const payload = records.map((item) => ({
        ...item,
        schemaVersion: SEAT_OBSERVATION_STORE_VERSION_POLICY.writerVersion,
      }));
      await writeJsonAtomically(target, payload);
    });
    return outcome;
  }

  private async readRecordsFromDisk(target: string, lockHeld = false): Promise<SeatObservationRecord[]> {
    const records = await readOrQuarantineVersionedRecordList({
      filePath: target,
      parseRecord: parseVersionedSeatObservationStateRecord,
      lockHeld,
    });
    return [...records];
  }
}
