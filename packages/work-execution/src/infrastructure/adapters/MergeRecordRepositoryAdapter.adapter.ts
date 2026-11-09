// @generated adapter scaffold — implemented for lane WB5a-store (local transactional store).
/**
 * MergeRecordRepositoryAdapter implements MergeRecordRepositoryPort
 * (local-transactional-store). Records live in an in-memory map by default;
 * when `stateDir` is configured the list is persisted as `merge-records.json`
 * through an atomic temp-file-then-rename write under an exclusive lock. The
 * store only persists what the domain's `decideMergeRecord` decides: the first
 * sighting of a (repository, number) key is kept, a repeat writes nothing, a
 * conflicting sighting is reported and never written, and `merger` moves only
 * `unknown` → `fleet`. There is no delete and no overwrite. Stored records
 * carry `schemaVersion: 1`; an unreadable or unknown-version file is a read
 * error (fail closed), never an empty store, and an unknown version is never
 * quarantined. With `readOnly` the store never writes: an unreadable file is a
 * read error with no quarantine copy, and every save is refused.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { readPlainRecord } from '@fleet/shared';
import type { PlainRecordSchema } from '@fleet/shared';

import {
  decideMergeRecord,
  MERGE_RECORD_LIMITS,
  MERGE_RECORD_MERGERS,
  MERGE_RECORD_SCHEMA_VERSION,
  MERGE_RECORD_SOURCES,
  MergeRecord,
  type MergeRecordOutcome,
  type MergeRecordRecord,
} from '../../domain/entities/MergeRecord.js';
import type {
  MergeRecordRepositoryPort,
  MergeRecordSaveOutcome,
} from '../../application/ports/out/MergeRecordRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import {
  assertStoreWritable,
  assertValidSchemaVersionPolicy,
  readOrQuarantineVersionedRecordList,
  readStoreRecordSchemaVersion,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

const MERGE_RECORD_STORE_FILE = 'merge-records.json';
const MERGE_RECORD_LOCK_TIMEOUT_MS = 10_000;

/** The schema-version policy of `merge-records.json`. */
export const MERGE_RECORD_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy(MERGE_RECORD_STORE_FILE, {
  writerVersion: MERGE_RECORD_SCHEMA_VERSION,
  acceptedVersions: [1],
});

const MERGE_RECORD_SCHEMA = {
  repository: { kind: 'string', maxLength: MERGE_RECORD_LIMITS.maxRepositoryLength },
  number: {
    kind: 'integer',
    min: MERGE_RECORD_LIMITS.minPullRequestNumber,
    max: MERGE_RECORD_LIMITS.maxPullRequestNumber,
  },
  headSha: { kind: 'string', maxLength: MERGE_RECORD_LIMITS.maxHeadShaLength },
  mergedAtIso: { kind: 'string', maxLength: MERGE_RECORD_LIMITS.maxIsoTimestampLength },
  firstSeenAtIso: { kind: 'string', maxLength: MERGE_RECORD_LIMITS.maxIsoTimestampLength },
  source: { kind: 'literal', values: MERGE_RECORD_SOURCES },
  merger: { kind: 'literal', values: MERGE_RECORD_MERGERS },
  actionRef: { kind: 'string', maxLength: MERGE_RECORD_LIMITS.maxActionRefLength, optional: true },
} as const satisfies PlainRecordSchema;

export interface MergeRecordRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
  /** Read-only: every write is refused, and an unreadable file is read without quarantine. */
  readonly readOnly?: boolean;
}

