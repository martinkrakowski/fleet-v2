// @generated inbound contract scaffold — refined for KF-36b-1a.
/**
 * CloseWorkOrderPort: an operator closes a stale work order (one whose release
 * failed or never ran) as `merged` or `stopped`, refusing while anything still
 * holds it: a non-terminal run, an unfinished attempt, or a held slot. Ids and
 * reason codes only: no paths, no hosts.
 */

export const CLOSE_WORK_ORDER_STATES = ['merged', 'stopped'] as const;

export type CloseWorkOrderState = (typeof CLOSE_WORK_ORDER_STATES)[number];

export interface CloseWorkOrderRequest {
  readonly workOrderId: string;
  readonly state: CloseWorkOrderState;
  readonly nowIso?: string;
}

export type CloseWorkOrderRefusal =
  | 'invalid-request'
  | 'already-terminal'
  | 'run-not-terminal'
  | 'attempt-not-ended'
  | 'slot-held'
  | 'no-merged-run'
  | 'stale-revision';

export type CloseWorkOrderResult =
  | { readonly outcome: 'closed'; readonly workOrderId: string; readonly state: CloseWorkOrderState; readonly revision: number }
  | { readonly outcome: 'not-found'; readonly workOrderId: string }
  | {
      readonly outcome: 'refused';
      readonly workOrderId: string;
      readonly reason: CloseWorkOrderRefusal;
      readonly runIds?: readonly string[];
      readonly attemptIds?: readonly string[];
    };

export interface CloseWorkOrderPort {
  /** Close one work order, refusing while anything still holds it. */
  closeWorkOrder(request: CloseWorkOrderRequest): Promise<CloseWorkOrderResult>;
}
