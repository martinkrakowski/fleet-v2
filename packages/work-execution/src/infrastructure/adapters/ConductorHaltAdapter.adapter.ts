// @generated adapter scaffold — refined for lane K7-1.
/**
 * ConductorHaltAdapter implements ConductorHaltPort over the conductor's halt
 * marker of a state directory (plan §3.7, owner decision K7-D2): one record
 * in `<stateDir>/conductor-halt.json`, optionally in memory only, written
 * under the shared exclusive lock with an atomic rename, the exact bytes
 * quarantined when the file is unreadable. It never shares another store's
 * file.
 *
 * An unreadable marker is a halt; halting never fails on a bad file; lifting
 * does. Setting `halted: true` quarantines the unreadable bytes and replaces
 * the file; setting `halted: false` refuses until a readable marker exists.
 * The file joins `fleet-v2 state check` and `state restore`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  CONDUCTOR_HALT_RECORD_VERSION,
  isZonedIsoDateTime,
  readConductorHaltRecord,
  type ConductorHaltRecord,
  type ConductorHaltState,
} from '../../domain/conductor-halt.js';
import type {
  ConductorHaltPort,
  ConductorHaltSetResult,
} from '../../application/ports/out/ConductorHaltPort.out-port.js';
import {
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  assertStoreWritable,
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface ConductorHaltAdapterOptions {
  /** When set, the halt marker persists here and reloads on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Read-only mode: an unreadable marker reads as `unreadable` without quarantining or writing. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'conductor-halt.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'run-journal.json',
  'lane-runs.json',
  'conductor-driver-lease.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseConductorHaltStateRecord(raw: unknown): ConductorHaltRecord | undefined {
  try {
    const result = readConductorHaltRecord(raw);
    if (!result.ok) {
      return undefined;
    }
    return result.record;
  } catch {
    return undefined;
  }
}

/** The current marker of a list: the last record; an empty list is none. */
function currentRecordOf(records: readonly ConductorHaltRecord[]): ConductorHaltRecord | null {
  if (records.length === 0) {
    return null;
  }
  return records[records.length - 1];
}

/** The stored record's state: a halted record is a halt, any other is clear. */
function stateOfRecord(record: ConductorHaltRecord | null): ConductorHaltState {
  if (record === null) {
    return { state: 'clear', record: null };
  }
  return record.halted ? { state: 'halted', record } : { state: 'clear', record };
}

export class ConductorHaltAdapter implements ConductorHaltPort {
  private inMemoryRecord: ConductorHaltRecord | null = null;

  constructor(private readonly options: ConductorHaltAdapterOptions = {}) {}

  async read(): Promise<ConductorHaltState> {
    const target = this.statePath;
    if (target === null) {
      return stateOfRecord(this.inMemoryRecord);
    }
    try {
      return stateOfRecord(currentRecordOf(await this.readRecordsFromDisk(target)));
    } catch (error: unknown) {
      if (
        error instanceof StateFileUnreadableError ||
        error instanceof StateFileUnreadableReadOnlyError
      ) {
        return { state: 'unreadable' };
      }
      throw error;
    }
  }

  async set(request: { readonly halted: boolean; readonly nowIso: string }): Promise<ConductorHaltSetResult> {
    assertStoreWritable(this.options?.readOnly === true, 'ConductorHaltAdapter');
    if (!isZonedIsoDateTime(request.nowIso)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const target = this.statePath;
    if (target === null) {
      return this.mutateInMemory(request);
    }
    return this.mutateOnDisk(target, request);
  }

  /** Memory mode: one field; nothing stored and `halted: false` still writes the record. */
  private mutateInMemory(request: { readonly halted: boolean; readonly nowIso: string }): ConductorHaltSetResult {
    const current = this.inMemoryRecord;
    if (current !== null && current.halted === request.halted) {
      return { outcome: 'unchanged', record: current };
    }
    const record = recordFor(request);
    this.inMemoryRecord = record;
    return { outcome: 'changed', record };
  }

  /**
   * File mode: under the store's lock. An unreadable file is quarantined by
   * the read; halting over it writes anyway, lifting refuses it.
   */
  private async mutateOnDisk(
    target: string,
    request: { readonly halted: boolean; readonly nowIso: string },
  ): Promise<ConductorHaltSetResult> {
    return withFileLock(`${target}.lock`, async () => {
      let current: ConductorHaltRecord | null;
      try {
        current = currentRecordOf(await this.readRecordsFromDisk(target));
      } catch (error: unknown) {
        if (!(error instanceof StateFileUnreadableError)) {
          throw error;
        }
        if (!request.halted) {
          return { outcome: 'refused', reason: 'marker-unreadable' };
        }
        current = null;
      }
      if (current !== null && current.halted === request.halted) {
        return { outcome: 'unchanged', record: current };
      }
      const record = recordFor(request);
      await writeJsonAtomically(target, [record]);
      return { outcome: 'changed', record };
    });
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error('ConductorHaltAdapter refuses a fileName that collides with another store');
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('ConductorHaltAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(target: string): Promise<readonly ConductorHaltRecord[]> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const inspection = inspectRecordListBytes(buffer, parseConductorHaltStateRecord);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    return inspection.records;
  }
}

/** The stored record normalises the request's zoned time with `toISOString`. */
function recordFor(request: { readonly halted: boolean; readonly nowIso: string }): ConductorHaltRecord {
  return {
    version: CONDUCTOR_HALT_RECORD_VERSION,
    halted: request.halted,
    changedAtIso: new Date(Date.parse(request.nowIso)).toISOString(),
  };
}
