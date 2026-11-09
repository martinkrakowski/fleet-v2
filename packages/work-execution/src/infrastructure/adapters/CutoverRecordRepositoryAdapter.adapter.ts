/**
 * CutoverRecordRepositoryAdapter implements CutoverRecordRepositoryPort over the
 * one cutover record of a state directory (lane CO30a): `<stateDir>/cutover.json`,
 * or memory only when no state directory is given. A read never writes, locks or
 * quarantines. A write is a compare-and-set on the revision under the shared
 * exclusive lock with an atomic rename, and it never overwrites an unknown-version
 * or unreadable record. Files are read through `readBoundedStoreBytes`: a symlink,
 * a non-regular file or one over 16 KiB is unreadable, never absent.
 */

import * as path from 'node:path';

import type {
  CutoverRecordCasRefusalReason,
  CutoverRecordCasResult,
  CutoverRecordReadResult,
  CutoverRecordRepositoryPort,
} from '../../application/ports/out/CutoverRecordRepositoryPort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { CUTOVER_RECORD_SCHEMA_VERSION, readCutoverRecord, type CutoverRecord } from '../../domain/cutover-records.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  assertStoreWritable,
  readBoundedStoreBytes,
  withFileLock,
  writeJsonAtomically,
  type SingleRecordInspection,
} from './file-store.js';

export const CUTOVER_RECORD_MAX_BYTES = 16_384;

export interface CutoverRecordRepositoryAdapterOptions {
  /** Directory for file-backed persistence; in-memory only when omitted or blank. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `cutover.json`. */
  readonly fileName?: string;
  /** Read-only: every compare-and-set is refused as `read-only`. */
  readonly readOnly?: boolean;
  readonly nowIso?: () => string;
}

const DEFAULT_FILE_NAME = 'cutover.json';
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'run-journal.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
  'killall-halt.json',
  'killall-train-pause.json',
  'cutover-journal.json',
  'merge-queue.json',
  'merge-records.json',
];
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CAS_KEYS = ['expectedRevision', 'next', 'deadlineIso'];

/** The shared reader as a single-record inspection, for `fleet-v2 state check`. */
export function inspectSingleCutoverRecord(raw: unknown): SingleRecordInspection<CutoverRecord> {
  const read = readCutoverRecord(raw);
  if (read.ok) {
    return { status: 'ok', record: read.record };
  }
  return read.reason === 'unknown-version'
    ? { status: 'unknown-version', detail: 'CutoverRecord schemaVersion is not supported' }
    : { status: 'unreadable', detail: 'CutoverRecord is not a valid record' };
}

type Deadline = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'at'; readonly ms: number };

function readDeadline(value: unknown): Deadline {
  if (value === undefined) return { kind: 'none' };
  return isZonedIsoDateTime(value) ? { kind: 'at', ms: Date.parse(value) } : { kind: 'invalid' };
}

export class CutoverRecordRepositoryAdapter implements CutoverRecordRepositoryPort {
  private inMemoryRecord: CutoverRecord | null = null;
  private readonly target: string | null;
  private readonly now: () => string;

