// @generated inbound contract scaffold — refined for lane K7-3.
/**
 * ResumeLaneRunPort: record a resume of a parked lane run after the plan's
 * refusals (run-stopped, stale-revision, stop-pending, not-parked,
 * one-way-door), and let the driver apply a recorded resume under its run
 * lease: conduct entry, record save, result (plan §3.8). A resume is a
 * record the driver obeys: the requester never writes the run, so this port
 * never takes a run lease.
 */

import type { LaneRunKeyVia } from '../../../domain/lane-run-keys.js';
import type { LaneRunResumeRefusal } from '../../../domain/lane-run-transitions.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';

export interface RequestResumeRequest {
  readonly runId: string;
  readonly via: LaneRunKeyVia; // 'cli' from the CLI
  /** The run revision the requester read; absent = the current revision, read just before the append. */
  readonly expectedRevision?: number;
  /** A fresh ULID from the caller. */
  readonly entryId: string;
  readonly nowIso: string;
}

export type RequestResumeResult =
  | { readonly outcome: 'resume-recorded'; readonly runId: string; readonly to: LaneRunStateValue; readonly key: string }
  /** duplicate-key: the run already says what was asked (exit 0). */
  | { readonly outcome: 'already-requested'; readonly runId: string; readonly key: string }
  | { readonly outcome: 'not-found'; readonly runId: string }
  | { readonly outcome: 'refused'; readonly reason: LaneRunResumeRefusal | 'invalid-request' | 'journal-refused' };

export interface ApplyPendingResumeRequest {
  readonly runId: string;
  /** The run lease the driver holds; the record save lands only under it. */
  readonly lease: { readonly holderId: string; readonly fence: number };
  readonly nowIso: string;
}

export type ApplyPendingResumeResult =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'resumed'; readonly to: LaneRunStateValue; readonly key: string }
  | { readonly outcome: 'refused'; readonly key: string | null; readonly reason: LaneRunResumeRefusal | 'save-refused' | 'journal-refused' | 'run-not-found' };

export interface ResumeLaneRunPort {
  requestResume(request: RequestResumeRequest): Promise<RequestResumeResult>;
  applyPendingResume(request: ApplyPendingResumeRequest): Promise<ApplyPendingResumeResult>;
}
