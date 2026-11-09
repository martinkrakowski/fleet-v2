/**
 * ManageCutoverPort reads and moves the cutover record v1 (lane CO30a): `status`
 * is read-only and `rollback` pauses the daemon and lifts only the train pause
 * the cutover itself set. `switch` and `retire` are not built yet and are
 * refused as `move-not-implemented`. `execute` accepts `unknown` and never
 * throws; ids and codes only.
 */
import type { CutoverRecord, CutoverState } from '../../../domain/cutover-records.js';

export interface ManageCutoverStatusRequest {
  readonly move: 'status';
  readonly nowIso?: string;
  readonly deadlineIso?: string;
}

export interface ManageCutoverRollbackRequest {
  readonly move: 'rollback';
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly nowIso: string;
  readonly deadlineIso?: string;
}

export type ManageCutoverRequest = ManageCutoverStatusRequest | ManageCutoverRollbackRequest;

export interface ManageCutoverStatusResult {
  readonly outcome: 'completed';
  readonly move: 'status';
  readonly state: CutoverState;
  readonly revision: number;
  readonly record: CutoverRecord | null;
  readonly daemonStatus: 'present' | 'missing';
  readonly daemonLastTickOutcome: string | null;
  readonly daemonPause: 'paused' | 'clear';
  readonly trainPause: 'paused' | 'clear';
  readonly withinRollbackWindow: boolean | null;
}

export interface ManageCutoverRollbackCompleted {
  readonly outcome: 'completed';
  readonly move: 'rollback';
  readonly key: string;
  readonly replayed: boolean;
  readonly state: 'rolled-back';
  readonly revision: number;
  readonly record: CutoverRecord;
}

export type ManageCutoverRefusalReason =
  | 'invalid-request'
  | 'secret-shaped'
  | 'move-not-implemented'
  | 'not-switched'
  | 'revision-conflict'
  | 'invalid-clock'
  | 'intent-digest-mismatch'
  | 'journal-refused';

export type ManageCutoverUnknownReason =
  | 'deadline-exceeded'
  | 'cutover-record-unknown-version'
  | 'cutover-record-unreadable'
  | 'daemon-status-unreadable'
  | 'daemon-pause-unreadable'
  | 'train-pause-unreadable'
  | 'journal-unreadable'
  | 'journal-append-failed'
  | 'daemon-pause-write-failed'
  | 'train-pause-write-failed'
  | 'cutover-record-write-failed';

export type ManageCutoverResult =
  | ManageCutoverStatusResult
  | ManageCutoverRollbackCompleted
  | { readonly outcome: 'refused'; readonly reason: ManageCutoverRefusalReason }
  | { readonly outcome: 'unknown'; readonly reason: ManageCutoverUnknownReason };

export interface ManageCutoverPort {
  execute(request: unknown): Promise<ManageCutoverResult>;
}
