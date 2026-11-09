/**
 * ListStalledRunsPort (PT1a): the runs held longer than the stall threshold —
 * parked runs with a park class, non-parked runs with a state and a last
 * advanced time — for `fleet-v2 conductor status --stalled`. Read-only: it
 * writes nothing and takes no lease. Rows are ids, an age and a work order,
 * oldest first.
 */

import type { LaneRunParkClass } from '../../../domain/park-class.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';

export interface ListStalledRunsRequest {
  readonly nowIso: string;
}

export interface ParkedStallRow {
  readonly runId: string;
  readonly class: LaneRunParkClass;
  readonly ageMinutes: number;
  readonly workOrderId: string;
}

export interface IdleStallRow {
  readonly runId: string;
  readonly state: LaneRunStateValue;
  readonly ageMinutes: number;
  readonly workOrderId: string;
  readonly lastAdvancedAtIso: string;
}

export type StalledRunRow = ParkedStallRow | IdleStallRow;

export type ListStalledRunsResult =
  | { readonly outcome: 'listed'; readonly stallAfterMinutes: number; readonly stalled: readonly StalledRunRow[] }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'unreadable' };

export interface ListStalledRunsPort {
  listStalledRuns(request: ListStalledRunsRequest): Promise<ListStalledRunsResult>;
}
