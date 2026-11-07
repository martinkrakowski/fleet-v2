/**
 * HeldWorkOrderRepositoryAdapter implements HeldWorkOrderRepositoryPort (PT1ca).
 * Held registrations live in memory by default; when `stateDir` is configured
 * they persist in `held-work-orders.json`, a versioned record list written by an
 * atomic temp-file-then-rename write under an exclusive lock. Every record is
 * validated by the domain reader on the way in and on the way out, including
 * that its digest is the digest of its own request, and a store that cannot be
 * read stays `unreadable`: it is never quarantined, emptied or overwritten. The
 * F129 checks (a replay with a changed work order id, intent id or request
 * digest) run over the records under the lock, before anything is written.
 */

import * as path from 'node:path';

import type {
  CompleteHoldIntentResult,
  HeldWorkOrderListResult,
  HeldWorkOrderLookupResult,
  HeldWorkOrderRepositoryPort,
  RecordHoldIntentResult,
} from '../../application/ports/out/HeldWorkOrderRepositoryPort.out-port.js';
import {
  MAX_HELD_WORK_ORDERS,
  validateHeldWorkOrderRecord,
  type HeldWorkOrderRecord,
} from '../../domain/held-work-order.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  readBoundedStoreBytes,
  readStoreRecordSchemaVersion,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

export const HELD_WORK_ORDERS_FILE = 'held-work-orders.json';

/** The schema-version policy of `held-work-orders.json` (Q5a, D6). */
export const HELD_WORK_ORDER_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy(HELD_WORK_ORDERS_FILE, {
  writerVersion: 1,
  acceptedVersions: [1],
});

/**
 * Two records for one work order or one intent cannot be told apart safely, and
 * more than the bound cannot be listed: the file is then unreadable.
 */
export function duplicateHeldWorkOrderKeyError(records: readonly HeldWorkOrderRecord[]): string | null {
  if (records.length > MAX_HELD_WORK_ORDERS) {
    return 'too many held work orders';
  }
  const workOrderIds = new Set<string>();
  const intentIds = new Set<string>();
  for (const record of records) {
    if (workOrderIds.has(record.workOrderId)) {
      return 'duplicate held work order id';
    }
    if (intentIds.has(record.intentId)) {
      return 'duplicate held work order intent id';
    }
    workOrderIds.add(record.workOrderId);
    intentIds.add(record.intentId);
  }
  return null;
}

/** The versioned reader's record parser, shared with `fleet-v2 state check`. Never throws. */
export function parseVersionedHeldWorkOrderStateRecord(
  raw: unknown,
): VersionedRecordParseResult<HeldWorkOrderRecord> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, HELD_WORK_ORDER_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    const snapshot = snapshotPlainDataRecord(raw);
    if (snapshot === null) {
      return { status: 'invalid' };
    }
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(snapshot)) {
      if (key !== 'schemaVersion') {
        body[key] = snapshot[key];
      }
    }
    const record = validateHeldWorkOrderRecord(body);
    return record === null
      ? { status: 'invalid' }
      : { status: 'ok', record, schemaVersion: versionCheck.schemaVersion };
  } catch {
    return { status: 'invalid' };
  }
}

export interface HeldWorkOrderRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

type Mutation<T> = { readonly result: T; readonly next?: readonly HeldWorkOrderRecord[] };

const UNAVAILABLE = Symbol('held-work-order-store-unavailable');

function recordIntent(
  records: readonly HeldWorkOrderRecord[],
  record: HeldWorkOrderRecord,
): Mutation<RecordHoldIntentResult> {
  const byIntent = records.find((candidate) => candidate.intentId === record.intentId);
  const byWorkOrder = records.find((candidate) => candidate.workOrderId === record.workOrderId);
  if (
    byIntent !== undefined &&
    (byIntent.workOrderId !== record.workOrderId || byIntent.requestDigest !== record.requestDigest)
  ) {
    return { result: { outcome: 'refused', reason: 'intent-digest-mismatch' } };
  }
  if (byWorkOrder !== undefined) {
    if (byWorkOrder.stage === 'intent') {
      if (byWorkOrder.requestDigest !== record.requestDigest || byWorkOrder.intentId !== record.intentId) {
        return { result: { outcome: 'refused', reason: 'intent-digest-mismatch' } };
      }
      // A crashed earlier attempt left the intent: replay completes it, nothing is rewritten.
      return { result: { outcome: 'recorded', record: byWorkOrder } };
    }
    if (byWorkOrder.requestDigest !== record.requestDigest) {
      return { result: { outcome: 'refused', reason: 'held-request-mismatch' } };
    }
    return { result: { outcome: 'already-held', record: byWorkOrder } };
  }
  if (records.length >= MAX_HELD_WORK_ORDERS) {
    return { result: { outcome: 'refused', reason: 'store-full' } };
  }
  return { result: { outcome: 'recorded', record }, next: [...records, record] };
}

function completeIntent(
  records: readonly HeldWorkOrderRecord[],
  input: { readonly intentId: string; readonly workOrderId: string; readonly requestDigest: string },
): Mutation<CompleteHoldIntentResult> {
  const found =
    records.find((candidate) => candidate.intentId === input.intentId) ??
    records.find((candidate) => candidate.workOrderId === input.workOrderId);
  if (found === undefined) {
    return { result: { outcome: 'refused', reason: 'intent-not-found' } };
  }
  if (
    found.intentId !== input.intentId ||
    found.workOrderId !== input.workOrderId ||
    found.requestDigest !== input.requestDigest
  ) {
    return { result: { outcome: 'refused', reason: 'intent-digest-mismatch' } };
  }
  if (found.stage === 'held') {
    return { result: { outcome: 'held', record: found } };
  }
  const updated: HeldWorkOrderRecord = { ...found, stage: 'held' };
  return {
    result: { outcome: 'held', record: updated },
    next: records.map((candidate) => (candidate === found ? updated : candidate)),
  };
}

