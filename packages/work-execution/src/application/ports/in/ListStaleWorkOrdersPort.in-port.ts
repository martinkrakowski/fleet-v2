// @generated inbound contract scaffold — refined for KF-36b-2.
/**
 * ListStaleWorkOrdersPort: list, read-only, the work orders whose state
 * disagrees with their lane runs: active work orders whose every run is
 * terminal, active work orders with no run, and non-terminal runs whose work
 * order is terminal; never writes.
 */

import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { WorkOrderStateValue } from '../../../domain/value-objects/WorkOrderState.vo.js';

/** Why a work order's state disagrees with its runs. */
export type StaleWorkOrderKind = 'runs-ended' | 'no-run' | 'run-on-closed-work-order';

/** One stale work order, with the ids, states and counts that show the disagreement. */
export interface StaleWorkOrderEntry {
  readonly kind: StaleWorkOrderKind;
  readonly workOrderId: string;
  readonly workOrderState: WorkOrderStateValue;
  readonly runs: readonly { readonly runId: string; readonly state: LaneRunStateValue }[];
  readonly attemptCount: number;
  /** runs-ended only: `merged` when any run ended merged, else `stopped`. A suggestion, never applied. */
  readonly suggestedClose: 'merged' | 'stopped' | null;
}

export interface ListStaleWorkOrdersRequest {
  readonly projectId?: string;
}

export type ListStaleWorkOrdersResult = {
  readonly outcome: 'listed';
  readonly entries: readonly StaleWorkOrderEntry[];
};

export interface ListStaleWorkOrdersPort {
  listStaleWorkOrders(request: ListStaleWorkOrdersRequest): Promise<ListStaleWorkOrdersResult>;
}
