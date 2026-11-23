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
import { MAX_CUTOVER_JOURNAL_ENTRIES, readCutoverShadowParkRecord, type CutoverShadowParkRecord } from '../../domain/cutover-records.js';
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
import { sha256HexDigest } from './AttemptArtifactAdapter.adapter.js';

export const CUTOVER_JOURNAL_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('cutover-journal.json', {
  // v2: an intent may carry a request digest; v1 and unversioned records still load (v1 intents never held one).
  writerVersion: 2,
  acceptedVersions: [1, 2],
});

/**
 * SW2a2: the shadow-park journal's own version policy (`shadow-park-journal.json`).
 * The writer stamps schemaVersion 3; the reader accepts 2 and 3 only because the
 * shared policy assertion requires the previous version, and the stored-record
 * parser still refuses every `schemaVersion !== 3` record — a v2 record inside
 * the shadow-park journal is corrupt, never loaded.
 */
export const CUTOVER_SHADOW_PARK_JOURNAL_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('shadow-park-journal.json', {
  writerVersion: 3,
  acceptedVersions: [2, 3],
});

export interface CutoverJournalAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `cutover-journal.json`. */
  readonly fileName?: string;
  /** Read-only: every append is refused as `store-read-only`; reads never quarantine. */
  readonly readOnly?: boolean;
  /**
   * SW2a2: shadow-park mode. The instance then stores to `shadow-park-journal.json`
   * (the only file name it accepts, defaulted when omitted), writes schemaVersion 3
   * records, requires every entry to carry a valid `shadowPark` record and refuses
   * at the entry cap with `journal-capacity-exceeded`.
   */
  readonly shadowPark?: boolean;
}