export class HeldWorkOrderRepositoryAdapter implements HeldWorkOrderRepositoryPort {
  private readonly stateDir: string | undefined;
  private memory: readonly HeldWorkOrderRecord[] = [];

  constructor(options?: HeldWorkOrderRepositoryAdapterOptions) {
    this.stateDir = options?.stateDir;
  }

  async listHeldWorkOrders(): Promise<HeldWorkOrderListResult> {
    const records = await this.readAll();
    return records === null ? { outcome: 'unreadable' } : { outcome: 'ok', records };
  }

  async findByWorkOrderId(workOrderId: string): Promise<HeldWorkOrderLookupResult> {
    return this.find((record) => record.workOrderId === workOrderId);
  }

  async findByIntentId(intentId: string): Promise<HeldWorkOrderLookupResult> {
    return this.find((record) => record.intentId === intentId);
  }

  async recordHoldIntent(input: HeldWorkOrderRecord): Promise<RecordHoldIntentResult> {
    const record = validateHeldWorkOrderRecord(input);
    if (record === null || record.stage !== 'intent') {
      return { outcome: 'refused', reason: 'invalid-record' };
    }
    const result = await this.mutate((records) => recordIntent(records, record));
    return result === UNAVAILABLE ? { outcome: 'refused', reason: 'store-unavailable' } : result;
  }

  async completeHoldIntent(input: {
    readonly intentId: string;
    readonly workOrderId: string;
    readonly requestDigest: string;
  }): Promise<CompleteHoldIntentResult> {
    const snapshot = snapshotPlainDataRecord(input);
    if (
      snapshot === null ||
      typeof snapshot.intentId !== 'string' ||
      typeof snapshot.workOrderId !== 'string' ||
      typeof snapshot.requestDigest !== 'string'
    ) {
      return { outcome: 'refused', reason: 'invalid-record' };
    }
    const checked = {
      intentId: snapshot.intentId,
      workOrderId: snapshot.workOrderId,
      requestDigest: snapshot.requestDigest,
    };
    const result = await this.mutate((records) => completeIntent(records, checked));
    return result === UNAVAILABLE ? { outcome: 'refused', reason: 'store-unavailable' } : result;
  }

  async deleteHeldWorkOrder(
    workOrderId: string,
    requestDigest: string,
  ): Promise<{ readonly outcome: 'deleted' | 'not-found' | 'refused' }> {
    const result = await this.mutate<{ readonly outcome: 'deleted' | 'not-found' | 'refused' }>((records) => {
      const found = records.find((record) => record.workOrderId === workOrderId);
      if (found === undefined) {
        return { result: { outcome: 'not-found' } };
      }
      if (found.requestDigest !== requestDigest) {
        return { result: { outcome: 'refused' } };
      }
      return { result: { outcome: 'deleted' }, next: records.filter((record) => record !== found) };
    });
    return result === UNAVAILABLE ? { outcome: 'refused' } : result;
  }

  private async find(
    predicate: (record: HeldWorkOrderRecord) => boolean,
  ): Promise<HeldWorkOrderLookupResult> {
    const records = await this.readAll();
    if (records === null) {
      return { outcome: 'unreadable' };
    }
    const found = records.find(predicate);
    return found === undefined ? { outcome: 'not-found' } : { outcome: 'found', record: found };
  }

  private async readAll(): Promise<readonly HeldWorkOrderRecord[] | null> {
    if (this.stateDir === undefined) {
      return this.memory;
    }
    try {
      return await this.readFile(path.join(this.stateDir, HELD_WORK_ORDERS_FILE));
    } catch {
      return null;
    }
  }

  /** The records of the file; `null` when it is unreadable. Never quarantines, never writes. */
  private async readFile(target: string): Promise<readonly HeldWorkOrderRecord[] | null> {
    const read = await readBoundedStoreBytes(target);
    if (read.status === 'missing') {
      return [];
    }
    if (read.status !== 'ok') {
      return null;
    }
    const inspection = inspectVersionedRecordListBytes(read.bytes, parseVersionedHeldWorkOrderStateRecord);
    if (inspection.status !== 'ok' || duplicateHeldWorkOrderKeyError(inspection.records) !== null) {
      return null;
    }
    return inspection.records;
  }

  private async mutate<T>(apply: (records: readonly HeldWorkOrderRecord[]) => Mutation<T>): Promise<T | typeof UNAVAILABLE> {
    const stateDir = this.stateDir;
    if (stateDir === undefined) {
      const outcome = apply(this.memory);
      if (outcome.next !== undefined) {
        this.memory = outcome.next;
      }
      return outcome.result;
    }
    const target = path.join(stateDir, HELD_WORK_ORDERS_FILE);
    try {
      return await withFileLock(`${target}.lock`, async () => {
        const records = await this.readFile(target);
        if (records === null) {
          return UNAVAILABLE;
        }
        const outcome = apply(records);
        if (outcome.next !== undefined) {
          await writeJsonAtomically(
            target,
            outcome.next.map((record) => ({
              ...record,
              schemaVersion: HELD_WORK_ORDER_STORE_VERSION_POLICY.writerVersion,
            })),
          );
        }
        return outcome.result;
      });
    } catch {
      return UNAVAILABLE;
    }
  }
}
