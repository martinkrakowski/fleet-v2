// @generated adapter scaffold — refined for lane CO27.
/**
 * CutoverJournalAdapter implements CutoverJournalPort over a local keyed store:
 * an in-process list that optionally persists to `<stateDir>/cutover-journal.json`
 * under an exclusive lock with an atomic rename. Every append runs the pure
 * decision below under the store's guard (the file lock, or a synchronous
 * check-and-push in memory), so two appends racing for one key never both pass
 * and a refused append writes nothing. An unreadable file or an unknown schema
 * version is reported (`store-unreadable`, `unreadable`), never an empty list.
 * Entries hold ids, codes and digests only: an unknown field or a free-text
 * code is refused. The pure decision functions live here, exported for tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type {
  CutoverJournalAppendResult,
  CutoverJournalEntry,
  CutoverJournalListResult,
  CutoverJournalPort,
  CutoverJournalRefusalCode,
} from '../../application/ports/out/CutoverJournalPort.out-port.js';
import {
  assertStoreWritable,
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  ReadOnlyStateStoreError,
  readStoreRecordSchemaVersion,
  rejectUnreadableStateFile,
  StateFileUnknownVersionError,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

export const CUTOVER_JOURNAL_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('cutover-journal.json', {
  writerVersion: 1,
  acceptedVersions: [1],
});

export interface CutoverJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `cutover-journal.json`. */
  readonly fileName?: string;
  /** Read-only: every append is refused as `store-read-only`; reads never quarantine. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'cutover-journal.json';
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'run-journal.json',
];
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

const SEGMENT = '[A-Za-z0-9._-]{1,64}';
const CUTOVER_KEY = new RegExp(`^cutover/${SEGMENT}@${SEGMENT}$`);
const RELAUNCH_KEY = new RegExp(`^relaunch/[0-9a-f]{7,64}/${SEGMENT}/[a-z][a-z0-9-]{0,31}$`);
const ENTRY_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_DIGEST = /^[0-9a-f]{40,64}$/;
const SAVE_REF = /^refs\/fleet\/saved\/[A-Za-z0-9._/-]{1,120}$/;
const OUTCOMES = ['completed', 'refused', 'ambiguous'];
const ENTRY_FIELDS = ['key', 'kind', 'entryId', 'recordedAtIso', 'outcome', 'reasonCode', 'digest', 'commitId', 'saveRef'];
const RESULT_ONLY_FIELDS = ['outcome', 'reasonCode', 'digest', 'commitId', 'saveRef'] as const;

export function isCutoverJournalKey(key: unknown): key is string {
  return typeof key === 'string' && (CUTOVER_KEY.test(key) || RELAUNCH_KEY.test(key));
}

export type CutoverJournalEntryRead =
  | { readonly ok: true; readonly entry: CutoverJournalEntry }
  | { readonly ok: false; readonly reason: 'invalid-entry' | 'invalid-key' };

function optionalMatch(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** Pure; never throws, never echoes the input. `schemaVersion` is allowed only for stored records. */
export function readCutoverJournalEntry(input: unknown, stored = false): CutoverJournalEntryRead {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, reason: 'invalid-entry' };
    }
    const raw = input as Record<string, unknown>;
    if (!isCutoverJournalKey(raw.key)) return { ok: false, reason: 'invalid-key' };
    const allowed = stored ? [...ENTRY_FIELDS, 'schemaVersion'] : ENTRY_FIELDS;
    if (Object.keys(raw).some((name) => !allowed.includes(name))) return { ok: false, reason: 'invalid-entry' };
    const invalid = { ok: false, reason: 'invalid-entry' } as const;
    if (typeof raw.entryId !== 'string' || !ENTRY_ID.test(raw.entryId)) return invalid;
    if (!isZonedIsoDateTime(raw.recordedAtIso)) return invalid;
    const base = { key: raw.key, kind: raw.kind as 'intent' | 'result', entryId: raw.entryId, recordedAtIso: raw.recordedAtIso };
    if (raw.kind === 'intent') {
      return RESULT_ONLY_FIELDS.some((name) => raw[name] !== undefined && raw[name] !== null)
        ? invalid
        : { ok: true, entry: base };
    }
    if (raw.kind !== 'result' || typeof raw.outcome !== 'string' || !OUTCOMES.includes(raw.outcome)) return invalid;
    const reasonCode = optionalMatch(raw.reasonCode, REASON_CODE);
    const digest = optionalMatch(raw.digest, HEX_DIGEST);
    const commitId = optionalMatch(raw.commitId, HEX_DIGEST);
    const saveRef = optionalMatch(raw.saveRef, SAVE_REF);
    if ([reasonCode, digest, commitId, saveRef].includes(undefined)) return invalid;
    return {
      ok: true,
      entry: { ...base, outcome: raw.outcome as 'completed', reasonCode, digest, commitId, saveRef },
    };
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