  constructor(private readonly options: CutoverRecordRepositoryAdapterOptions = {}) {
    const { stateDir, fileName } = options;
    if (fileName !== undefined) {
      if (OTHER_STORE_FILE_NAMES.includes(fileName)) {
        throw new Error('CutoverRecordRepositoryAdapter refuses a fileName that collides with another store');
      }
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('CutoverRecordRepositoryAdapter refuses unsafe state file name');
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0 ? null : path.join(stateDir, fileName ?? DEFAULT_FILE_NAME);
    this.now = options.nowIso ?? ((): string => new Date().toISOString());
  }

  async read(options?: { readonly deadlineIso?: string }): Promise<CutoverRecordReadResult> {
    try {
      const deadline = readDeadline(options?.deadlineIso);
      if (deadline.kind === 'invalid' || (deadline.kind === 'at' && this.deadlineReached(deadline.ms))) {
        return { status: 'unreadable' };
      }
      return await this.load();
    } catch {
      return { status: 'unreadable' };
    }
  }

  async compareAndSet(request: {
    readonly expectedRevision: number;
    readonly next: CutoverRecord;
    readonly deadlineIso?: string;
  }): Promise<CutoverRecordCasResult> {
    try {
      return await this.compareAndSetUnchecked(request);
    } catch {
      return refused('unreadable');
    }
  }

  private async compareAndSetUnchecked(request: unknown): Promise<CutoverRecordCasResult> {
    try {
      assertStoreWritable(this.options.readOnly === true, 'CutoverRecordRepositoryAdapter');
    } catch {
      return refused('read-only');
    }
    const snapshot = snapshotPlainDataRecord(request);
    if (snapshot === null || Object.keys(snapshot).some((key) => !CAS_KEYS.includes(key))) {
      return refused('invalid-request');
    }
    const { expectedRevision } = snapshot;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return refused('invalid-request');
    }
    const deadline = readDeadline(snapshot.deadlineIso);
    if (deadline.kind === 'invalid') return refused('invalid-request');
    const validated = readCutoverRecord(snapshot.next);
    if (!validated.ok) return refused('invalid-record');
    const next = validated.record;
    if (next.revision !== expectedRevision + 1) return refused('invalid-request');
    if (deadline.kind === 'at' && this.deadlineReached(deadline.ms)) return refused('deadline-exceeded');

    const target = this.target;
    if (target === null) {
      // No await between the decision and the store: two racing writes cannot both pass.
      const stop = this.precondition(this.memoryState(), expectedRevision, deadline);
      if (stop !== null) return stop;
      this.inMemoryRecord = next;
      return { outcome: 'saved', record: next };
    }
    return withFileLock(`${target}.lock`, async (): Promise<CutoverRecordCasResult> => {
      const stop = this.precondition(await this.load(), expectedRevision, deadline);
      if (stop !== null) return stop;
      await writeJsonAtomically(target, { ...next, schemaVersion: CUTOVER_RECORD_SCHEMA_VERSION });
      return { outcome: 'saved', record: next };
    });
  }

  /** The refusal or conflict that stops a write over `current`, or null when the write may proceed. */
  private precondition(
    current: CutoverRecordReadResult,
    expectedRevision: number,
    deadline: Deadline,
  ): CutoverRecordCasResult | null {
    if (current.status === 'unknown-version' || current.status === 'unreadable') {
      return refused(current.status);
    }
    if (deadline.kind === 'at' && this.deadlineReached(deadline.ms)) return refused('deadline-exceeded');
    const currentRevision = current.status === 'ok' ? current.record.revision : null;
    if ((currentRevision ?? 0) !== expectedRevision) {
      return { outcome: 'conflict', currentRevision };
    }
    return null;
  }

  private memoryState(): CutoverRecordReadResult {
    return this.inMemoryRecord === null ? { status: 'missing' } : { status: 'ok', record: this.inMemoryRecord };
  }

  private deadlineReached(deadlineMs: number): boolean {
    return Date.parse(this.now()) >= deadlineMs;
  }

  private async load(): Promise<CutoverRecordReadResult> {
    const target = this.target;
    if (target === null) {
      return this.memoryState();
    }
    let bounded;
    try {
      bounded = await readBoundedStoreBytes(target, CUTOVER_RECORD_MAX_BYTES);
    } catch {
      return { status: 'unreadable' };
    }
    if (bounded.status === 'missing') return { status: 'missing' };
    if (bounded.status !== 'ok') return { status: 'unreadable' };
    let raw: unknown;
    try {
      raw = JSON.parse(bounded.bytes.toString('utf8'));
    } catch {
      return { status: 'unreadable' };
    }
    const read = readCutoverRecord(raw);
    if (read.ok) return { status: 'ok', record: read.record };
    return read.reason === 'unknown-version' ? { status: 'unknown-version' } : { status: 'unreadable' };
  }
}

function refused(reason: CutoverRecordCasRefusalReason): CutoverRecordCasResult {
  return { outcome: 'refused', reason };
}
