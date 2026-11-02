// @generated adapter scaffold — implemented for migration step 2 (local transactional store).
/**
 * AttemptRepositoryAdapter implements AttemptRepositoryPort
 * (local-transactional-store). A fresh attempt identity is created per dispatch
 * and per fix round; saving over an existing attempt refuses any mutation of
 * immutable identity fields. Records live in memory by default and persist as
 * JSON via atomic temp-file-then-rename writes under an exclusive lock when `stateDir` is configured.
 * With `readOnly` the store never writes: an unreadable file is a read
 * error with no quarantine copy, and every save is refused.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { AttemptRecord, AttemptRunnerRecord, RunnerKind } from '../../domain/execution-records.js';
import { ATTEMPT_RECORD_SCHEMA_VERSION } from '../../domain/execution-records.js';
import {
  AttemptRevisionConflictError,
  type AttemptRepositoryPort,
} from '../../application/ports/out/AttemptRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
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

/** The schema-version policy of `attempts.json` (Q5a, D6). */
export const ATTEMPT_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('attempts.json', {
  writerVersion: ATTEMPT_RECORD_SCHEMA_VERSION,
  acceptedVersions: [1],
});

export interface AttemptRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
  /**
   * Read-only (telemetry plan §3.3): an unreadable file is a read error with no quarantine copy
   * (`StateFileUnreadableReadOnlyError`), and every write throws `ReadOnlyStateStoreError`.
   */
  readonly readOnly?: boolean;
}

/** Identity established at dispatch time; lifecycle fields may change, these may not. */
const immutableAttemptIdentityFields = [
  'workOrderId',
  'kind',
  'fixNumber',
  'priorAttemptId',
  'worktreePath',
  'baseCommit',
] as const;

function isAttemptRecord(value: unknown): value is AttemptRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.workOrderId === 'string';
}

/**
 * Records persisted before lane O14c1 carry no runner `kind` and always had
 * an opencode port. Reading them normalizes to `kind: 'opencode'` and a
 * `remotePort` of `null` when absent, so downstream code never sees a record
 * without a kind and never crashes on a missing port.
 *
 * Records persisted before the host name existed (lane H3a) normalize the
 * same way: `hostName: null`. Those are legacy records whose ssh alias lives in
 * `host`, and after-dispatch actions apply the legacy rule to them.
 */
/**
 * Normalize a legacy runner block to the canonical shape: absent or unknown
 * `kind` reads as `'opencode'`, absent `remotePort` reads as `null`, and a
 * blank or absent `hostName` reads as `null`.
 */
function normalizeRunner(runner: AttemptRunnerRecord): AttemptRunnerRecord {
  const raw = runner as AttemptRunnerRecord & { kind?: RunnerKind; hostName?: string | null };
  const kind: RunnerKind = raw.kind === 'agy' ? 'agy' : 'opencode';
  const hostName = typeof raw.hostName === 'string' && raw.hostName.trim() !== '' ? raw.hostName : null;
  if (kind === runner.kind && runner.remotePort !== undefined && runner.hostName === hostName) {
    return runner;
  }
  return {
    ...runner,
    kind,
    remotePort: runner.remotePort ?? null,
    hostName,
  };
}

