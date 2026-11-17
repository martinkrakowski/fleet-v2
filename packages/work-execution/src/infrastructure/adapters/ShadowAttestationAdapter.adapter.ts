/**
 * ShadowAttestationAdapter implements ShadowAttestationPort over the one
 * shadow-attestation ledger of a state directory (lane SH16):
 * `<stateDir>/cutover-shadow-attestations.json`, or memory only when no state
 * directory is given. A read never writes, locks or quarantines. A write is a
 * compare-and-set on the revision under the shared exclusive lock with an
 * atomic rename, and it never overwrites an unknown-version or unreadable
 * ledger. Files are read through `readBoundedStoreBytes`: a symlink, a
 * non-regular file or one over the size cap is unreadable, never absent.
 */

import * as path from 'node:path';

import type {
  ShadowAttestationPort,
  ShadowAttestationCasRefusalReason,
  ShadowAttestationCasResult,
  ShadowAttestationReadResult,
} from '../../application/ports/out/ShadowAttestationPort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  SHADOW_ATTESTATION_SCHEMA_VERSION,
  readShadowAttestations,
  type ShadowAttestationLedger,
} from '../../domain/shadow-attestations.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  assertStoreWritable,
  readBoundedStoreBytes,
  withFileLock,
  writeJsonAtomically,
  type SingleRecordInspection,
} from './file-store.js';

export const SHADOW_ATTESTATION_MAX_BYTES = 16_384;

export interface ShadowAttestationAdapterOptions {
  /** Directory for file-backed persistence; in-memory only when omitted or blank. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `cutover-shadow-attestations.json`. */
  readonly fileName?: string;
  /** Read-only: every compare-and-set is refused as `read-only`. */
  readonly readOnly?: boolean;
  readonly nowIso?: () => string;
}

const DEFAULT_FILE_NAME = 'cutover-shadow-attestations.json';
// Kept as a private copy because `OTHER_STORE_FILE_NAMES` in
// ShadowEvidenceAdapter.adapter.ts is non-exported and that file is frozen for
// this lane. Waived from the no-copy rule by the brief.
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
  'cutover.json',
  'cutover-journal.json',
  'merge-queue.json',
  'merge-records.json',
  'cutover-shadow.json',
];
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CAS_KEYS = ['expectedRevision', 'next', 'deadlineIso'];

/** The shared reader as a single-record inspection, for `fleet-v2 state check`. */
export function inspectSingleShadowAttestations(
  raw: unknown,
): SingleRecordInspection<ShadowAttestationLedger> {
  const read = readShadowAttestations(raw);
  if (read.ok) {
    return { status: 'ok', record: read.ledger };
  }
  return read.reason === 'unknown-version'
    ? { status: 'unknown-version', detail: 'ShadowAttestationLedger schemaVersion is not supported' }
    : { status: 'unreadable', detail: 'ShadowAttestationLedger is not a valid ledger' };
}

type Deadline = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'at'; readonly ms: number };

function readDeadline(value: unknown): Deadline {
  if (value === undefined) return { kind: 'none' };
  return isZonedIsoDateTime(value) ? { kind: 'at', ms: Date.parse(value) } : { kind: 'invalid' };
}

export class ShadowAttestationAdapter implements ShadowAttestationPort {
  private inMemoryLedger: ShadowAttestationLedger | null = null;
  private readonly target: string | null;
  private readonly now: () => string;

  constructor(private readonly options: ShadowAttestationAdapterOptions = {}) {
    const { stateDir, fileName } = options;
    if (fileName !== undefined) {
      if (OTHER_STORE_FILE_NAMES.includes(fileName)) {
        throw new Error('ShadowAttestationAdapter refuses a fileName that collides with another store');
      }
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('ShadowAttestationAdapter refuses unsafe state file name');
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0
        ? null
        : path.join(stateDir, fileName ?? DEFAULT_FILE_NAME);
    this.now = options.nowIso ?? ((): string => new Date().toISOString());
  }

  async read(options?: { readonly deadlineIso?: string }): Promise<ShadowAttestationReadResult> {
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
    readonly next: ShadowAttestationLedger;
    readonly deadlineIso?: string;
  }): Promise<ShadowAttestationCasResult> {
    try {
      return await this.compareAndSetUnchecked(request);
    } catch {
      return refused('unreadable');
    }
  }

