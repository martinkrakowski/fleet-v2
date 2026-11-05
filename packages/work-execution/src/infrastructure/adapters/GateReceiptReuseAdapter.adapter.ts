// Adapter (KS3): the gate receipt store behind GateReceiptReusePort, keyed by KS2's versioned key.
/**
 * GateReceiptReuseAdapter implements GateReceiptReusePort over an injected
 * record store. The receipt id is the SHA-256 of the key's fixed-order JSON, so
 * two equal keys address one record and a record whose stored key differs in
 * any component (a tampered or colliding file) is a miss. The first receipt
 * under a key stays (`putIfAbsent`), which makes recording idempotent. Only a
 * passing, secret-free, size-bounded result is stored. The default store is
 * in memory and bounded; a durable store is injected by the composition root.
 * Nothing here throws for runtime input.
 */

import { createHash } from 'node:crypto';

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isCheckCoverage } from '@fleet/evidence-and-acceptance';

import {
  GATE_RECEIPT_KEY_SCHEMA_VERSION,
  buildGateReceiptKey,
  decideGateReceiptReuse,
  readGateReceiptKeyRecord,
} from '../../domain/gate-receipt-key.js';
import type { GateReceiptKey } from '../../domain/gate-receipt-key.js';
import { GATE_RECEIPT_MAX_DETAIL_LENGTH } from '../../application/ports/out/GateReceiptReusePort.out-port.js';
import type {
  FindGateReceiptResult,
  GateReceiptReusePort,
  RecordGateReceiptRequest,
  RecordGateReceiptResult,
  StoredGatePassResult,
} from '../../application/ports/out/GateReceiptReusePort.out-port.js';

/** The minimal record store the adapter needs; implementations may throw, the adapter treats that as unavailable. */
export interface GateReceiptRecordStore {
  get(id: string): Promise<unknown>;
  /** Store `record` under `id` unless one exists; report which happened. */
  putIfAbsent(id: string, record: unknown): Promise<'created' | 'exists'>;
}

/** The most records the default in-memory store keeps; the oldest is dropped past it. */
export const IN_MEMORY_GATE_RECEIPT_STORE_MAX_RECORDS = 5000;

export class InMemoryGateReceiptRecordStore implements GateReceiptRecordStore {
  private readonly records = new Map<string, unknown>();

  constructor(private readonly maxRecords: number = IN_MEMORY_GATE_RECEIPT_STORE_MAX_RECORDS) {}

  async get(id: string): Promise<unknown> {
    return this.records.get(id);
  }

  async putIfAbsent(id: string, record: unknown): Promise<'created' | 'exists'> {
    if (this.records.has(id)) {
      return 'exists';
    }
    this.records.set(id, record);
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.records.delete(oldest.value);
    }
    return 'created';
  }

  get size(): number {
    return this.records.size;
  }
}

/** The key as one string with fixed field order, so equal keys always give the same text. */
export function gateReceiptKeyId(key: GateReceiptKey): string {
  const text = JSON.stringify([
    key.schemaVersion,
    key.predicateId,
    key.treeHash,
    key.predicateDefinitionDigest,
    key.toolchainVersions.node,
    key.toolchainVersions.yarn,
    key.toolchainVersions.hexagen,
    key.toolchainVersions.turbo,
    key.declaredEnvironmentDigest,
  ]);
  return createHash('sha256').update(text).digest('hex');
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** The result as it may be stored, or null when it is not a bounded, secret-free pass. Never throws. */
export function readStorableGateResult(value: unknown): StoredGatePassResult | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const exitCode = record.exitCode;
    const durationMs = record.durationMs;
    const detail = record.detail;
    if (record.verdict !== 'pass') {
      return null;
    }
    if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) {
      return null;
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      return null;
    }
    if (typeof detail !== 'string' || detail.length > GATE_RECEIPT_MAX_DETAIL_LENGTH || isSecretShaped(detail)) {
      return null;
    }
    const base = { verdict: 'pass' as const, exitCode: exitCode as number | null, durationMs, detail };
    if (record.coverage === undefined) {
      return base;
    }
    return isCheckCoverage(record.coverage) ? { ...base, coverage: record.coverage } : null;
  } catch {
    return null;
  }
}

export class GateReceiptReuseAdapter implements GateReceiptReusePort {
  private readonly store: GateReceiptRecordStore;

  constructor(store?: GateReceiptRecordStore) {
    this.store = store ?? new InMemoryGateReceiptRecordStore();
  }

  async findGateReceipt(suppliedKey: GateReceiptKey): Promise<FindGateReceiptResult> {
    try {
      const built = buildGateReceiptKey(suppliedKey as unknown as Parameters<typeof buildGateReceiptKey>[0]);
      if (!built.ok) {
        return { outcome: 'miss', reason: 'supplied-key-unreadable' };
      }
      const key = built.key;
      let stored: unknown;
      try {
        stored = await this.store.get(gateReceiptKeyId(key));
      } catch {
        return { outcome: 'miss', reason: 'store-unavailable' };
      }
      const decision = decideGateReceiptReuse(key, stored);
      if (decision.outcome === 'miss') {
        return { outcome: 'miss', reason: decision.reason };
      }
      const result = readStorableGateResult((stored as { result?: unknown }).result);
      return result === null
        ? { outcome: 'miss', reason: 'stored-result-unreadable' }
        : { outcome: 'hit', result };
    } catch {
      return { outcome: 'miss', reason: 'store-unavailable' };
    }
  }

  async recordGateReceipt(request: RecordGateReceiptRequest): Promise<RecordGateReceiptResult> {
    try {
      const built = buildGateReceiptKey(request.key as unknown as Parameters<typeof buildGateReceiptKey>[0]);
      if (!built.ok) {
        return { outcome: 'refused', reason: 'key-unreadable' };
      }
      const result = readStorableGateResult(request.result);
      if (result === null) {
        return { outcome: 'refused', reason: 'result-not-storable' };
      }
      const key = built.key;
      // The stored record is the key (readGateReceiptKeyRecord reads it back) with the result beside it.
      const record = { ...key, schemaVersion: GATE_RECEIPT_KEY_SCHEMA_VERSION, result };
      if (!readGateReceiptKeyRecord(record).ok) {
        return { outcome: 'refused', reason: 'key-unreadable' };
      }
      const written = await this.store.putIfAbsent(gateReceiptKeyId(key), record);
      return written === 'created' ? { outcome: 'recorded' } : { outcome: 'already-recorded' };
    } catch {
      return { outcome: 'unavailable' };
    }
  }
}
