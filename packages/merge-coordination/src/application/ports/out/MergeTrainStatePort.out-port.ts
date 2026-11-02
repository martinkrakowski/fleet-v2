// @generated outbound contract scaffold — refined for lane MC5.
/**
 * Persist one merge train's state: the snapshot of its records (train, queue
 * entries, batches, candidates, gate receipts, promotion receipts) with a
 * revision, and the per-train lease with its fencing token. A save happens
 * only at the stored revision plus one and only by the current, unexpired
 * lease holder with its fence, so a stale writer never writes after
 * takeover; a lease change never moves the revision. Known absence is
 * separate from unreadable state. The pure decisions in `train-lease.js`
 * own every fence value; this port only carries the train id alongside
 * them.
 */
import type {
  TrainLeaseHoldRequest,
  TrainLeaseRecord,
  TrainLeaseRefusal,
  TrainLeaseRenewRequest,
} from '../../use-cases/train-lease.js';
import type { TrainLeaseAcquireRequest } from '../../use-cases/train-lease.js';
import type { TrainRecord } from '../../../domain/entities/TrainRecord.js';
import type { QueueEntryRecord } from '../../../domain/entities/QueueEntryRecord.js';
import type { BatchRecord } from '../../../domain/entities/BatchRecord.js';
import type { CandidateRecord } from '../../../domain/entities/CandidateRecord.js';
import type { GateReceiptRecord } from '../../../domain/entities/GateReceiptRecord.js';
import type { PromotionReceiptRecord } from '../../../domain/entities/PromotionReceiptRecord.js';

/** One train's full record snapshot at one moment. */
export interface TrainSnapshot {
  readonly train: TrainRecord;
  readonly entries: readonly QueueEntryRecord[];
  readonly batches: readonly BatchRecord[];
  readonly candidates: readonly CandidateRecord[];
  readonly gateReceipts: readonly GateReceiptRecord[];
  readonly promotionReceipts: readonly PromotionReceiptRecord[];
}

/** The persisted state record: the snapshot plus its CAS revision. */
export interface TrainStateRecord {
  readonly revision: number;
  readonly snapshot: TrainSnapshot;
}

export type TrainStateRead =
  | { readonly outcome: 'ok'; readonly state: TrainStateRecord | null }
  | { readonly outcome: 'unreadable' };

export interface TrainStateSaveRequest {
  readonly trainId: string;
  readonly expectedRevision: number;
  readonly holderId: string;
  readonly fence: number;
  readonly nowIso: string;
  readonly snapshot: TrainSnapshot;
}

export type TrainStateRefusal =
  | TrainLeaseRefusal
  | 'revision-conflict'
  | 'invalid-snapshot'
  | 'state-unreadable'
  | 'lease-unreadable';

export type TrainStateSaveResult =
  | { readonly outcome: 'saved'; readonly revision: number }
  | { readonly outcome: 'refused'; readonly reason: TrainStateRefusal };

export type TrainLeaseResult =
  | { readonly outcome: 'ok'; readonly lease: TrainLeaseRecord }
  | { readonly outcome: 'refused'; readonly reason: TrainLeaseRefusal | 'lease-unreadable' };

export type TrainLeaseRead =
  | { readonly outcome: 'ok'; readonly lease: TrainLeaseRecord | null }
  | { readonly outcome: 'unreadable' };

export interface MergeTrainStatePort {
  readState(trainId: string): Promise<TrainStateRead>;
  saveState(request: TrainStateSaveRequest): Promise<TrainStateSaveResult>;
  acquireLease(trainId: string, request: TrainLeaseAcquireRequest): Promise<TrainLeaseResult>;
  renewLease(trainId: string, request: TrainLeaseRenewRequest): Promise<TrainLeaseResult>;
  releaseLease(trainId: string, request: TrainLeaseHoldRequest): Promise<TrainLeaseResult>;
  checkLease(trainId: string, request: TrainLeaseHoldRequest): Promise<TrainLeaseRefusal | 'lease-unreadable' | null>;
  readLease(trainId: string): Promise<TrainLeaseRead>;
}
