/**
 * ManageCutoverPort reads and moves the cutover record v1 (lanes CO30a and
 * CO30b): `status` is read-only, `rollback` pauses the daemon and lifts only
 * the train pause the cutover itself set, `switch` is the one-way door through
 * the shadow criteria, and `retire` closes the record after the rollback
 * window. `execute` accepts `unknown` and never throws; ids and codes only.
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

export interface ManageCutoverSwitchRequest {
  readonly move: 'switch';
  /** The revision the caller believes is stored; 0 is allowed when no record exists yet. */
  readonly expectedRevision: number;
  readonly operationId: string;
  /** 64 lowercase hex characters naming the relaunch plan the switch commits to. */
  readonly relaunchPlanDigest: string;
  readonly nowIso: string;
  readonly deadlineIso?: string;
}

export interface ManageCutoverRetireRequest {
  readonly move: 'retire';
  /** At least 1: a retire only follows a recorded switch. */
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly nowIso: string;
  readonly deadlineIso?: string;
}

export type ManageCutoverRequest =
  | ManageCutoverStatusRequest
  | ManageCutoverRollbackRequest
  | ManageCutoverSwitchRequest
  | ManageCutoverRetireRequest;

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

export interface ManageCutoverSwitchCompleted {
  readonly outcome: 'completed';
  readonly move: 'switch';
  readonly key: string;
  readonly replayed: boolean;
  readonly state: 'switched';
  readonly revision: number;
  readonly record: CutoverRecord;
}

export interface ManageCutoverRetireCompleted {
  readonly outcome: 'completed';
  readonly move: 'retire';
  readonly key: string;
  readonly replayed: boolean;
  readonly state: 'retired';
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
  | 'journal-refused'
  | 'not-shadow'
  | 'shadow-evidence-absent'
  | 'shadow-criteria-failed'
  | 'unrecorded-lanes'
  | 'conductor-driver-live'
  | 'inside-rollback-window';

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
  | 'cutover-record-write-failed'
  | 'shadow-evidence-unreadable'
  | 'shadow-evidence-unknown-version'
  | 'unrecorded-lanes-unknown';

export type ManageCutoverResult =
  | ManageCutoverStatusResult
  | ManageCutoverRollbackCompleted
  | ManageCutoverSwitchCompleted
  | ManageCutoverRetireCompleted
  | {
      readonly outcome: 'refused';
      readonly reason: ManageCutoverRefusalReason;
      /** The shadow criterion codes a refusal names; ids and codes only. */
      readonly failed?: readonly string[];
    }
  | { readonly outcome: 'unknown'; readonly reason: ManageCutoverUnknownReason };

export interface ManageCutoverPort {
  execute(request: unknown): Promise<ManageCutoverResult>;
}
