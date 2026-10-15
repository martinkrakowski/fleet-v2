// @generated inbound contract scaffold — refined for migration step 1.
/**
 * RegisterWorkOrderPort: record an approved bounded work unit, base commit,
 * owned paths, policy revision and prerequisite work; reject invalid or
 * conflicting ownership. Recording is registration, not dispatch.
 */

import type { WorkOrderRecord } from '../../../domain/execution-records.js';

export interface RegisterWorkOrderRequest {
  readonly workOrderId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly ownedPaths: readonly string[];
  readonly policyRevision: string;
  readonly prerequisiteWorkOrderIds?: readonly string[];
  readonly nowIso?: string;
}

export type RegisterWorkOrderResult =
  | { readonly outcome: 'registered'; readonly workOrder: WorkOrderRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RegisterWorkOrderPort {
  /** Register one approved work unit. No dispatch is authorized by this call. */
  registerWorkOrder(request: RegisterWorkOrderRequest): Promise<RegisterWorkOrderResult>;
}
