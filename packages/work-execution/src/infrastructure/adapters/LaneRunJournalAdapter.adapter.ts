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
import {
  LANE_RUN_JOURNAL_SCHEMA_VERSION,
  prepareLaneRunJournalAppend,
  readLaneRunJournalEntry,
} from '../../domain/lane-run-journal.js';
import type {
  LaneRunJournalAppendResult,
  LaneRunJournalPort,
} from '../../application/ports/out/LaneRunJournalPort.out-port.js';
import {
  assertStoreWritable,
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  rejectUnreadableStateFile,
  StateFileUnknownVersionError,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

/** The schema-version policy of `run-journal.json` (Q5a, D6). */
export const LANE_RUN_JOURNAL_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('run-journal.json', {
  writerVersion: LANE_RUN_JOURNAL_SCHEMA_VERSION,
  acceptedVersions: [1],
});

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
  return { ...entry, schemaVersion: LANE_RUN_JOURNAL_STORE_VERSION_POLICY.writerVersion };
}

/**
 * The versioned run journal reader's record parser, shared with
 * `fleet-v2 state check`: the `schemaVersion` check runs first, then the
 * full `readLaneRunJournalEntry` body validation. Never throws.
 */
export function parseVersionedLaneRunJournalStateRecord(raw: unknown): VersionedRecordParseResult<LaneRunJournalEntryRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, LANE_RUN_JOURNAL_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  try {
    const read = readLaneRunJournalEntry(raw);
    if (!read.ok) {
      return { status: 'invalid' };
    }
    return { status: 'ok', record: copyEntry(read.entry), schemaVersion: versionCheck.schemaVersion };
  } catch {
    return { status: 'invalid' };
  }
}

/** The run journal reader's record parser, shared with `fleet-v2 state check`. Never throws. */
export function parseLaneRunJournalStateRecord(raw: unknown): LaneRunJournalEntryRecord | undefined {
  const parsed = parseVersionedLaneRunJournalStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
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
      const stamped = copyEntry(decision.entry);
      this.inMemoryEntries.push(stamped);
      return { outcome: 'appended', entry: copyEntry(stamped) };
    }

    const lockPath = `${target}.lock`;
    return withFileLock(lockPath, async () => {
      const entries = await this.readEntriesFromDisk(target);
      const decision = prepareLaneRunJournalAppend(entries, entry);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason, detail: decision.detail };
      }
      const stamped = copyEntry(decision.entry);
      entries.push(stamped);
      await writeJsonAtomically(target, entries);
      return { outcome: 'appended', entry: copyEntry(stamped) };
    });
  }

  async listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    if (typeof runId !== 'string') {
      return [];
    }
    const entries = await this.entriesForScan();
    return entries.filter((entry) => entry.runId === runId).map(copyEntry);
  }

  async listForRuns(
    runIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>> {
    const wanted = new Set(runIds.filter((runId): runId is string => typeof runId === 'string'));
    const grouped = new Map<string, LaneRunJournalEntryRecord[]>();
    for (const runId of wanted) {
      grouped.set(runId, []);
    }
    if (wanted.size > 0) {
      const entries = await this.entriesForScan();
      for (const entry of entries) {
        const list = typeof entry.runId === 'string' ? grouped.get(entry.runId) : undefined;
        if (list !== undefined) {
          list.push(copyEntry(entry));
        }
      }
    }
    return grouped;
  }

  /** One read of the store for a scan: the in-memory list, or one file read. */
  private async entriesForScan(): Promise<readonly LaneRunJournalEntryRecord[]> {
    const target = this.statePath;
    return target === null ? this.inMemoryEntries : await this.readEntriesFromDisk(target);
  }

  async listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    if (typeof key !== 'string') {
      return [];
    }
    const entries = await this.entriesForScan();
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
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedLaneRunJournalStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    return [...inspection.records];
  }
}
