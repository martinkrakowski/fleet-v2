/**
 * Shared engine for the single-record compare-and-set stores of a state
 * directory. Both `ShadowEvidenceAdapter` (lane SH2) and
 * `ShadowAttestationAdapter` (lane SH16) delegate to this class: the
 * read-only check and request snapshot, the deadline check, the lock-then-
 * re-read, the unknown-version and unreadable refusals, the conflict check
 * before `next` validation and the atomic rename write live here once.
 * What differs per store is injected: the file name and default, the size
 * cap, the ledger parser, the schema version, the collision list and the
 * adapter label used in refusal messages. The typed result shapes are
 * structural, so each adapter's port types accept them unchanged.
 */

import * as path from 'node:path';

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  assertStoreWritable,
  readBoundedStoreBytes,
  withFileLock,
  writeJsonAtomically,
  type SingleRecordInspection,
} from './file-store.js';

/** The one record a store holds, with the revision the compare-and-set races on. */
export type SingleRecordLedger = { readonly revision: number };

export type SingleRecordReadResult<L extends SingleRecordLedger> =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly ledger: L }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'unreadable' };

export type SingleRecordCasRefusalReason =
  | 'invalid-request'
  | 'invalid-ledger'
  | 'unknown-version'
  | 'unreadable'
  | 'read-only'
  | 'deadline-exceeded';

export type SingleRecordCasResult<L extends SingleRecordLedger> =
  | { readonly outcome: 'saved'; readonly ledger: L }
  | { readonly outcome: 'conflict'; readonly currentRevision: number | null }
  | { readonly outcome: 'refused'; readonly reason: SingleRecordCasRefusalReason };

/** A domain ledger reader: `readShadowLedger` or `readShadowAttestations`. */
export type ReadSingleRecordLedger<L extends SingleRecordLedger> = (
  raw: unknown,
) => { readonly ok: true; readonly ledger: L } | { readonly ok: false; readonly reason: string };

/** What genuinely differs between the single-record stores. */
export interface SingleRecordCasStoreConfig<L extends SingleRecordLedger> {
  /** Adapter label used in the constructor's refusal messages. */
  readonly adapterName: string;
  /** Ledger label used in inspection detail strings. */
  readonly ledgerLabel: string;
  readonly defaultFileName: string;
  /** Every other store's file name; a collision makes the constructor throw. */
  readonly otherStoreFileNames: readonly string[];
  readonly maxBytes: number;
  readonly readLedger: ReadSingleRecordLedger<L>;
  readonly schemaVersion: number;
}

/** Per-instance options, as each adapter's public options interface. */
export interface SingleRecordCasStoreOptions {
  /** Directory for file-backed persistence; in-memory only when omitted or blank. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to the store's own name. */
  readonly fileName?: string;
  /** Read-only: every compare-and-set is refused as `read-only`. */
  readonly readOnly?: boolean;
  readonly nowIso?: () => string;
}

const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CAS_KEYS = ['expectedRevision', 'next', 'deadlineIso'];

type Deadline = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'at'; readonly ms: number };

function readDeadline(value: unknown): Deadline {
  if (value === undefined) return { kind: 'none' };
  return isZonedIsoDateTime(value) ? { kind: 'at', ms: Date.parse(value) } : { kind: 'invalid' };
}

/** The shared reader as a single-record inspection, for `fleet-v2 state check`. */
export function inspectSingleRecordLedger<L extends SingleRecordLedger>(
  raw: unknown,
  readLedger: ReadSingleRecordLedger<L>,
  ledgerLabel: string,
): SingleRecordInspection<L> {
  const read = readLedger(raw);
  if (read.ok) {
    return { status: 'ok', record: read.ledger };
  }
  return read.reason === 'unknown-version'
    ? { status: 'unknown-version', detail: `${ledgerLabel} schemaVersion is not supported` }
    : { status: 'unreadable', detail: `${ledgerLabel} is not a valid ledger` };
}

export class SingleRecordCasStore<L extends SingleRecordLedger> {
  private inMemoryLedger: L | null = null;
  private readonly target: string | null;
  private readonly now: () => string;

  constructor(
    private readonly config: SingleRecordCasStoreConfig<L>,
    private readonly options: SingleRecordCasStoreOptions = {},
  ) {
    const { stateDir, fileName } = options;
    if (fileName !== undefined) {
      if (config.otherStoreFileNames.includes(fileName)) {
        throw new Error(`${config.adapterName} refuses a fileName that collides with another store`);
      }
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error(`${config.adapterName} refuses unsafe state file name`);
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0
        ? null
        : path.join(stateDir, fileName ?? config.defaultFileName);
    this.now = options.nowIso ?? ((): string => new Date().toISOString());
  }

  async read(options?: { readonly deadlineIso?: string }): Promise<SingleRecordReadResult<L>> {
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

  async compareAndSet(request: unknown): Promise<SingleRecordCasResult<L>> {
    try {
      return await this.compareAndSetUnchecked(request);
    } catch {
      return refused('unreadable');
    }
  }

  private async compareAndSetUnchecked(request: unknown): Promise<SingleRecordCasResult<L>> {
    try {
      assertStoreWritable(this.options.readOnly === true, this.config.adapterName);
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
    return withFileLock(`${target}.lock`, async (): Promise<SingleRecordCasResult<L>> => {
      const stop = this.precondition(await this.load(), expectedRevision, deadline);
      if (stop !== null) return stop;
      const resolved = this.resolveNext(snapshot.next, expectedRevision);
      if ('outcome' in resolved) return resolved;
      await writeJsonAtomically(target, { ...resolved.ledger, schemaVersion: this.config.schemaVersion });
      return { outcome: 'saved', ledger: resolved.ledger };
    });
  }

  /** The refusal or conflict that stops a write over `current`, or null when the write may proceed. */
  private precondition(
    current: SingleRecordReadResult<L>,
    expectedRevision: number,
    deadline: Deadline,
  ): SingleRecordCasResult<L> | null {
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

  /** `request.next` validated against the injected reader, then pinned to `expectedRevision + 1`. */
  private resolveNext(rawNext: unknown, expectedRevision: number): { ledger: L } | SingleRecordCasResult<L> {
    const nextRead = this.config.readLedger(rawNext);
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
  private memoryState(): SingleRecordReadResult<L> {
    return this.inMemoryLedger === null
      ? { status: 'missing' }
      : { status: 'ok', ledger: structuredClone(this.inMemoryLedger) };
  }

  private deadlineReached(deadlineMs: number): boolean {
    return Date.parse(this.now()) >= deadlineMs;
  }

  private async load(): Promise<SingleRecordReadResult<L>> {
    const target = this.target;
    if (target === null) {
      return this.memoryState();
    }
    let bounded;
    try {
      bounded = await readBoundedStoreBytes(target, this.config.maxBytes);
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
    const read = this.config.readLedger(raw);
    if (read.ok) return { status: 'ok', ledger: read.ledger };
    return read.reason === 'unknown-version' ? { status: 'unknown-version' } : { status: 'unreadable' };
  }
}

function refused(reason: SingleRecordCasRefusalReason): SingleRecordCasResult<never> {
  return { outcome: 'refused', reason };
}