export type CutoverJournalDecision =
  | { readonly ok: true; readonly entry: CutoverJournalEntry }
  | { readonly ok: false; readonly reason: CutoverJournalRefusalCode };

/** Pure: whether `entry` may follow `existing` (the whole journal, in append order). */
export function prepareCutoverJournalAppend(
  existing: readonly CutoverJournalEntry[],
  input: unknown,
): CutoverJournalDecision {
  const read = readCutoverJournalEntry(input);
  if (!read.ok) return read;
  const entry = read.entry;
  if (existing.some((held) => held.entryId === entry.entryId)) return { ok: false, reason: 'invalid-entry' };
  const sameKey = existing.filter((held) => held.key === entry.key);
  const hasIntent = sameKey.some((held) => held.kind === 'intent');
  const hasResult = sameKey.some((held) => held.kind === 'result');
  if (entry.kind === 'intent') {
    if (hasResult) return { ok: false, reason: 'intent-after-result' };
    return hasIntent ? { ok: false, reason: 'duplicate-intent' } : { ok: true, entry };
  }
  if (!hasIntent) return { ok: false, reason: 'result-without-intent' };
  if (sameKey.some((held) => held.kind === 'result' && held.outcome !== 'ambiguous')) {
    return { ok: false, reason: 'result-after-final-result' };
  }
  return { ok: true, entry };
}

function parseStoredRecord(raw: unknown): VersionedRecordParseResult<CutoverJournalEntry> {
  const versionCheck = readStoreRecordSchemaVersion(raw, CUTOVER_JOURNAL_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') return versionCheck;
  const read = readCutoverJournalEntry(raw, true);
  return read.ok ? { status: 'ok', record: read.entry, schemaVersion: versionCheck.schemaVersion } : { status: 'invalid' };
}

export class CutoverJournalAdapter implements CutoverJournalPort {
  private readonly inMemoryEntries: CutoverJournalEntry[] = [];
  private readonly target: string | null;

  constructor(private readonly options?: CutoverJournalAdapterOptions) {
    const { stateDir, fileName } = options ?? {};
    if (fileName !== undefined) {
      if (OTHER_STORE_FILE_NAMES.includes(fileName)) {
        throw new Error('CutoverJournalAdapter refuses a fileName that collides with another store');
      }
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('CutoverJournalAdapter refuses unsafe state file name');
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0 ? null : path.join(stateDir, fileName ?? DEFAULT_FILE_NAME);
  }

  async append(entry: CutoverJournalEntry): Promise<CutoverJournalAppendResult> {
    try {
      assertStoreWritable(this.options?.readOnly === true, 'CutoverJournalAdapter');
      const target = this.target;
      if (target === null) {
        // No await between the decision and the push: two racing appends cannot both pass.
        const decision = prepareCutoverJournalAppend(this.inMemoryEntries, entry);
        if (!decision.ok) return { outcome: 'refused', reason: decision.reason };
        this.inMemoryEntries.push(decision.entry);
        return { outcome: 'appended', entry: { ...decision.entry } };
      }
      return await withFileLock(`${target}.lock`, async (): Promise<CutoverJournalAppendResult> => {
        const entries = await this.readEntriesFromDisk(target, false);
        const decision = prepareCutoverJournalAppend(entries, entry);
        if (!decision.ok) return { outcome: 'refused', reason: decision.reason };
        entries.push(decision.entry);
        await writeJsonAtomically(
          target,
          entries.map((held) => ({ ...held, schemaVersion: CUTOVER_JOURNAL_STORE_VERSION_POLICY.writerVersion })),
        );
        return { outcome: 'appended', entry: { ...decision.entry } };
      });
    } catch (error: unknown) {
      return { outcome: 'refused', reason: error instanceof ReadOnlyStateStoreError ? 'store-read-only' : 'store-unreadable' };
    }
  }

  async listByKeyPrefix(prefix: string): Promise<CutoverJournalListResult> {
    if (typeof prefix !== 'string') return { outcome: 'unreadable' };
    try {
      const entries = this.target === null ? this.inMemoryEntries : await this.readEntriesFromDisk(this.target, true);
      return { outcome: 'listed', entries: entries.filter((held) => held.key.startsWith(prefix)).map((held) => ({ ...held })) };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  /** A read never quarantines (`readOnlyRead`); a writer quarantines the unreadable bytes under the lock. */
  private async readEntriesFromDisk(target: string, readOnlyRead: boolean): Promise<CutoverJournalEntry[]> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    const inspection = inspectVersionedRecordListBytes(buffer, parseStoredRecord);
    if (inspection.status === 'unknown-version') throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, readOnlyRead || this.options?.readOnly === true);
    }
    return [...inspection.records];
  }
}
