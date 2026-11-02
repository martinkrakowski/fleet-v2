// @generated adapter scaffold — refined for lane KA2.
/**
 * KillallHaltMarkerAdapter implements KillallHaltMarkerPort over the killall
 * halt marker of a state directory (plan §6): one record in
 * `<stateDir>/killall-halt.json`, optionally in memory only, written under the
 * shared exclusive lock with an atomic rename, the exact bytes quarantined
 * when the file is unreadable. It never shares another store's file.
 *
 * An unreadable marker is a halt; halting never fails on a bad file; lifting
 * does. Setting `halted: true` quarantines the unreadable bytes and replaces
 * the file; setting `halted: false` refuses until a readable marker exists.
 * The file joins `fleet-v2 state check` and `state restore`.
 */

import { join } from 'node:path';

import {
  CONDUCTOR_HALT_RECORD_VERSION,
  isZonedIsoDateTime,
  readConductorHaltRecord,
  type ConductorHaltRecord,
} from '../../domain/conductor-halt.js';
import type {
  KillallHaltMarkerPort,
  KillallHaltMarkerRead,
  KillallHaltMarkerSetResult,
} from '../../application/ports/out/KillallHaltMarkerPort.out-port.js';
import { assertStoreWritable } from './file-store.js';
import {
  mutateSingleRecordOnDisk,
  readCurrentSingleRecord,
} from './SingleRecordStore.helper.js';

export interface KillallHaltMarkerAdapterOptions {
  /** When set, the halt marker persists here and reloads on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Read-only mode: an unreadable marker reads as `unreadable` without quarantining or writing. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'killall-halt.json';
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
  'killall-train-pause.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseKillallHaltMarkerStateRecord(raw: unknown): ConductorHaltRecord | undefined {
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

/** The stored record's state: a halted record is a halt, any other is clear. */
function stateOfRecord(record: ConductorHaltRecord | null): KillallHaltMarkerRead {
  if (record === null) {
    return { state: 'clear' };
  }
  return record.halted ? { state: 'halted' } : { state: 'clear' };
}

export class KillallHaltMarkerAdapter implements KillallHaltMarkerPort {
  private inMemoryRecord: ConductorHaltRecord | null = null;

  constructor(private readonly options: KillallHaltMarkerAdapterOptions = {}) {}

  async read(): Promise<KillallHaltMarkerRead> {
    const target = this.statePath;
    if (target === null) {
      return stateOfRecord(this.inMemoryRecord);
    }
    const outcome = await readCurrentSingleRecord(
      target,
      parseKillallHaltMarkerStateRecord,
      this.options?.readOnly === true,
    );
    if (outcome.unreadable) {
      return { state: 'unreadable' };
    }
    return stateOfRecord(outcome.record);
  }

  async set(request: { readonly halted: boolean; readonly nowIso: string }): Promise<KillallHaltMarkerSetResult> {
    assertStoreWritable(this.options?.readOnly === true, 'KillallHaltMarkerAdapter');
    if (!isZonedIsoDateTime(request.nowIso)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const target = this.statePath;
    if (target === null) {
      return this.mutateInMemory(request);
    }
    return mutateSingleRecordOnDisk({
      target,
      parseRecord: parseKillallHaltMarkerStateRecord,
      isActivating: request.halted,
      unreadableReason: 'marker-unreadable',
      isUnchanged: (current) => current.halted === request.halted,
      record: recordFor(request),
      readOnly: this.options?.readOnly === true,
    });
  }

  /** Memory mode: one field; nothing stored and `halted: false` still writes the record. */
  private mutateInMemory(request: { readonly halted: boolean; readonly nowIso: string }): KillallHaltMarkerSetResult {
    const current = this.inMemoryRecord;
    if (current !== null && current.halted === request.halted) {
      return { outcome: 'unchanged', record: current };
    }
    const record = recordFor(request);
    this.inMemoryRecord = record;
    return { outcome: 'changed', record };
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error('KillallHaltMarkerAdapter refuses a fileName that collides with another store');
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('KillallHaltMarkerAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
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
