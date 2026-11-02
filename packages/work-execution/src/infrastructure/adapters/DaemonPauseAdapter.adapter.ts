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

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  DAEMON_RECORD_VERSION,
  readDaemonPauseRecord,
  type DaemonPauseRead,
  type DaemonPauseRecord,
  type DaemonPauseState,
} from '../../domain/daemon-tick.js';
import type { DaemonPausePort } from '../../application/ports/out/DaemonPausePort.out-port.js';
import {
  StateFileUnknownVersionError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  assertStoreWritable,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface DaemonPauseAdapterOptions {
  /** When set, the marker persists at `<stateDir>/daemon/paused.json`. */
  readonly stateDir?: string;
  /** Read-only mode: reads never quarantine, and every write is refused. */
  readonly readOnly?: boolean;
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

type PauseFileState =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly record: DaemonPauseRecord }
  | { readonly status: 'unreadable' };

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
    await withFileLock(`${target}.lock`, async () => {
      await writeJsonAtomically(target, validated.record);
    });
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

  private async readPauseFile(): Promise<PauseFileState> {
    const target = this.statePath;
    if (target === null) {
      return this.inMemoryPause === null
        ? { status: 'missing' }
        : { status: 'ok', record: { ...this.inMemoryPause } };
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (isENOENT(error)) {
        return { status: 'missing' };
      }
      return { status: 'unreadable' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString('utf8'));
    } catch {
      await this.rejectOrSwallow(target, 'not valid JSON', buffer);
      return { status: 'unreadable' };
    }
    const read = readDaemonPauseRecord(raw);
    if (!read.ok) {
      if (read.reason === 'unknown-version') {
        throw new StateFileUnknownVersionError(target, 0);
      }
      await this.rejectOrSwallow(target, read.error, buffer);
      return { status: 'unreadable' };
    }
    return { status: 'ok', record: read.record };
  }

  private async rejectOrSwallow(target: string, detail: string, buffer: Buffer): Promise<void> {
    try {
      await rejectUnreadableStateFile(target, detail, buffer, this.options?.readOnly === true);
    } catch (error: unknown) {
      if (
        error instanceof StateFileUnreadableError ||
        error instanceof StateFileUnreadableReadOnlyError
      ) {
        return;
      }
      throw error;
    }
  }

  private get statePath(): string | null {
    const { stateDir } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    return join(stateDir, 'daemon', 'paused.json');
  }
}