  private async compareAndSetUnchecked(request: unknown): Promise<ShadowAttestationCasResult> {
    try {
      assertStoreWritable(this.options.readOnly === true, 'ShadowAttestationAdapter');
    } catch {
      return refused('read-only');
    }
    // Reading the request's own shape happens before any file I/O. A hostile
    // request (e.g. a Proxy whose `ownKeys` trap throws) must be refused as
    // `invalid-request`, never fall through to the outer catch below, which
    // is reserved for a problem reading the STORED ledger, not the caller's
    // input.
    let snapshot: Record<string, unknown> | null;
    try {
      snapshot = snapshotPlainDataRecord(request);
    } catch {
      return refused('invalid-request');
    }
    if (snapshot === null || Object.keys(snapshot).some((key) => !CAS_KEYS.includes(key))) {
      return refused('invalid-request');
    }
    const { expectedRevision } = snapshot;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return refused('invalid-request');
    }
    const deadline = readDeadline(snapshot.deadlineIso);
    if (deadline.kind === 'invalid') return refused('invalid-request');
    if (snapshot.next === undefined || snapshot.next === null) return refused('invalid-request');
    if (deadline.kind === 'at' && this.deadlineReached(deadline.ms)) return refused('deadline-exceeded');

    const target = this.target;
    if (target === null) {
      // No await between the decision and the store: two racing writes cannot both pass.
      const stop = this.precondition(this.memoryState(), expectedRevision, deadline);
      if (stop !== null) return stop;
      const resolved = this.resolveNext(snapshot.next, expectedRevision);
      if ('outcome' in resolved) return resolved;
      // Store a private copy: the ledger handed back to the caller must never
      // be the same object as the one held here, or a caller mutating its
      // own result would reach back into the store without a compareAndSet.
      this.inMemoryLedger = structuredClone(resolved.ledger);
      return { outcome: 'saved', ledger: resolved.ledger };
    }
    return withFileLock(`${target}.lock`, async (): Promise<ShadowAttestationCasResult> => {
      const stop = this.precondition(await this.load(), expectedRevision, deadline);
      if (stop !== null) return stop;
      const resolved = this.resolveNext(snapshot.next, expectedRevision);
      if ('outcome' in resolved) return resolved;
      await writeJsonAtomically(target, { ...resolved.ledger, schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION });
      return { outcome: 'saved', ledger: resolved.ledger };
    });
  }

  /** The refusal or conflict that stops a write over `current`, or null when the write may proceed. */
  private precondition(
    current: ShadowAttestationReadResult,
    expectedRevision: number,
    deadline: Deadline,
  ): ShadowAttestationCasResult | null {
    if (current.status === 'unknown-version' || current.status === 'unreadable') {
      return refused(current.status);
    }
    if (deadline.kind === 'at' && this.deadlineReached(deadline.ms)) return refused('deadline-exceeded');
    const currentRevision = current.status === 'ok' ? current.ledger.revision : null;
    if ((currentRevision ?? 0) !== expectedRevision) {
      return { outcome: 'conflict', currentRevision };
    }
    return null;
  }

  /** `request.next` validated against `readShadowAttestations`, then pinned to `expectedRevision + 1`. */
  private resolveNext(
    rawNext: unknown,
    expectedRevision: number,
  ): { ledger: ShadowAttestationLedger } | ShadowAttestationCasResult {
    const nextRead = readShadowAttestations(rawNext);
    if (!nextRead.ok) return refused('invalid-ledger');
    if (nextRead.ledger.revision !== expectedRevision + 1) return refused('invalid-request');
    return { ledger: nextRead.ledger };
  }

  /**
   * The in-memory store's current state, as a fresh copy: the same guarantee
   * disk mode gets for free from re-reading and re-parsing a file. Without
   * this, `read()` and the conflict check below would hand out (or compare
   * against) the live object the store itself holds, and a caller mutating
   * it would corrupt the store without ever going through `compareAndSet`.
   */
  private memoryState(): ShadowAttestationReadResult {
    return this.inMemoryLedger === null
      ? { status: 'missing' }
      : { status: 'ok', ledger: structuredClone(this.inMemoryLedger) };
  }

  private deadlineReached(deadlineMs: number): boolean {
    return Date.parse(this.now()) >= deadlineMs;
  }

  private async load(): Promise<ShadowAttestationReadResult> {
    const target = this.target;
    if (target === null) {
      return this.memoryState();
    }
    let bounded;
    try {
      bounded = await readBoundedStoreBytes(target, SHADOW_ATTESTATION_MAX_BYTES);
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
    const read = readShadowAttestations(raw);
    if (read.ok) return { status: 'ok', ledger: read.ledger };
    return read.reason === 'unknown-version' ? { status: 'unknown-version' } : { status: 'unreadable' };
  }
}

function refused(reason: ShadowAttestationCasRefusalReason): ShadowAttestationCasResult {
  return { outcome: 'refused', reason };
}