function normalizeRecord(record: AttemptRecord): AttemptRecord {
  // A missing or non-integer revision reads as 0, so every record coming out
  // of the repository carries an integer revision. Every writer stamps
  // `schemaVersion` (Q5a, D6).
  const revision = Number.isInteger(record.revision) ? record.revision! : 0;
  const stamped: AttemptRecord = { ...record, schemaVersion: ATTEMPT_STORE_VERSION_POLICY.writerVersion };
  const runner = record.runner;
  if (runner === undefined || runner === null) {
    return revision === record.revision ? stamped : { ...stamped, revision };
  }
  const normalizedRunner = normalizeRunner(runner);
  if (normalizedRunner === runner) {
    return revision === record.revision ? stamped : { ...stamped, revision };
  }
  return { ...stamped, revision, runner: normalizedRunner };
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the body's identity check.
 */
export function parseVersionedAttemptStateRecord(raw: unknown): VersionedRecordParseResult<AttemptRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, ATTEMPT_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') {
    return versionCheck;
  }
  if (!isAttemptRecord(raw)) {
    return { status: 'invalid' };
  }
  return { status: 'ok', record: normalizeRecord(raw), schemaVersion: versionCheck.schemaVersion };
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseAttemptStateRecord(raw: unknown): AttemptRecord | undefined {
  const parsed = parseVersionedAttemptStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

export class AttemptRepositoryAdapter implements AttemptRepositoryPort {
  private readonly inMemoryRecords = new Map<string, AttemptRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options?: AttemptRepositoryAdapterOptions) {
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

  async saveAttempt(record: AttemptRecord): Promise<void> {
    assertStoreWritable(this.options?.readOnly === true, 'AttemptRepositoryAdapter');
    const stateDir = this.options?.stateDir;
    const guardExisting = (existing: AttemptRecord): void => {
      // Immutable identity fields are guarded first: a stale revision must
      // never mask an identity mutation.
      const changed = immutableAttemptIdentityFields.filter(
        (field) => existing[field] !== record[field],
      );
      if (changed.length > 0) {
        throw new Error(
          `Immutable attempt identity changed for ${record.id}: ${changed.join(', ')}`,
        );
      }
      // Compare-and-swap: the writer must build on exactly the stored
      // revision, so its revision is stored + 1. Missing revisions on either
      // side count as 0.
      const expected = existing.revision ?? 0;
      const actual = record.revision ?? 0;
      if (actual !== expected + 1) {
        throw new AttemptRevisionConflictError(record.id, expected, actual);
      }
    };

    if (stateDir === undefined) {
      const existing = this.inMemoryRecords.get(record.id);
      if (existing !== undefined) {
        guardExisting(existing);
      }
      this.inMemoryRecords.set(record.id, normalizeRecord(record));
      this.signal({ kind: 'attempt', id: record.id, stateFile: null, before: null, written: null });
      return;
    }

    const target = path.join(stateDir, 'attempts.json');
    const lockPath = path.join(stateDir, 'attempts.json.lock');

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    await withFileLock(lockPath, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(record.id);
      if (existing !== undefined) {
        guardExisting(existing);
      }
      records.set(record.id, normalizeRecord(record));
      await writeJsonAtomically(target, [...records.values()]);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    this.signal({
      kind: 'attempt',
      id: record.id,
      stateFile: path.resolve(target),
      before,
      written,
    });
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.inMemoryRecords.get(attemptId) ?? null;
    }
    const target = path.join(stateDir, 'attempts.json');
    const records = await this.readRecordsFromDisk(target);
    return records.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return [...this.inMemoryRecords.values()]
        .filter((record) => record.workOrderId === workOrderId)
        .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
    }
    const target = path.join(stateDir, 'attempts.json');
    const records = await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter((record) => record.workOrderId === workOrderId)
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return [...this.inMemoryRecords.values()].sort((a, b) =>
        b.updatedAtIso.localeCompare(a.updatedAtIso),
      );
    }
    const target = path.join(stateDir, 'attempts.json');
    const records = await this.readRecordsFromDisk(target);
    return [...records.values()].sort((a, b) =>
      b.updatedAtIso.localeCompare(a.updatedAtIso),
    );
  }

  private async readRecordsFromDisk(target: string): Promise<Map<string, AttemptRecord>> {
    const map = new Map<string, AttemptRecord>();
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return map;
      }
      throw error;
    }
    const inspection = inspectVersionedRecordListBytes(buffer, parseVersionedAttemptStateRecord);
    if (inspection.status === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, inspection.recordIndex);
    }
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    for (const item of inspection.records) {
      map.set(item.id, item);
    }
    return map;
  }
}