const DEFAULT_FILE_NAME = 'cutover-journal.json';
const OTHER_STORE_FILE_NAMES = [
  'cutover-shadow-attestations.json',
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
/**
 * GR1b: `shadow-import/<owner>/<repo>/<runEntryId>` keys in the separate
 * shadow-intake journal. Segments are bounded like the CLI repository
 * segments and the entry id is a canonical ULID.
 */
export const SHADOW_IMPORT_KEY = /^shadow-import\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ENTRY_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_DIGEST = /^[0-9a-f]{40,64}$/;
const SAVE_REF = /^refs\/fleet\/saved\/[A-Za-z0-9._/-]{1,120}$/;
const OUTCOMES = ['completed', 'refused', 'ambiguous'];
const ENTRY_FIELDS = ['key', 'kind', 'entryId', 'recordedAtIso', 'outcome', 'reasonCode', 'digest', 'commitId', 'saveRef'];
const RESULT_ONLY_FIELDS = ['outcome', 'reasonCode', 'commitId', 'saveRef'] as const;
const MAX_PREFIX_LENGTH = 256;
const MAX_ISO_LENGTH = 64;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
/** SW2a2: the only file name a shadow-park instance accepts, and its default. */
const SHADOW_PARK_FILE_NAME = 'shadow-park-journal.json';
/** SW2a2: `cutover/shadow-park-<32 hex>@<revision>`; capture 1 is the entryId digest. */
const SHADOW_PARK_KEY = /^cutover\/shadow-park-([0-9a-f]{32})@[0-9]+$/;
/** SW2a2: the base fields plus the `shadowPark` record, allowed only in shadow-park mode. */
const SHADOW_PARK_ENTRY_FIELDS = [...ENTRY_FIELDS, 'shadowPark'];

export function isCutoverJournalKey(key: unknown): key is string {
  return typeof key === 'string' && (CUTOVER_KEY.test(key) || RELAUNCH_KEY.test(key) || SHADOW_IMPORT_KEY.test(key));
}

export type CutoverJournalEntryRead =
  | { readonly ok: true; readonly entry: CutoverJournalEntry }
  | { readonly ok: false; readonly reason: 'invalid-entry' | 'invalid-key' };

/** SW2a2: a shadow-park entry read also carries the validated park record. */
export type ShadowParkJournalEntryRead =
  | { readonly ok: true; readonly entry: CutoverJournalEntry; readonly park: CutoverShadowParkRecord }
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
  // Each existing entry is read once into plain values inside the try: a stateful getter cannot answer differently later.
  const held: { readonly key: string; readonly kind: string; readonly entryId: string; readonly outcome: unknown }[] = [];
  try {
    if (!Array.isArray(existing) || existing.length > MAX_CUTOVER_JOURNAL_ENTRIES) return { ok: false, reason: 'invalid-entry' };
    // A full journal takes no further entry: record 10,001 would make the next read reject the whole file.
    if (existing.length >= MAX_CUTOVER_JOURNAL_ENTRIES) return { ok: false, reason: 'store-unreadable' };
    for (let index = 0; index < existing.length; index += 1) {
      const raw: unknown = index in existing ? existing[index] : undefined;
      if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid-entry' };
      const fields = raw as Record<string, unknown>;
      const { key, kind, entryId, outcome } = fields;
      if (typeof key !== 'string' || typeof kind !== 'string' || typeof entryId !== 'string') {
        return { ok: false, reason: 'invalid-entry' };
      }
      held.push({ key, kind, entryId, outcome });
    }
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
  const read = readCutoverJournalEntry(input);
  if (!read.ok) return read;
  const entry = read.entry;
  if (held.some((prior) => prior.entryId === entry.entryId)) return { ok: false, reason: 'invalid-entry' };
  const sameKey = held.filter((prior) => prior.key === entry.key);
  const hasIntent = sameKey.some((prior) => prior.kind === 'intent');
  const hasResult = sameKey.some((prior) => prior.kind === 'result');
  if (entry.kind === 'intent') {
    if (hasResult) return { ok: false, reason: 'intent-after-result' };
    return hasIntent ? { ok: false, reason: 'duplicate-intent' } : { ok: true, entry };
  }
  if (!hasIntent) return { ok: false, reason: 'result-without-intent' };
  if (sameKey.some((prior) => prior.kind === 'result' && prior.outcome !== 'ambiguous')) {
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

/**
 * SW2a2: read one shadow-park journal entry. The walk mirrors
 * `readCutoverJournalEntry`'s descriptor-first single-read snapshotting (a
 * throwing, stateful or accessor property is refused without ever running a
 * getter) but on `SHADOW_PARK_ENTRY_FIELDS`, so `shadowPark` — and nothing
 * else new — is allowed. `shadowPark` must be present and valid through
 * `readCutoverShadowParkRecord`, and the key must be
 * `cutover/shadow-park-<32 hex>@<revision>` whose hex segment is the first 32
 * hex chars of the sha256 of the park's `entryId`. The base fields are
 * validated by `readCutoverJournalEntry` over a snapshot-built plain copy, so
 * the v2 grammar (intents/results, result-only fields, bounded text) is
 * inherited without `ENTRY_FIELDS` being touched.
 */
export function readShadowParkJournalEntry(input: unknown, stored = false): ShadowParkJournalEntryRead {
  const invalid = { ok: false, reason: 'invalid-entry' } as const;
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid;
    const proto: unknown = Object.getPrototypeOf(input);
    if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(input).length > 0) return invalid;
    // One descriptor consultation for the whole object: enumerating with
    // `Object.keys` and then reading each descriptor again would let a Proxy
    // answer the two calls differently (a key vanishing or turning
    // non-enumerable between them). `getOwnPropertyDescriptors` snapshots the
    // metadata exactly once; the names and values below come only from that
    // snapshot, so an accessor property is refused before any getter runs and
    // a non-enumerable key is refused rather than silently skipped.
    const descriptors = Object.getOwnPropertyDescriptors(input) as Record<string, PropertyDescriptor | undefined>;
    const names = Object.keys(descriptors).filter((name) => descriptors[name]?.enumerable === true);
    if (Object.keys(descriptors).length !== names.length) return invalid;
    if (names.length > SHADOW_PARK_ENTRY_FIELDS.length + (stored ? 1 : 0)) return invalid;
    const snap: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.get !== undefined) return invalid;
      snap[name] = descriptor.value;
    }
    if (!isCutoverJournalKey(snap.key)) return { ok: false, reason: 'invalid-key' };
    const allowed = stored ? [...SHADOW_PARK_ENTRY_FIELDS, 'schemaVersion'] : SHADOW_PARK_ENTRY_FIELDS;
    if (names.some((name) => !allowed.includes(name))) return invalid;
    if (typeof snap.shadowPark !== 'object' || snap.shadowPark === null || Array.isArray(snap.shadowPark)) return invalid;
    const parkRead = readCutoverShadowParkRecord(snap.shadowPark);
    if (!parkRead.ok) return invalid;
    const base: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of ENTRY_FIELDS) if (name in snap) base[name] = snap[name];
    const read = readCutoverJournalEntry(base);
    if (!read.ok) return { ok: false, reason: read.reason };
    const match = SHADOW_PARK_KEY.exec(read.entry.key);
    if (match === null) return { ok: false, reason: 'invalid-key' };
    if (match[1] !== sha256HexDigest(parkRead.record.entryId).slice(0, 32)) return invalid;
    return { ok: true, entry: { ...read.entry, shadowPark: parkRead.record }, park: parkRead.record };
  } catch {
    return invalid;
  }
}

