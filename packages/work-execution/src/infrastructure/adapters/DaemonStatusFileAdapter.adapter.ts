// @generated adapter scaffold — refined for lane DT3.
/**
 * DaemonStatusFileAdapter implements DaemonStatusPort over
 * `<stateDir>/daemon/status.json` (plan §3.4): writes build the version 1
 * record through `buildDaemonStatusRecord` — never a hand-stamped record — and
 * persist it under the shared exclusive lock with an atomic temp+rename; reads
 * report known absence separately from unreadable state, quarantining the exact
 * bytes when unreadable unless the adapter was opened read-only.
 */

import { promises as fs } from 'node:fs';
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
import {
  StateFileUnknownVersionError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  assertStoreWritable,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export interface DaemonStatusFileAdapterOptions {
  /** When set, the status persists at `<stateDir>/daemon/status.json`. */
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

type StatusFileState =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly record: DaemonStatusRecord }
  | { readonly status: 'unreadable' };

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
    await withFileLock(`${target}.lock`, async () => {
      await writeJsonAtomically(target, built.record);
    });
    return built;
  }

  async read(): Promise<DaemonStatusFileRead> {
    const state = await this.readFileState();
    if (state.status === 'ok') {
      return { status: 'ok', record: state.record };
    }
    return { status: state.status };
  }

  private async readFileState(): Promise<StatusFileState> {
    const target = this.statePath;
    if (target === null) {
      return this.inMemoryStatus === null
        ? { status: 'missing' }
        : { status: 'ok', record: { ...this.inMemoryStatus } };
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
    const read = readDaemonStatusRecord(raw);
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
    return join(stateDir, 'daemon', 'status.json');
  }
}
