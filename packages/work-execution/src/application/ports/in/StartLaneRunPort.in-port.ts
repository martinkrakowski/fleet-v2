// Implemented for lane K7-5b (owner decision K7-D7, "Start reserves first").
/**
 * StartLaneRunPort: start a lane run in the owner's order — reserve capacity
 * for the first attempt (the reserve chooses host and worktree path),
 * prepare the worktree at that path, prepare and place the brief there, then
 * record the first attempt `intent-recorded` and the run. It runs no model
 * and dispatches nothing. A retry with the same ids continues where a crash
 * or refusal stopped; `abandonStart` releases what an unfinished start
 * holds. The CLI wiring is K7-7 (`conductor start`).
 */

import type { LaneRunTier } from '../../../domain/lane-run-records.js';
import type { PrepareBriefPackageRequest } from './PrepareBriefPackagePort.in-port.js';

export interface StartLaneRunRequest {
  /** 'run-' + ULID; the same id on a retry. */
  readonly runId: string;
  /** 'attempt-' + id; the same id on a retry. */
  readonly attemptId: string;
  readonly tier: LaneRunTier;
  readonly runPolicyRevision: string;
  /**
   * The payload `brief prepare` takes; `worktreePath` and `attemptId` are set
   * by the use case, never by the caller.
   */
  readonly brief: PrepareBriefPackageRequest;
  readonly nowIso: string;
}

export type StartLaneRunStep = 'reserve' | 'worktree' | 'brief' | 'attempt' | 'run';

export type StartLaneRunResult =
  | {
      readonly outcome: 'started';
      readonly runId: string;
      readonly attemptId: string;
      readonly hostName: string;
      readonly worktreePath: string;
    }
  /** Nothing was written: no reservation is held. */
  | { readonly outcome: 'refused'; readonly reason: StartLaneRunRefusal }
  | { readonly outcome: 'no-capacity' }
  /**
   * A step after the reserve did not finish: the reservation stays held;
   * retry with the same ids, or abandon.
   */
  | {
      readonly outcome: 'incomplete';
      readonly runId: string;
      readonly attemptId: string;
      readonly step: StartLaneRunStep;
      readonly reason: string;
    };

export type StartLaneRunRefusal =
  | 'invalid-request'
  | 'work-order-missing'
  | 'work-order-not-open'
  | 'run-active-for-work-order'
  | 'project-not-active'
  | 'no-seat-plan'
  | 'no-acceptance-spec'
  | 'no-first-pass-seat'
  | 'run-exists'
  | 'no-host'
  | 'reserve-refused';

export interface AbandonStartRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly nowIso: string;
}

export type AbandonStartResult =
  | {
      readonly outcome: 'abandoned';
      readonly capacity: 'released' | 'none-held' | 'held';
      readonly attemptCancelled: boolean;
    }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'run-exists' | 'attempt-not-prepared' };

export interface StartLaneRunPort {
  startLaneRun(request: StartLaneRunRequest): Promise<StartLaneRunResult>;
  /** Release what an unfinished start holds; never touches the worktree or the brief (D15: no removal). */
  abandonStart(request: AbandonStartRequest): Promise<AbandonStartResult>;
}
