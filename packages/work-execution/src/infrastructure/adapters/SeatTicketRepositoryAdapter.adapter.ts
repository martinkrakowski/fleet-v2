// @generated adapter scaffold — implemented for lane SR3 (local transactional store).
/**
 * SeatTicketRepositoryAdapter implements SeatTicketRepositoryPort
 * (local-transactional-store). One rotation counter per `(projectId, role)`
 * (plan §3.5.3, D3). Records live in an in-memory map by default; when
 * `stateDir` is configured they persist in `seat-tickets.json`, written via an
 * atomic temp-file-then-rename write under an exclusive lock. Every save is a
 * compare-and-swap on `revision`: a stored record wins when its `revision` is
 * >= the incoming one or its `ticket` is higher, so a stored `ticket` never
 * decreases. Stored records carry `schemaVersion: 1` (Q5a/D6); reads validate
 * through the shared parser and an unreadable file is a read error (fail
 * closed) that keeps a quarantine copy.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { SEAT_TICKET_ROLES, type SeatTicketRecord, type SeatTicketRole } from '../../domain/execution-records.js';
import type {
  SeatTicketRepositoryPort,
  SaveSeatTicketOutcome,
} from '../../application/ports/out/SeatTicketRepositoryPort.out-port.js';
import {
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  rejectUnreadableStateFile,
  StateFileUnknownVersionError,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

/** The schema-version policy of `seat-tickets.json` (Q5a, D6). */
export const SEAT_TICKET_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('seat-tickets.json', {
  writerVersion: 1,
  acceptedVersions: [1],
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isParseableIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the full body validation. Pure
 * and never throws. The returned record carries no `schemaVersion` key.
 */
export function parseVersionedSeatTicketStateRecord(raw: unknown): VersionedRecordParseResult<SeatTicketRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, SEAT_TICKET_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.version !== 1
  ) {
    return { status: 'unknown-version' };
  }
  if (
    !isNonEmptyString(candidate.projectId) ||
    !SEAT_TICKET_ROLES.includes(candidate.role as SeatTicketRole) ||
    !isNonNegativeSafeInteger(candidate.ticket) ||
    !isNonNegativeSafeInteger(candidate.revision) ||
    !isParseableIsoDate(candidate.updatedAtIso)
  ) {
    return { status: 'invalid' };
  }
  return {
    status: 'ok',
    record: {
      version: 1,
      projectId: candidate.projectId,
      role: candidate.role as SeatTicketRole,
      ticket: candidate.ticket,
      revision: candidate.revision,
      updatedAtIso: candidate.updatedAtIso,
    },
    schemaVersion: versionCheck.schemaVersion,
  };
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseSeatTicketStateRecord(raw: unknown): SeatTicketRecord | undefined {
  const parsed = parseVersionedSeatTicketStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

export interface SeatTicketRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

const SEAT_TICKET_STORE_NAME = 'seat-tickets.json';

function seatTicketKey(projectId: string, role: SeatTicketRole): string {
  return `${projectId}\u0000${role}`;
}

function isUnsafeStoreId(value: string): boolean {
  return value === '' || value === '.' || value === '..';
}

export class SeatTicketRepositoryAdapter implements SeatTicketRepositoryPort {
  private readonly options: SeatTicketRepositoryAdapterOptions | undefined;
  private readonly inMemoryRecords = new Map<string, SeatTicketRecord>();

  constructor(options?: SeatTicketRepositoryAdapterOptions) {
    this.options = options;
  }

  async findSeatTicket(projectId: string, role: SeatTicketRole): Promise<SeatTicketRecord | null> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryRecords.get(seatTicketKey(projectId, role)) ?? null;
    }
    const records = await this.readRecordsFromDisk(path.join(stateDir, SEAT_TICKET_STORE_NAME));
    return records.get(seatTicketKey(projectId, role)) ?? null;
  }

  async listSeatTickets(projectId?: string): Promise<readonly SeatTicketRecord[]> {
    const stateDir = this.options?.stateDir;
    const records =
      stateDir === undefined
        ? [...this.inMemoryRecords.values()]
        : await this.readRecordsFromDisk(path.join(stateDir, SEAT_TICKET_STORE_NAME));
    const list = [...records.values()];
    if (projectId === undefined) {
      return list;
    }
    return list.filter((record) => record.projectId === projectId);
  }

  async saveSeatTicket(record: SeatTicketRecord): Promise<SaveSeatTicketOutcome> {
    if (isUnsafeStoreId(record.projectId) || !SEAT_TICKET_ROLES.includes(record.role)) {
      throw new Error('SeatTicketRepositoryAdapter refuses an unsafe project id or role');
    }
    const stateDir = this.options?.stateDir;
    const key = seatTicketKey(record.projectId, record.role);
    if (stateDir === undefined) {
      return this.saveInMemory(record, key);
    }
    return this.saveOnDisk(record, key, stateDir);
  }

  private saveInMemory(record: SeatTicketRecord, key: string): SaveSeatTicketOutcome {
    const stored = this.inMemoryRecords.get(key);
    if (stored !== undefined && (stored.revision >= record.revision || stored.ticket > record.ticket)) {
      return 'conflict';
    }
    this.inMemoryRecords.set(key, record);
    return 'saved';
  }

  private async saveOnDisk(
    record: SeatTicketRecord,
    key: string,
    stateDir: string,
  ): Promise<SaveSeatTicketOutcome> {
    const target = path.join(stateDir, SEAT_TICKET_STORE_NAME);
    const lockPath = path.join(stateDir, `${SEAT_TICKET_STORE_NAME}.lock`);
    let outcome: SaveSeatTicketOutcome = 'saved';
    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target);
      const stored = records.get(key);
      if (stored !== undefined && (stored.revision >= record.revision || stored.ticket > record.ticket)) {
        outcome = 'conflict';
        return;
      }
      records.set(key, record);
      const payload = [...records.values()].map((item) => ({
        ...item,
        schemaVersion: SEAT_TICKET_STORE_VERSION_POLICY.writerVersion,
      }));
      await writeJsonAtomically(target, payload);
    });
    return outcome;
  }

  private async readRecordsFromDisk(target: string): Promise<Map<string, SeatTicketRecord>> {
    const map = new Map<string, SeatTicketRecord>();
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
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedSeatTicketStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, false);
    }
    for (const item of inspection.records) {
      map.set(seatTicketKey(item.projectId, item.role), item);
    }
    return map;
  }
}
