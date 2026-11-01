// @generated inbound contract scaffold — refined for lane VZ2.
import type { ConductorSchedule, ConductorSessionStartMark } from '../../../domain/conductor-schedule.js';

/**
 * The read-only schedule view of the live lane runs (plan §3.6): one read
 * model the CLI (`conductor schedule`) and, next, `GET /v1/runs` both serve.
 * It never writes a store, and the result never carries a lease `holderId`,
 * `sshAlias`, `port`, `transport` or `worktreePath` — only what VZ1's
 * derivation returns plus the session-start marks.
 */

/** How many of the newest session-start marks one read returns. */
export const LIST_LANE_RUNS_SESSION_MARK_LIMIT = 50;

export interface ListLaneRunsRequest {
  readonly nowIso: string;
}

export type ListLaneRunsResult =
  | {
      readonly outcome: 'listed';
      readonly schedule: ConductorSchedule;
      readonly sessionStarts: readonly ConductorSessionStartMark[];
      /** True when older session-start marks were cut. */
      readonly truncated: boolean;
    }
  | { readonly outcome: 'rejected'; readonly reason: 'invalid-request' };

export interface ListLaneRunsPort {
  listLaneRuns(request: ListLaneRunsRequest): Promise<ListLaneRunsResult>;
}
