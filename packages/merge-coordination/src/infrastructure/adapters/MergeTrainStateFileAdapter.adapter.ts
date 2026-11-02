/**
 * The file adapter for one merge train's state: `state.json` under the
 * train's directory, guarded by the per-train lease in `lease.json` and the
 * `train.lock` file. Every mutation runs under the lock; saves happen only
 * at the stored revision plus one and only by the current, unexpired lease
 * holder with its fence. A lease change never writes `state.json` and never
 * moves its revision. Unreadable state is reported, never repaired, and no
 * file bytes are ever echoed.
 */

import path from 'node:path';

import type {
  MergeTrainStatePort,
  TrainLeaseRead,
  TrainLeaseResult,
  TrainSnapshot,
  TrainStateRead,
  TrainStateSaveRequest,
  TrainStateSaveResult,
} from '../../application/ports/out/MergeTrainStatePort.out-port.js';
import type {
  TrainLeaseAcquireRequest,
  TrainLeaseHoldRequest,
  TrainLeaseRefusal,
  TrainLeaseRenewRequest,
} from '../../application/use-cases/train-lease.js';
import {
  checkTrainLeaseHeld,
  decideTrainLeaseAcquire,
  decideTrainLeaseRelease,
  decideTrainLeaseRenew,
  type TrainLeaseRecord,
} from '../../application/use-cases/train-lease.js';
import { validateTrainRecord } from '../../domain/entities/TrainRecord.js';
import { validateQueueEntryRecord } from '../../domain/entities/QueueEntryRecord.js';
import { validateBatchRecord } from '../../domain/entities/BatchRecord.js';
import { validateCandidateRecord } from '../../domain/entities/CandidateRecord.js';
import { validateGateReceiptRecord } from '../../domain/entities/GateReceiptRecord.js';
import { validatePromotionReceiptRecord } from '../../domain/entities/PromotionReceiptRecord.js';
import {
  readLeaseFile,
  readJsonFile,
  trainDirectory,
  withTrainLock,
  writeJsonAtomically,
} from './TrainStoreFiles.helper.js';

export class MergeTrainStateFileAdapter implements MergeTrainStatePort {
  private readonly stateDir: string;

  constructor(options: { stateDir: string }) {
    this.stateDir = options.stateDir;
  }

