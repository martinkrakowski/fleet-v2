// @generated adapter scaffold — refined for lane K1b-3.
/**
 * LaneRunJournalAdapter implements LaneRunJournalPort over a local JSON store:
 * an in-process list that optionally persists to `<stateDir>/run-journal.json`
 * under an exclusive lock with an atomic rename, exactly as the other
 * work-execution stores do. Every append runs K1b-2's pure append decision
 * (`prepareLaneRunJournalAppend`) under the store's guard — the file lock, or
 * a synchronous check-and-push in memory — so two appends racing for one key,
 * or two stops racing for one run, never both pass. A refusal writes nothing.
 * Like journal.json, the run journal emits no change signal: the API watches
 * only signalled stores. With `readOnly` the store never writes: an
 * unreadable file is a read error with no quarantine copy, and every append is
 * refused.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { prepareLaneRunJournalAppend, readLaneRunJournalEntry } from '../../domain/lane-run-journal.js';
import type {
  LaneRunJournalAppendResult,
  LaneRunJournalPort,
} from '../../application/ports/out/LaneRunJournalPort.out-port.js';
import { assertStoreWritable, inspectRecordListBytes, rejectUnreadableStateFile, withFileLock, writeJsonAtomically } from './file-store.js';

export interface LaneRunJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `run-journal.json`. */
  readonly fileName?: string;
  /**
   * Read-only (telemetry plan §3.3): an unreadable file is a read error with no quarantine copy
   * (`StateFileUnreadableReadOnlyError`), and every write throws `ReadOnlyStateStoreError`.
   */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'run-journal.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Fresh copies: entries hold only primitives, so a spread is a full copy. */
function copyEntry(entry: LaneRunJournalEntryRecord): LaneRunJournalEntryRecord {
  return { ...entry };
}

/** The run journal reader's record parser, shared with `fleet-v2 state check`. Never throws. */
export function parseLaneRunJournalStateRecord(raw: unknown): LaneRunJournalEntryRecord | undefined {
  try {
    const read = readLaneRunJournalEntry(raw);
    return read.ok ? read.entry : undefined;
  } catch {
    return undefined;
  }
}

export class LaneRunJournalAdapter implements LaneRunJournalPort {
  private readonly inMemoryEntries: LaneRunJournalEntryRecord[] = [];

  constructor(private readonly options?: LaneRunJournalAdapterOptions) {}

  async append(entry: LaneRunJournalEntryRecord): Promise<LaneRunJournalAppendResult> {
    assertStoreWritable(this.options?.readOnly === true, 'LaneRunJournalAdapter');
    const target = this.statePath;
    if (target === null) {
      // In-memory branch: the whole decide-then-push runs synchronously (no
      // await between reading the held entries and pushing), so two appends
      // racing for one key, or two stops racing for one run, can never both
      // pass within one process.
      const decision = prepareLaneRunJournalAppend(this.inMemoryEntries, entry);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason, detail: decision.detail };
      }
      this.inMemoryEntries.push(decision.entry);
      return { outcome: 'appended', entry: copyEntry(decision.entry) };
    }

    const lockPath = `${target}.lock`;
    return withFileLock(lockPath, async () => {
      const entries = await this.readEntriesFromDisk(target);
      const decision = prepareLaneRunJournalAppend(entries, entry);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason, detail: decision.detail };
      }
      entries.push(decision.entry);
      await writeJsonAtomically(target, entries);
      return { outcome: 'appended', entry: copyEntry(decision.entry) };
    });
  }

  async listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    if (typeof runId !== 'string') {
      return [];
    }
    const target = this.statePath;
    const entries = target === null ? this.inMemoryEntries : await this.readEntriesFromDisk(target);
    return entries.filter((entry) => entry.runId === runId).map(copyEntry);
  }

  async listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    if (typeof key !== 'string') {
      return [];
    }
    const target = this.statePath;
    const entries = target === null ? this.inMemoryEntries : await this.readEntriesFromDisk(target);
    return entries.filter((entry) => entry.key === key).map(copyEntry);
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options ?? {};
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error(
        'LaneRunJournalAdapter refuses a fileName that collides with another store',
      );
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error(
        'LaneRunJournalAdapter refuses unsafe state file name',
      );
    }
    return path.join(stateDir, name);
  }

  private async readEntriesFromDisk(target: string): Promise<LaneRunJournalEntryRecord[]> {
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
    const inspection = inspectRecordListBytes(buffer, parseLaneRunJournalStateRecord);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    return [...inspection.records];
  }
}
