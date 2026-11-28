// @generated outbound contract scaffold — refined for lane LB2-1.
/**
 * LaneServerSessionReadPort reads, read-only, what the lane servers report as
 * running (lanes-board plan §4, §5.1): the one source of confirmed running.
 * An unconfigured, unreachable, slow or unreadable server is a named
 * unavailable result, never an empty list. No path, URL, credential or
 * transport detail crosses the port. A summary carries only the keys it has:
 * an absent seat key is omitted, never present with `undefined`.
 */

export interface LaneServerSessionSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly seatRole?: string;
  readonly seatModel?: string;
}

export type LaneServerSessionUnavailableReason =
  | 'transport-error'
  | 'timeout'
  | 'not-configured'
  | 'unreadable';

export type LaneServerSessionListResult =
  | { readonly outcome: 'ok'; readonly sessions: readonly LaneServerSessionSummary[] }
  | { readonly outcome: 'unavailable'; readonly reason: LaneServerSessionUnavailableReason };

export interface LaneServerSessionReadPort {
  /** The sessions the lane servers report as running; read-only. */
  listRunningSessions(): Promise<LaneServerSessionListResult>;
}
