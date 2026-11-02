// @generated adapter scaffold — refined for lane DT3.
/**
 * DaemonStatusFileAdapter implements DaemonStatusPort over
 * `<stateDir>/daemon/status.json` (plan §3.4): writes build the version 1
 * record through `buildDaemonStatusRecord` — never a hand-stamped record — and
 * persist it under the shared exclusive lock with an atomic temp+rename; reads
 * report known absence separately from unreadable state, quarantining the exact
 * bytes when unreadable unless the adapter was opened read-only.
 */

import { join } from 'node:path';

import {
  buildDaemonStatusRecord,
  readDaemonStatusRecord,
  type BuildDaemonStatusInput,
  type DaemonStatusRead,
  type DaemonStatusRecord,
} from '../../domain/daemon-tick.js';
import type {
  DaemonStatusFileRead,
  DaemonStatusPort,
} from '../../application/ports/out/DaemonStatusPort.out-port.js';
import { assertStoreWritable } from './file-store.js';
import {
  readSingleRecordFileState,
  writeSingleRecordFile,
  type SingleRecordFileState,
} from './DaemonSingleRecordFile.helper.js';

export interface DaemonStatusFileAdapterOptions {
  /** When set, the status persists at `<stateDir>/daemon/status.json`. */
  readonly stateDir?: string;
  /** Read-only mode: reads never quarantine, and every write is refused. */
  readonly readOnly?: boolean;
}

export class DaemonStatusFileAdapter implements DaemonStatusPort {
  private inMemoryStatus: DaemonStatusRecord | null = null;

  constructor(private readonly options: DaemonStatusFileAdapterOptions = {}) {}

  async write(input: BuildDaemonStatusInput): Promise<DaemonStatusRead> {
    assertStoreWritable(this.options?.readOnly === true, 'DaemonStatusFileAdapter');
    const built = buildDaemonStatusRecord(input);
    if (!built.ok) {
      return built;
    }
    const target = this.statePath;
    if (target === null) {
      this.inMemoryStatus = built.record;
      return built;
    }
    await writeSingleRecordFile(target, built.record);
    return built;
  }

  async read(): Promise<DaemonStatusFileRead> {
    const state = await this.readFileState();
    if (state.status === 'ok') {
      return { status: 'ok', record: state.record };
    }
    return { status: state.status };
  }

  private readFileState(): Promise<SingleRecordFileState<DaemonStatusRecord>> {
    return readSingleRecordFileState(
      this.statePath,
      this.inMemoryStatus,
      readDaemonStatusRecord,
      this.options?.readOnly === true,
    );
  }

  private get statePath(): string | null {
    const { stateDir } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    return join(stateDir, 'daemon', 'status.json');
  }
}