function isCanonicalIso(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * The ASCII lower-case of a repository string: GitHub owner and repository
 * names are ASCII, so only ASCII letters ever change case.
 */
function asciiLowerRepository(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `<repository>#<number>` on the canonical key: the store key of a merge record (one per key), ASCII-lower-cased so a pre-WB5b3 mixed-case stored record is still found (WB5b3). */
export function mergeRecordKey(repository: string, number: number): string {
  return `${asciiLowerRepository(repository)}#${number}`;
}

/** The runtime snapshot of a record under the store's own bounds, or null when it cannot be read. */
function readMergeRecordFields(raw: unknown): Readonly<Record<string, unknown>> | null {
  const read = readPlainRecord(raw, MERGE_RECORD_SCHEMA);
  if (!read.ok) {
    return null;
  }
  if (!isCanonicalIso(read.value.mergedAtIso) || !isCanonicalIso(read.value.firstSeenAtIso)) {
    return null;
  }
  return read.value;
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the record body is read without
 * casting and loaded through `MergeRecord.create`. Never throws.
 */
export function parseVersionedMergeRecordStateRecord(raw: unknown): VersionedRecordParseResult<MergeRecordRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, MERGE_RECORD_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  const fields = readMergeRecordFields(raw);
  if (fields === null) {
    return { status: 'invalid' };
  }
  // A stored record loads through `fromStored`: a pre-`actionRef`
  // `fleet-forge-action` record still loads, while a corrupt record or a
  // `fleet-forge-action`/`unknown` pair still fails closed.
  const result = MergeRecord.fromStored(fields);
  if (!result.success) {
    return { status: 'invalid' };
  }
  return { status: 'ok', record: result.value.toRecord(), schemaVersion: versionCheck.schemaVersion };
}

/** A detail naming the first key two stored records share, or undefined when every key is unique. */
export function mergeRecordListError(records: readonly MergeRecordRecord[]): string | undefined {
  const seen = new Set<string>();
  for (const record of records) {
    const key = mergeRecordKey(record.repository, record.number);
    if (seen.has(key)) {
      return `conflicting stored record for ${key}`;
    }
    seen.add(key);
  }
  return undefined;
}

type MergeRecordDecided =
  | { readonly kind: 'refused' }
  | { readonly kind: 'decided'; readonly outcome: MergeRecordOutcome; readonly record: MergeRecordRecord };

/**
 * One decision through the domain. A stored record is loaded through
 * `MergeRecord.fromStored` first, so a stored record the domain refuses to
 * load is never decided against. Never throws.
 */
function decideAgainstStored(
  stored: MergeRecordRecord | undefined,
  incoming: Readonly<Record<string, unknown>>,
): MergeRecordDecided {
  try {
    let storedRecord: MergeRecordRecord | null = null;
    if (stored !== undefined) {
      const loaded = MergeRecord.fromStored(stored);
      if (!loaded.success) {
        return { kind: 'refused' };
      }
      storedRecord = loaded.value.toRecord();
    }
    const decision = decideMergeRecord(storedRecord, incoming);
    if (!decision.success) {
      return { kind: 'refused' };
    }
    return { kind: 'decided', outcome: decision.outcome, record: decision.record };
  } catch {
    return { kind: 'refused' };
  }
}

function toSaveOutcome(outcome: MergeRecordOutcome, record: MergeRecordRecord): MergeRecordSaveOutcome {
  switch (outcome) {
    case 'create':
      return { outcome: 'created', record };
    case 'unchanged':
      return { outcome: 'unchanged', record };
    case 'upgrade-merger':
      return { outcome: 'merger-upgraded', record };
    case 'integrity-conflict':
      return { outcome: 'integrity-conflict', record };
  }
}

function isWritten(
  outcome: MergeRecordSaveOutcome,
): outcome is Extract<MergeRecordSaveOutcome, { readonly outcome: 'created' | 'merger-upgraded' }> {
  return outcome.outcome === 'created' || outcome.outcome === 'merger-upgraded';
}

const REFUSED: MergeRecordSaveOutcome = { outcome: 'refused', code: 'invalid' };

export class MergeRecordRepositoryAdapter implements MergeRecordRepositoryPort {
  private readonly inMemoryRecords = new Map<string, MergeRecordRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options?: MergeRecordRepositoryAdapterOptions) {
    this.changeSignal = options?.changeSignal ?? new NoopChangeSignalAdapter();
  }

  get signalEmitFailures(): number {
    return this.signalEmitFailuresCount;
  }

  private signal(sig: ChangeSignal): void {
    try {
      this.changeSignal.emit(sig);
    } catch {
      this.signalEmitFailuresCount += 1;
    }
  }

  private async safeStat(target: string): Promise<ChangeSignal['before']> {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile()) {
        return null;
      }
      return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch {
      return null;
    }
  }

  async saveMergeRecord(record: MergeRecordRecord): Promise<MergeRecordSaveOutcome> {
    assertStoreWritable(this.options?.readOnly === true, 'MergeRecordRepositoryAdapter');
    // The store's version check runs on the runtime input before any field is
    // read: a record carrying an unsupported `schemaVersion` is refused, never
    // silently accepted and rewritten with the writer's version.
    // Runtime input may be a hostile object (a Proxy whose traps throw): any
    // throw while reading it is a typed refusal, never a rejection.
    let incoming: Readonly<Record<string, unknown>> | null;
    try {
      const versionCheck = readStoreRecordSchemaVersion(record, MERGE_RECORD_STORE_VERSION_POLICY);
      incoming = versionCheck.status === 'ok' ? readMergeRecordFields(record) : null;
    } catch {
      incoming = null;
    }
    if (incoming === null) {
      return REFUSED;
    }
    const key = mergeRecordKey(incoming.repository as string, incoming.number as number);
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.saveInMemory(key, incoming);
    }
    return this.saveFile(key, incoming, stateDir);
  }

  private saveInMemory(key: string, incoming: Readonly<Record<string, unknown>>): MergeRecordSaveOutcome {
    const decided = decideAgainstStored(this.inMemoryRecords.get(key), incoming);
    if (decided.kind === 'refused') {
      return REFUSED;
    }
    const outcome = toSaveOutcome(decided.outcome, decided.record);
    if (isWritten(outcome)) {
      this.inMemoryRecords.set(key, outcome.record);
      this.signal({ kind: 'merge', id: key, stateFile: null, before: null, written: null });
    }
    return outcome;
  }

  private async saveFile(
    key: string,
    incoming: Readonly<Record<string, unknown>>,
    stateDir: string,
  ): Promise<MergeRecordSaveOutcome> {
    const target = path.join(stateDir, MERGE_RECORD_STORE_FILE);
    const lockPath = path.join(stateDir, `${MERGE_RECORD_STORE_FILE}.lock`);

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    const outcome = await withFileLock(
      lockPath,
      async (): Promise<MergeRecordSaveOutcome> => {
        before = await this.safeStat(target);
        const records = await this.readRecordsFromDisk(target, true);
        const decided = decideAgainstStored(records.get(key), incoming);
        if (decided.kind === 'refused') {
          return REFUSED;
        }
        const result = toSaveOutcome(decided.outcome, decided.record);
        if (!isWritten(result)) {
          return result;
        }
        records.set(key, result.record);
        const payload = [...records.values()].map((stored) => ({
          ...stored,
          schemaVersion: MERGE_RECORD_STORE_VERSION_POLICY.writerVersion,
        }));
        await writeJsonAtomically(target, payload);
        written = await this.safeStat(target);
        return result;
      },
      { timeoutMs: MERGE_RECORD_LOCK_TIMEOUT_MS },
    );

    if (isWritten(outcome)) {
      this.signal({ kind: 'merge', id: key, stateFile: path.resolve(target), before, written });
    }
    return outcome;
  }

  async findMergeRecord(repository: string, number: number): Promise<MergeRecordRecord | null> {
    const key = mergeRecordKey(repository, number);
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryRecords.get(key) ?? null;
    }
    const records = await this.readRecordsFromDisk(path.join(stateDir, MERGE_RECORD_STORE_FILE));
    return records.get(key) ?? null;
  }

  async listMergeRecords(): Promise<readonly MergeRecordRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return [...this.inMemoryRecords.values()];
    }
    const records = await this.readRecordsFromDisk(path.join(stateDir, MERGE_RECORD_STORE_FILE));
    return [...records.values()];
  }

  private async readRecordsFromDisk(target: string, lockHeld = false): Promise<Map<string, MergeRecordRecord>> {
    const map = new Map<string, MergeRecordRecord>();
    const records = await readOrQuarantineVersionedRecordList({
      filePath: target,
      parseRecord: parseVersionedMergeRecordStateRecord,
      findListError: mergeRecordListError,
      readOnly: this.options?.readOnly === true,
      lockHeld,
      lockTimeoutMs: MERGE_RECORD_LOCK_TIMEOUT_MS,
    });
    for (const item of records) {
      map.set(mergeRecordKey(item.repository, item.number), item);
    }
    return map;
  }
}