  async readState(trainId: string): Promise<TrainStateRead> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, trainId);
    } catch {
      return { outcome: 'unreadable' };
    }
    const read = await readJsonFile(path.join(dir, 'state.json'));
    if (read.kind === 'absent') {
      return { outcome: 'ok', state: null };
    }
    if (read.kind === 'unreadable') {
      return { outcome: 'unreadable' };
    }
    const state = validateStateRecord(read.value);
    if (state === null || state.snapshot.train.id !== trainId) {
      return { outcome: 'unreadable' };
    }
    return { outcome: 'ok', state };
  }

  async saveState(request: TrainStateSaveRequest): Promise<TrainStateSaveResult> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, request.trainId);
    } catch {
      return { outcome: 'refused', reason: 'invalid-snapshot' };
    }
    return withTrainLock(dir, async () => {
      const leaseRead = await readLeaseFile(dir);
      if (leaseRead.kind === 'unreadable') {
        return { outcome: 'refused', reason: 'lease-unreadable' };
      }
      const hold = checkTrainLeaseHeld(leaseRead.lease, {
        holderId: request.holderId,
        fence: request.fence,
        nowIso: request.nowIso,
      });
      if (hold !== null) {
        return { outcome: 'refused', reason: hold };
      }
      if (!isValidSnapshot(request.snapshot) || request.snapshot.train.id !== request.trainId) {
        return { outcome: 'refused', reason: 'invalid-snapshot' };
      }
      const stateRead = await readJsonFile(path.join(dir, 'state.json'));
      let storedRevision = 0;
      if (stateRead.kind === 'unreadable') {
        return { outcome: 'refused', reason: 'state-unreadable' };
      }
      if (stateRead.kind === 'ok') {
        const stored = validateStateRecord(stateRead.value);
        if (stored === null || stored.snapshot.train.id !== request.trainId) {
          return { outcome: 'refused', reason: 'state-unreadable' };
        }
        storedRevision = stored.revision;
      }
      if (request.expectedRevision !== storedRevision) {
        return { outcome: 'refused', reason: 'revision-conflict' };
      }
      if (!Number.isSafeInteger(storedRevision + 1)) {
        return { outcome: 'refused', reason: 'revision-conflict' };
      }
      const revision = storedRevision + 1;
      await writeJsonAtomically(path.join(dir, 'state.json'), {
        schemaVersion: 1,
        revision,
        snapshot: request.snapshot,
      });
      return { outcome: 'saved', revision };
    });
  }

  async acquireLease(trainId: string, request: TrainLeaseAcquireRequest): Promise<TrainLeaseResult> {
    return this.mutateLease(trainId, (current) => decideTrainLeaseAcquire(current, request));
  }

  async renewLease(trainId: string, request: TrainLeaseRenewRequest): Promise<TrainLeaseResult> {
    return this.mutateLease(trainId, (current) => decideTrainLeaseRenew(current, request));
  }

  async releaseLease(trainId: string, request: TrainLeaseHoldRequest): Promise<TrainLeaseResult> {
    return this.mutateLease(trainId, (current) => decideTrainLeaseRelease(current, request));
  }

  async checkLease(trainId: string, request: TrainLeaseHoldRequest): Promise<TrainLeaseRefusal | 'lease-unreadable' | null> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, trainId);
    } catch {
      return 'lease-unreadable';
    }
    const leaseRead = await readLeaseFile(dir);
    if (leaseRead.kind === 'unreadable') {
      return 'lease-unreadable';
    }
    return checkTrainLeaseHeld(leaseRead.lease, request);
  }

  async readLease(trainId: string): Promise<TrainLeaseRead> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, trainId);
    } catch {
      return { outcome: 'unreadable' };
    }
    const leaseRead = await readLeaseFile(dir);
    if (leaseRead.kind === 'unreadable') {
      return { outcome: 'unreadable' };
    }
    return { outcome: 'ok', lease: leaseRead.lease };
  }

  /** One lease change under the lock: read, decide, write only on `ok`. */
  private async mutateLease(
    trainId: string,
    decide: (current: TrainLeaseRecord | null) => { ok: true; lease: TrainLeaseRecord } | { ok: false; reason: TrainLeaseRefusal },
  ): Promise<TrainLeaseResult> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, trainId);
    } catch {
      return { outcome: 'refused', reason: 'lease-unreadable' };
    }
    return withTrainLock(dir, async () => {
      const leaseRead = await readLeaseFile(dir);
      if (leaseRead.kind === 'unreadable') {
        return { outcome: 'refused', reason: 'lease-unreadable' };
      }
      const decision = decide(leaseRead.lease);
      if (!decision.ok) {
        return { outcome: 'refused', reason: decision.reason };
      }
      await writeJsonAtomically(path.join(dir, 'lease.json'), { version: 1, ...decision.lease });
      return { outcome: 'ok', lease: decision.lease };
    });
  }
}

/** Validate a snapshot's every record with the six domain validators. */
function isValidSnapshot(snapshot: TrainSnapshot): boolean {
  if (snapshot === null || typeof snapshot !== 'object') {
    return false;
  }
  const raw = snapshot as unknown as Record<string, unknown>;
  if (!validateTrainRecord(raw.train).ok) {
    return false;
  }
  const arrays: Array<[unknown, (item: unknown) => { ok: boolean }]> = [
    [raw.entries, (item) => validateQueueEntryRecord(item)],
    [raw.batches, (item) => validateBatchRecord(item)],
    [raw.candidates, (item) => validateCandidateRecord(item)],
    [raw.gateReceipts, (item) => validateGateReceiptRecord(item)],
    [raw.promotionReceipts, (item) => validatePromotionReceiptRecord(item)],
  ];
  for (const [items, validate] of arrays) {
    if (!Array.isArray(items)) {
      return false;
    }
    for (const item of items) {
      if (!validate(item).ok) {
        return false;
      }
    }
  }
  return true;
}

/** Validate unknown input as a stored state record; null when it does not match. */
function validateStateRecord(value: unknown): { revision: number; snapshot: TrainSnapshot } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return null;
  }
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0) {
    return null;
  }
  const snapshot = record.snapshot;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return null;
  }
  const raw = snapshot as Record<string, unknown>;
  const train = validateTrainRecord(raw.train);
  if (!train.ok) {
    return null;
  }
  const arrays: Array<[readonly unknown[] | null, (item: unknown) => { ok: boolean }]> = [
    [asArray(raw.entries), (item) => validateQueueEntryRecord(item)],
    [asArray(raw.batches), (item) => validateBatchRecord(item)],
    [asArray(raw.candidates), (item) => validateCandidateRecord(item)],
    [asArray(raw.gateReceipts), (item) => validateGateReceiptRecord(item)],
    [asArray(raw.promotionReceipts), (item) => validatePromotionReceiptRecord(item)],
  ];
  for (const [items, validate] of arrays) {
    if (items === null) {
      return null;
    }
    for (const item of items) {
      if (!validate(item).ok) {
        return null;
      }
    }
  }
  return { revision: record.revision, snapshot: snapshot as TrainSnapshot };
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
