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
  // v2: an intent may carry a request digest; v1 and unversioned records still load (v1 intents never held one).
  writerVersion: 2,
  acceptedVersions: [1, 2],
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
const STEP = '[a-z][a-z0-9-]{0,31}';
// `relaunch/<planDigest>/<lane>/<step>`, and `.../adopt/<step>` for the four keyed AdoptLane steps (CO28).
const RELAUNCH_KEY = new RegExp(`^relaunch/[0-9a-f]{7,64}/${SEGMENT}/${STEP}(/${STEP})?$`);
const ENTRY_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_DIGEST = /^[0-9a-f]{40,64}$/;
const SAVE_REF = /^refs\/fleet\/saved\/[A-Za-z0-9._/-]{1,120}$/;
const OUTCOMES = ['completed', 'refused', 'ambiguous'];
const ENTRY_FIELDS = ['key', 'kind', 'entryId', 'recordedAtIso', 'outcome', 'reasonCode', 'digest', 'commitId', 'saveRef'];
const RESULT_ONLY_FIELDS = ['outcome', 'reasonCode', 'commitId', 'saveRef'] as const;
const MAX_PREFIX_LENGTH = 256;
const MAX_ISO_LENGTH = 64;
const MAX_JOURNAL_ENTRIES = 10_000;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

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
  const invalid = { ok: false, reason: 'invalid-entry' } as const;
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid;
    const proto: unknown = Object.getPrototypeOf(input);
    if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(input).length > 0) return invalid;
    const names = Object.keys(input);
    if (names.length > ENTRY_FIELDS.length + 1) return invalid;
    // One read per property: a throwing or stateful getter cannot throw or answer twice.
    const snap: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of names) snap[name] = (input as Record<string, unknown>)[name];
    if (!isCutoverJournalKey(snap.key)) return { ok: false, reason: 'invalid-key' };
    const allowed = stored ? [...ENTRY_FIELDS, 'schemaVersion'] : ENTRY_FIELDS;
    if (names.some((name) => !allowed.includes(name))) return invalid;
    if (typeof snap.entryId !== 'string' || !ENTRY_ID.test(snap.entryId)) return invalid;
    if (typeof snap.recordedAtIso !== 'string' || snap.recordedAtIso.length > MAX_ISO_LENGTH || !isZonedIsoDateTime(snap.recordedAtIso)) {
      return invalid;
    }
    const base = { key: snap.key, kind: snap.kind as 'intent' | 'result', entryId: snap.entryId, recordedAtIso: snap.recordedAtIso };
    if (snap.kind === 'intent') {
      if (RESULT_ONLY_FIELDS.some((name) => snap[name] !== undefined && snap[name] !== null)) return invalid;
      // An intent may carry the request digest a replay pass verifies; absent or null is omitted.
      const digest = optionalMatch(snap.digest, HEX_DIGEST);
      if (digest === undefined) return invalid;
      return { ok: true, entry: digest === null ? base : { ...base, digest } };
    }
    if (snap.kind !== 'result' || typeof snap.outcome !== 'string' || !OUTCOMES.includes(snap.outcome)) return invalid;
    const reasonCode = optionalMatch(snap.reasonCode, REASON_CODE);
    const digest = optionalMatch(snap.digest, HEX_DIGEST);
    const commitId = optionalMatch(snap.commitId, HEX_DIGEST);
    const saveRef = optionalMatch(snap.saveRef, SAVE_REF);
    if ([reasonCode, digest, commitId, saveRef].includes(undefined)) return invalid;
    return {
      ok: true,
      entry: { ...base, outcome: snap.outcome as 'completed', reasonCode, digest, commitId, saveRef },
    };
  } catch {
    return invalid;
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
  try {
    if (!Array.isArray(existing) || existing.length > MAX_JOURNAL_ENTRIES) return { ok: false, reason: 'invalid-entry' };
    for (let index = 0; index < existing.length; index += 1) {
      const held: unknown = index in existing ? existing[index] : undefined;
      if (typeof held !== 'object' || held === null) return { ok: false, reason: 'invalid-entry' };
      const fields = held as Record<string, unknown>;
      if (typeof fields.key !== 'string' || typeof fields.kind !== 'string' || typeof fields.entryId !== 'string') {
        return { ok: false, reason: 'invalid-entry' };
      }
    }
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
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

/** Reads one stored record: v1 and unversioned records keep the v1 grammar (no digest on an intent), v2 allows it. */
export function readStoredCutoverJournalRecord(raw: unknown): VersionedRecordParseResult<CutoverJournalEntry> {
  const versionCheck = readStoreRecordSchemaVersion(raw, CUTOVER_JOURNAL_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') return versionCheck;
  const read = readCutoverJournalEntry(raw, true);
  if (!read.ok) return { status: 'invalid' };
  if (versionCheck.schemaVersion === 1 && read.entry.kind === 'intent' && read.entry.digest !== undefined && read.entry.digest !== null) {
    return { status: 'invalid' };
  }
  return { status: 'ok', record: read.entry, schemaVersion: versionCheck.schemaVersion };
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
        if (this.inMemoryEntries.length >= MAX_JOURNAL_ENTRIES) return { outcome: 'refused', reason: 'store-unreadable' };
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
    if (typeof prefix !== 'string' || prefix.length > MAX_PREFIX_LENGTH) return { outcome: 'unreadable' };
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
      const info = await fs.stat(target);
      // Oversized or non-file state is reported unreadable before it is read; it is never quarantined.
      if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) throw new Error('cutover journal is not a bounded file');
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    const inspection = inspectVersionedRecordListBytes(buffer, readStoredCutoverJournalRecord);
    if (inspection.status === 'unknown-version') throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, readOnlyRead || this.options?.readOnly === true);
    }
    if (inspection.records.length > MAX_JOURNAL_ENTRIES) throw new Error('cutover journal holds too many entries');
    return [...inspection.records];
  }
}
