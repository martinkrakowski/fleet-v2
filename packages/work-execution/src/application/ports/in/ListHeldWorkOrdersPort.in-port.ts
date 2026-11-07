/**
 * ListHeldWorkOrdersPort: the registrations that overlap-admission kept as
 * held (PT1ca), oldest first. Each row carries ids, a blocker kind and id, and
 * an integer age in minutes; never a path. An unreadable store is refused,
 * never answered as an empty list.
 */

import type { OverlapBlockerKind } from '../../../domain/held-work-order.js';

export interface ListHeldWorkOrdersRequest {
  readonly nowIso?: string;
}

export interface HeldWorkOrderSummary {
  readonly workOrderId: string;
  readonly blockerKind: OverlapBlockerKind;
  readonly blockerId: string;
  readonly ageMinutes: number;
}

export type ListHeldWorkOrdersResult =
  | {
      readonly outcome: 'listed';
      readonly held: readonly HeldWorkOrderSummary[];
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-request' | 'unreadable';
    };

export interface ListHeldWorkOrdersPort {
  listHeldWorkOrders(request?: ListHeldWorkOrdersRequest): Promise<ListHeldWorkOrdersResult>;
}
