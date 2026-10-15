// @generated inbound contract scaffold — refined for migration step 1.
/**
 * InspectWorkOrderPort: return the work order, its attempt identities and its
 * active capacity reservations. Observed status is reported as records with
 * source references, never inferred into a pass.
 */

import type {
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';

export interface InspectWorkOrderRequest {
  readonly workOrderId: string;
}

export type InspectWorkOrderResult =
  | {
      readonly outcome: 'found';
      readonly workOrder: WorkOrderRecord;
      readonly attempts: readonly AttemptRecord[];
      readonly activeReservations: readonly CapacityReservationRecord[];
    }
  | { readonly outcome: 'not-found'; readonly workOrderId: string };

export interface InspectWorkOrderPort {
  /** Inspect one work order and its attempts and active reservations. */
  inspectWorkOrder(request: InspectWorkOrderRequest): Promise<InspectWorkOrderResult>;
}
