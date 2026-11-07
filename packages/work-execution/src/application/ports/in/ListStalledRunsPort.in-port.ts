/**
 * ListStalledRunsPort (PT1a): the runs parked longer than the stall threshold,
 * for `fleet-v2 conductor status --stalled`. Read-only: it writes nothing and
 * takes no lease. Rows are ids, a park class and an age, oldest first.
 */

import type { LaneRunParkClass } from '../../../domain/park-class.js';

export interface ListStalledRunsRequest {
  readonly nowIso: string;
}

export interface StalledRunRow {
  readonly runId: string;
  readonly class: LaneRunParkClass;
  readonly ageMinutes: number;
  readonly workOrderId: string;
}

export type ListStalledRunsResult =
  | { readonly outcome: 'listed'; readonly stallAfterMinutes: number; readonly stalled: readonly StalledRunRow[] }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'unreadable' };

export interface ListStalledRunsPort {
  listStalledRuns(request: ListStalledRunsRequest): Promise<ListStalledRunsResult>;
}
