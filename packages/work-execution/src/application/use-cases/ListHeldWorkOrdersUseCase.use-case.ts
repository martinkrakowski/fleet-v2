/**
 * ListHeldWorkOrdersUseCase: the read-only listing of held registrations
 * (PT1ca). Only settled (`held`) records are listed, oldest first; a row
 * names ids, the blocker and an integer age, never a path. A store that cannot
 * be read, or a record whose timestamp cannot be read, is refused `unreadable`
 * rather than answered as a shorter or empty list.
 */

import {
  MAX_HELD_WORK_ORDERS,
  computeHeldAgeMinutes,
} from '../../domain/held-work-order.js';
import { isCanonicalIso } from '../../domain/lane-activity-records.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  HeldWorkOrderSummary,
  ListHeldWorkOrdersPort,
  ListHeldWorkOrdersRequest,
  ListHeldWorkOrdersResult,
} from '../ports/in/ListHeldWorkOrdersPort.in-port.js';
import type { HeldWorkOrderRepositoryPort } from '../ports/out/HeldWorkOrderRepositoryPort.out-port.js';

export interface ListHeldWorkOrdersDependencies {
  readonly heldRepo: HeldWorkOrderRepositoryPort;
}

const INVALID_REQUEST: ListHeldWorkOrdersResult = { outcome: 'refused', reason: 'invalid-request' };
const UNREADABLE: ListHeldWorkOrdersResult = { outcome: 'refused', reason: 'unreadable' };

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class ListHeldWorkOrdersUseCase implements ListHeldWorkOrdersPort {
  constructor(private readonly deps?: ListHeldWorkOrdersDependencies) {}

  async listHeldWorkOrders(request?: ListHeldWorkOrdersRequest): Promise<ListHeldWorkOrdersResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListHeldWorkOrdersUseCase');
    }
    let nowMs = Date.now();
    if (request !== undefined) {
      const snapshot = snapshotPlainDataRecord(request);
      if (snapshot === null || Object.keys(snapshot).some((key) => key !== 'nowIso')) {
        return INVALID_REQUEST;
      }
      const requestedNowIso: unknown = snapshot.nowIso;
      if (requestedNowIso !== undefined) {
        if (!isCanonicalIso(requestedNowIso)) {
          return INVALID_REQUEST;
        }
        nowMs = Date.parse(requestedNowIso);
      }
    }

    let listed;
    try {
      listed = await this.deps.heldRepo.listHeldWorkOrders();
    } catch {
      return UNREADABLE;
    }
    if (listed.outcome !== 'ok' || listed.records.length > MAX_HELD_WORK_ORDERS) {
      return UNREADABLE;
    }
    const rows: { readonly heldMs: number; readonly summary: HeldWorkOrderSummary }[] = [];
    for (const record of listed.records) {
      if (record.stage !== 'held') {
        continue;
      }
      const ageMinutes = computeHeldAgeMinutes(record.heldAtIso, nowMs);
      if (ageMinutes === null) {
        return UNREADABLE;
      }
      rows.push({
        heldMs: Date.parse(record.heldAtIso),
        summary: {
          workOrderId: record.workOrderId,
          blockerKind: record.blockerKind,
          blockerId: record.blockerId,
          ageMinutes,
        },
      });
    }
    rows.sort(
      (left, right) =>
        left.heldMs - right.heldMs || compareCodeUnits(left.summary.workOrderId, right.summary.workOrderId),
    );
    return { outcome: 'listed', held: rows.map((row) => row.summary) };
  }
}
