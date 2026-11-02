// @generated adapter scaffold — refined for lane KA2.
/**
 * KillallTrainPauseAdapter implements KillallTrainPausePort over the killall
 * train-pause record of a state directory (plan §6): one record in
 * `<stateDir>/killall-train-pause.json`, optionally in memory only, written
 * under the shared exclusive lock with an atomic rename, the exact bytes
 * quarantined when the file is unreadable. It never shares another store's
 * file. An unreadable record is a value, never a default; pausing over it
 * replaces it, lifting refuses it. The file joins `fleet-v2 state check` and
 * `state restore`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  KILLALL_TRAIN_PAUSE_RECORD_VERSION,
  type KillallTrainPausePort,
  type KillallTrainPauseRead,
  type KillallTrainPauseStoreRecord,
  type KillallTrainPauseSetResult,
} from '../../application/ports/out/KillallTrainPausePort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { readExactPlainRecord } from '../../domain/plain-record-reads.js';
import {
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  assertStoreWritable,
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface KillallTrainPauseAdapterOptions {
  /** When set, the train-pause record persists here and reloads on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Read-only mode: an unreadable record reads as `unreadable` without quarantining or writing. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'killall-train-pause.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'run-journal.json',
  'lane-runs.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
  'killall-halt.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

const PAUSE_KEYS: readonly string[] = ['version', 'paused', 'requestedAtIso'];

/** Pure: exactly the three keys; version 1; paused a boolean; requestedAtIso zoned and calendar-valid. */
export function readKillallTrainPauseStoreRecord(input: unknown): KillallTrainPauseStoreRecord | null {
  const snapshot = readExactPlainRecord(input, PAUSE_KEYS);
  if (snapshot === null) {
    return null;
  }
  if (snapshot.version !== KILLALL_TRAIN_PAUSE_RECORD_VERSION) {
    return null;
  }
  if (typeof snapshot.paused !== 'boolean') {
    return null;
  }
  if (!isZonedIsoDateTime(snapshot.requestedAtIso)) {
    return null;
  }
  return {
    version: KILLALL_TRAIN_PAUSE_RECORD_VERSION,
    paused: snapshot.paused,
    requestedAtIso: snapshot.requestedAtIso,
  };
}

/** The reader's record parser, shared with `fleet-v2 state check`. Never throws. */
export function parseKillallTrainPauseStateRecord(raw: unknown): KillallTrainPauseStoreRecord | undefined {
  try {
    return readKillallTrainPauseStoreRecord(raw) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The current record of a list: the last record; an empty list is none. */
function currentRecordOf(records: readonly KillallTrainPauseStoreRecord[]): KillallTrainPauseStoreRecord | null {
  if (records.length === 0) {
    return null;
  }
  return records[records.length - 1];
}

/** The stored record's status: a paused record is paused, any other is clear. */
function statusOfRecord(record: KillallTrainPauseStoreRecord | null): KillallTrainPauseRead {
  if (record === null) {
    return { status: 'clear' };
  }
  return record.paused ? { status: 'paused' } : { status: 'clear' };
}

export class KillallTrainPauseAdapter implements KillallTrainPausePort {
  private inMemoryRecord: KillallTrainPauseStoreRecord | null = null;

  constructor(private readonly options: KillallTrainPauseAdapterOptions = {}) {}

  async read(): Promise<KillallTrainPauseRead> {
    const target = this.statePath;
    if (target === null) {
      return statusOfRecord(this.inMemoryRecord);
    }
    try {
      return statusOfRecord(currentRecordOf(await this.readRecordsFromDisk(target)));
    } catch (error: unknown) {
      if (
        error instanceof StateFileUnreadableError ||
        error instanceof StateFileUnreadableReadOnlyError
      ) {
        return { status: 'unreadable' };
      }
      throw error;
    }
  }

  async set(request: { readonly paused: boolean; readonly nowIso: string }): Promise<KillallTrainPauseSetResult> {
    assertStoreWritable(this.options?.readOnly === true, 'KillallTrainPauseAdapter');
    if (!isZonedIsoDateTime(request.nowIso)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const target = this.statePath;
    if (target === null) {
      return this.mutateInMemory(request);
    }
    return this.mutateOnDisk(target, request);
  }

  /** Memory mode: one field; nothing stored and `paused: false` still writes the record. */
  private mutateInMemory(request: { readonly paused: boolean; readonly nowIso: string }): KillallTrainPauseSetResult {
    const current = this.inMemoryRecord;
    if (current !== null && current.paused === request.paused) {
      return { outcome: 'unchanged', record: current };
    }
    const record = recordFor(request);
    this.inMemoryRecord = record;
    return { outcome: 'changed', record };
  }

  /**
   * File mode: under the store's lock. An unreadable file is quarantined by
   * the read; pausing over it writes anyway, lifting refuses it.
   */
  private async mutateOnDisk(
    target: string,
    request: { readonly paused: boolean; readonly nowIso: string },
  ): Promise<KillallTrainPauseSetResult> {
    return withFileLock(`${target}.lock`, async () => {
      let current: KillallTrainPauseStoreRecord | null;
      try {
        current = currentRecordOf(await this.readRecordsFromDisk(target));
      } catch (error: unknown) {
        if (!(error instanceof StateFileUnreadableError)) {
          throw error;
        }
        if (!request.paused) {
          return { outcome: 'refused', reason: 'pause-unreadable' };
        }
        current = null;
      }
      if (current !== null && current.paused === request.paused) {
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
      throw new Error('KillallTrainPauseAdapter refuses a fileName that collides with another store');
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('KillallTrainPauseAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(target: string): Promise<readonly KillallTrainPauseStoreRecord[]> {
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
    const inspection = inspectRecordListBytes(buffer, parseKillallTrainPauseStateRecord);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    return inspection.records;
  }
}

/** The stored record normalises the request's zoned time with `toISOString`. */
function recordFor(request: { readonly paused: boolean; readonly nowIso: string }): KillallTrainPauseStoreRecord {
  return {
    version: KILLALL_TRAIN_PAUSE_RECORD_VERSION,
    paused: request.paused,
    requestedAtIso: new Date(Date.parse(request.nowIso)).toISOString(),
  };
}