/** Pure: whether one shadow-park entry may follow `existing` (the whole journal, in append order). */
export function prepareShadowParkJournalAppend(
  existing: readonly CutoverJournalEntry[],
  input: unknown,
): CutoverJournalDecision {
  const held: { readonly key: string; readonly kind: string; readonly entryId: string; readonly outcome: unknown }[] = [];
  try {
    if (!Array.isArray(existing) || existing.length > MAX_CUTOVER_JOURNAL_ENTRIES) return { ok: false, reason: 'invalid-entry' };
    // A full journal takes no further entry: the cap is a typed refusal here, not unreadable state.
    if (existing.length >= MAX_CUTOVER_JOURNAL_ENTRIES) return { ok: false, reason: 'journal-capacity-exceeded' };
    for (let index = 0; index < existing.length; index += 1) {
      const raw: unknown = index in existing ? existing[index] : undefined;
      if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid-entry' };
      const fields = raw as Record<string, unknown>;
      const { key, kind, entryId, outcome } = fields;
      if (typeof key !== 'string' || typeof kind !== 'string' || typeof entryId !== 'string') {
        return { ok: false, reason: 'invalid-entry' };
      }
      held.push({ key, kind, entryId, outcome });
    }
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
  const read = readShadowParkJournalEntry(input);
  if (!read.ok) return read;
  const entry = read.entry;
  if (held.some((prior) => prior.entryId === entry.entryId)) return { ok: false, reason: 'invalid-entry' };
  const sameKey = held.filter((prior) => prior.key === entry.key);
  const hasIntent = sameKey.some((prior) => prior.kind === 'intent');
  const hasResult = sameKey.some((prior) => prior.kind === 'result');
  if (entry.kind === 'intent') {
    if (hasResult) return { ok: false, reason: 'intent-after-result' };
    return hasIntent ? { ok: false, reason: 'duplicate-intent' } : { ok: true, entry };
  }
  if (!hasIntent) return { ok: false, reason: 'result-without-intent' };
  if (sameKey.some((prior) => prior.kind === 'result' && prior.outcome !== 'ambiguous')) {
    return { ok: false, reason: 'result-after-final-result' };
  }
  return { ok: true, entry };
}

/**
 * SW2a2: read one stored shadow-park record. `readStoreRecordSchemaVersion` runs
 * under the shadow-park policy (which accepts 2 only to satisfy the shared
 * policy assertion), and every `schemaVersion !== 3` record is invalid — a v2
 * record inside `shadow-park-journal.json` is corrupt, never loaded.
 */
export function readStoredShadowParkJournalRecord(raw: unknown): VersionedRecordParseResult<CutoverJournalEntry> {
  const versionCheck = readStoreRecordSchemaVersion(raw, CUTOVER_SHADOW_PARK_JOURNAL_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') return versionCheck;
  if (versionCheck.schemaVersion !== 3) return { status: 'invalid' };
  const read = readShadowParkJournalEntry(raw, true);
  if (!read.ok) return { status: 'invalid' };
  return { status: 'ok', record: read.entry, schemaVersion: versionCheck.schemaVersion };
}

export class CutoverJournalAdapter implements CutoverJournalPort {
  private readonly inMemoryEntries: CutoverJournalEntry[] = [];
  private readonly target: string | null;

  constructor(private readonly options?: CutoverJournalAdapterOptions) {
    const { stateDir, fileName } = options ?? {};
    const shadowParkMode = options?.shadowPark === true;
    if (shadowParkMode) {
      // SW2a2: a shadow-park instance stores only to the shadow-park journal.
      if (fileName !== undefined && fileName !== SHADOW_PARK_FILE_NAME) {
        throw new Error('CutoverJournalAdapter in shadowPark mode stores only to shadow-park-journal.json');
      }
    } else if (fileName === SHADOW_PARK_FILE_NAME) {
      // And the shadow-park journal is written only in shadowPark mode.
      throw new Error('CutoverJournalAdapter refuses shadow-park-journal.json without shadowPark mode');
    }
    if (fileName !== undefined) {
      if (OTHER_STORE_FILE_NAMES.includes(fileName)) {
        throw new Error('CutoverJournalAdapter refuses a fileName that collides with another store');
      }
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('CutoverJournalAdapter refuses unsafe state file name');
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0
        ? null
        : path.join(stateDir, fileName ?? (shadowParkMode ? SHADOW_PARK_FILE_NAME : DEFAULT_FILE_NAME));
  }

  async append(entry: CutoverJournalEntry): Promise<CutoverJournalAppendResult> {
    try {
      assertStoreWritable(this.options?.readOnly === true, 'CutoverJournalAdapter');
      const shadowParkMode = this.options?.shadowPark === true;
      const target = this.target;
      if (target === null) {
        // No await between the decision and the push: two racing appends cannot both pass.
        if (shadowParkMode) {
          const decision = prepareShadowParkJournalAppend(this.inMemoryEntries, entry);
          if (!decision.ok) return { outcome: 'refused', reason: decision.reason };
          this.inMemoryEntries.push(decision.entry);
          return { outcome: 'appended', entry: { ...decision.entry } };
        }
        if (this.inMemoryEntries.length >= MAX_CUTOVER_JOURNAL_ENTRIES) return { outcome: 'refused', reason: 'store-unreadable' };
        const decision = prepareCutoverJournalAppend(this.inMemoryEntries, entry);
        if (!decision.ok) return { outcome: 'refused', reason: decision.reason };
        this.inMemoryEntries.push(decision.entry);
        return { outcome: 'appended', entry: { ...decision.entry } };
      }
      return await withFileLock(`${target}.lock`, async (): Promise<CutoverJournalAppendResult> => {
        const entries = await this.readEntriesFromDisk(
          target,
          false,
          shadowParkMode ? readStoredShadowParkJournalRecord : readStoredCutoverJournalRecord,
        );
        if (shadowParkMode && entries.length >= MAX_CUTOVER_JOURNAL_ENTRIES) {
          return { outcome: 'refused', reason: 'journal-capacity-exceeded' };
        }
        const decision = shadowParkMode
          ? prepareShadowParkJournalAppend(entries, entry)
          : prepareCutoverJournalAppend(entries, entry);
        if (!decision.ok) return { outcome: 'refused', reason: decision.reason };
        entries.push(decision.entry);
        await writeJsonAtomically(
          target,
          entries.map((held) => ({
            ...held,
            schemaVersion: (shadowParkMode
              ? CUTOVER_SHADOW_PARK_JOURNAL_STORE_VERSION_POLICY
              : CUTOVER_JOURNAL_STORE_VERSION_POLICY
            ).writerVersion,
          })),
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
      const entries =
        this.target === null
          ? this.inMemoryEntries
          : await this.readEntriesFromDisk(
              this.target,
              true,
              this.options?.shadowPark === true ? readStoredShadowParkJournalRecord : readStoredCutoverJournalRecord,
            );
      return { outcome: 'listed', entries: entries.filter((held) => held.key.startsWith(prefix)).map((held) => ({ ...held })) };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  /** A read never quarantines (`readOnlyRead`); a writer quarantines the unreadable bytes under the lock. */
  private async readEntriesFromDisk(
    target: string,
    readOnlyRead: boolean,
    parseRecord: (raw: unknown) => VersionedRecordParseResult<CutoverJournalEntry>,
  ): Promise<CutoverJournalEntry[]> {
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
    const inspection = inspectVersionedRecordListBytes(buffer, parseRecord);
    if (inspection.status === 'unknown-version') throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, readOnlyRead || this.options?.readOnly === true);
    }
    if (inspection.records.length > MAX_CUTOVER_JOURNAL_ENTRIES) throw new Error('cutover journal holds too many entries');
    return [...inspection.records];
  }
}
