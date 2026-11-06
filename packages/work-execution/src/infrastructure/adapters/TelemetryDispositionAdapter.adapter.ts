// @generated adapter scaffold — refined for lane OT2a-1.
/**
 * TelemetryDispositionAdapter implements TelemetryDispositionPort over the
 * telemetry disposition store of a state directory (plan §3.3 "Application",
 * §3.5): one record in `<stateDir>/telemetry-dispositions.json`, optionally in
 * memory only, every write merged under the shared exclusive lock with an
 * atomic rename, the exact bytes quarantined when the file is unreadable. It
 * is the repo's one-adapter, two-modes pattern (`ConductorHaltAdapter`): with
 * a `stateDir` it uses the file, without one it holds the state in memory.
 * A lock that cannot be taken within `lockTimeoutMs` (default 500) skips the
 * write and changes nothing. The file joins `fleet-v2 state check` and
 * `state restore`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  applyDispositionWrite,
  emptyTelemetryDispositionRecord,
  readTelemetryDispositionRecord,
  type TelemetryDispositionRecord,
  type TelemetryDispositionWriteRequest,
} from '../../domain/run-telemetry-dispositions.js';
import type {
  TelemetryDispositionPort,
  TelemetryDispositionRead,
  TelemetryDispositionWriteResult,
} from '../../application/ports/out/TelemetryDispositionPort.out-port.js';
import {
  FileLockTimeoutError,
  StateFileUnreadableError,
  inspectRecordListBytes,
  quarantineUnreadable,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface TelemetryDispositionAdapterOptions {
  /** When set, the dispositions persist here and reload on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** The lock give-up of every write (plan §3.3 "Single writer"). */
  readonly lockTimeoutMs?: number;
}

const DEFAULT_FILE_NAME = 'telemetry-dispositions.json';
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
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseTelemetryDispositionStateRecord(raw: unknown): TelemetryDispositionRecord | undefined {
  try {
    const result = readTelemetryDispositionRecord(raw);
    if (!result.ok) {
      return undefined;
    }
    return result.record;
  } catch {
    return undefined;
  }
}

/** The current record of a list: the last element; an empty list is the empty state. */
function currentRecordOf(records: readonly TelemetryDispositionRecord[]): TelemetryDispositionRecord {
  if (records.length === 0) {
    return emptyTelemetryDispositionRecord();
  }
  return records[records.length - 1]!;
}

export class TelemetryDispositionAdapter implements TelemetryDispositionPort {
  private inMemoryRecord: TelemetryDispositionRecord | null = null;

  constructor(private readonly options: TelemetryDispositionAdapterOptions = {}) {}

  async read(): Promise<TelemetryDispositionRead> {
    const target = this.statePath;
    if (target === null) {
      return { outcome: 'read', record: this.inMemoryRecord ?? emptyTelemetryDispositionRecord() };
    }
    try {
      return { outcome: 'read', record: currentRecordOf(await this.readRecordsFromDisk(target)) };
    } catch (error: unknown) {
      if (error instanceof StateFileUnreadableError) {
        return { outcome: 'unreadable' };
      }
      throw error;
    }
  }

  async write(request: TelemetryDispositionWriteRequest): Promise<TelemetryDispositionWriteResult> {
    const target = this.statePath;
    if (target === null) {
      return this.mutateInMemory(request);
    }
    return this.mutateOnDisk(target, request);
  }

  /** Memory mode: one record; the pure merge applies and the result replaces it. */
  private mutateInMemory(request: TelemetryDispositionWriteRequest): TelemetryDispositionWriteResult {
    const current = this.inMemoryRecord ?? emptyTelemetryDispositionRecord();
    const result = applyDispositionWrite(current, request);
    if (result.outcome === 'refused') {
      return { outcome: 'refused', reason: result.reason };
    }
    this.inMemoryRecord = result.record;
    return { outcome: 'written', applied: result.applied, kept: result.kept };
  }

  /**
   * File mode: under the store's lock. The file is read under the same lock
   * and the write merges into what was read, never over an earlier read. An
   * unreadable file is quarantined and the write is refused, never applied
   * over it, because applying over it would lose the recorded fingerprint.
   */
  private async mutateOnDisk(target: string, request: TelemetryDispositionWriteRequest): Promise<TelemetryDispositionWriteResult> {
    try {
      return await withFileLock(
        `${target}.lock`,
        async () => {
          let current: TelemetryDispositionRecord;
          try {
            current = currentRecordOf(await this.readRecordsFromDisk(target));
          } catch (error: unknown) {
            if (error instanceof StateFileUnreadableError) {
              return { outcome: 'refused', reason: 'store-unreadable' };
            }
            throw error;
          }
          const result = applyDispositionWrite(current, request);
          if (result.outcome === 'refused') {
            return { outcome: 'refused', reason: result.reason };
          }
          await writeJsonAtomically(target, [result.record]);
          return { outcome: 'written', applied: result.applied, kept: result.kept };
        },
        { timeoutMs: this.options.lockTimeoutMs ?? 500 },
      );
    } catch (error: unknown) {
      if (error instanceof StateFileUnreadableError) {
        return { outcome: 'refused', reason: 'store-unreadable' };
      }
      if (error instanceof FileLockTimeoutError) {
        return { outcome: 'skipped', reason: 'lock-busy' };
      }
      throw error;
    }
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error('TelemetryDispositionAdapter refuses a fileName that collides with another store');
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('TelemetryDispositionAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(target: string): Promise<readonly TelemetryDispositionRecord[]> {
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
    const inspection = inspectRecordListBytes(buffer, parseTelemetryDispositionStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(target, inspection.detail, buffer);
    }
    return inspection.records;
  }
}
