// @generated adapter stub — edit freely
/**
 * DaemonPauseAdapter implements DaemonPausePort over
 * `<stateDir>/daemon/paused.json` (plan §3.4): `write` builds the version 1
 * marker, validates it through `readDaemonPauseRecord` and persists it under
 * the shared exclusive lock with an atomic temp+rename (a refused validation
 * writes nothing); `read` maps a missing marker to `clear`, a parsed marker to
 * `paused`/`clear` per its field, and an unreadable marker to `unreadable`
 * after quarantining the exact bytes (the fail-closed mapping to paused lives
 * in the use case, not here).
 */

import { join } from 'node:path';

import {
  DAEMON_RECORD_VERSION,
  readDaemonPauseRecord,
  type DaemonPauseRead,
  type DaemonPauseRecord,
  type DaemonPauseState,
} from '../../domain/daemon-tick.js';
import type { DaemonPausePort } from '../../application/ports/out/DaemonPausePort.out-port.js';
import { assertStoreWritable } from './file-store.js';
import {
  readSingleRecordFileState,
  writeSingleRecordFile,
  type SingleRecordFileState,
} from './DaemonSingleRecordFile.helper.js';

export interface DaemonPauseAdapterOptions {
  /** When set, the marker persists at `<stateDir>/daemon/paused.json`. */
  readonly stateDir?: string;
  /** Read-only mode: reads never quarantine, and every write is refused. */
  readonly readOnly?: boolean;
}

export class DaemonPauseAdapter implements DaemonPausePort {
  private inMemoryPause: DaemonPauseRecord | null = null;

  constructor(private readonly options: DaemonPauseAdapterOptions = {}) {}

  async write(paused: boolean, changedAtIso: string): Promise<DaemonPauseRead> {
    assertStoreWritable(this.options?.readOnly === true, 'DaemonPauseAdapter');
    const candidate: DaemonPauseRecord = {
      version: DAEMON_RECORD_VERSION,
      paused,
      changedAtIso,
    };
    const validated = readDaemonPauseRecord(candidate);
    if (!validated.ok) {
      return validated;
    }
    const target = this.statePath;
    if (target === null) {
      this.inMemoryPause = validated.record;
      return validated;
    }
    await writeSingleRecordFile(target, validated.record);
    return validated;
  }

  async read(): Promise<DaemonPauseState> {
    const state = await this.readPauseFile();
    if (state.status === 'ok') {
      return state.record.paused
        ? { state: 'paused', record: state.record }
        : { state: 'clear', record: state.record };
    }
    if (state.status === 'missing') {
      return { state: 'clear', record: null };
    }
    return { state: 'unreadable' };
  }

  private readPauseFile(): Promise<SingleRecordFileState<DaemonPauseRecord>> {
    return readSingleRecordFileState(
      this.statePath,
      this.inMemoryPause,
      readDaemonPauseRecord,
      this.options?.readOnly === true,
    );
  }

  private get statePath(): string | null {
    const { stateDir } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    return join(stateDir, 'daemon', 'paused.json');
  }
}
