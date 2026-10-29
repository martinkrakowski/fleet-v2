// @generated inbound contract scaffold — refined for lane K7-2.
/**
 * RequestLaneRunStopPort: record a graceful or forced stop of one lane run as
 * a keyed run-journal intent (plan §3.8, §3.9.1). The record is the stop: the
 * driver obeys it on its next advance; this port never calls StopAttempt.
 */

import type { LaneRunKeyVia } from '../../../domain/lane-run-keys.js';
import type { RunStopMode } from '../../../domain/lane-run-transitions.js';

export interface RequestLaneRunStopRequest {
  readonly runId: string;
  readonly mode: RunStopMode; // 'graceful' | 'force'
  readonly via: LaneRunKeyVia; // 'cli' from the CLI
  /** The run revision the requester read; absent = the current revision, read just before the append. */
  readonly expectedRevision?: number;
  /** A fresh ULID from the caller. */
  readonly entryId: string;
  readonly nowIso: string;
}

export type RequestLaneRunStopResult =
  | { readonly outcome: 'stop-recorded'; readonly runId: string; readonly mode: RunStopMode; readonly key: string }
  /** K1b stop-already-requested, or the same key again: the record already says what was asked (exit 0). */
  | { readonly outcome: 'already-requested'; readonly runId: string; readonly mode: RunStopMode }
  | { readonly outcome: 'not-found'; readonly runId: string }
  | { readonly outcome: 'refused'; readonly reason: RequestLaneRunStopRefusal };

export type RequestLaneRunStopRefusal =
  | 'invalid-request' | 'run-terminal' | 'stale-revision' | 'stop-already-forced' | 'journal-refused';

export interface RequestLaneRunStopPort {
  requestLaneRunStop(request: RequestLaneRunStopRequest): Promise<RequestLaneRunStopResult>;
}
