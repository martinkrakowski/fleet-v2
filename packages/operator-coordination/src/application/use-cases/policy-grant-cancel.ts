/**
 * One shared policy-grant cancel for the issue and cancel use cases: cancel
 * one approved, unconsumed policy grant; on a revision conflict re-read once
 * and skip anything no longer approved-and-unconsumed; return `'cancelled' |
 * 'skipped' | 'conflict'`.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import { CoordinationRequestRevisionConflictError } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';

/**
 * Cancel one live policy grant: `{ ...record, state: 'cancelled', revision:
 * record.revision + 1, updatedAtIso: nowIso }` through the domain. A revision
 * conflict re-reads once and skips the record when another writer consumed or
 * cancelled it; a second conflict on a still-live grant reports it.
 */
export async function cancelPolicyGrantOnce(
  requestRepo: CoordinationRequestRepositoryPort,
  record: CoordinationRequestRecord,
  nowIso: string,
): Promise<'cancelled' | 'skipped' | 'conflict'> {
  const attempt = async (target: CoordinationRequestRecord): Promise<void> => {
    const cancelled: CoordinationRequestRecord = {
      ...target,
      state: 'cancelled',
      revision: target.revision + 1,
      updatedAtIso: nowIso,
    };
    await requestRepo.saveRequest(CoordinationRequest.fromRecord(cancelled).toRecord());
  };
  try {
    await attempt(record);
    return 'cancelled';
  } catch (error) {
    if (!(error instanceof CoordinationRequestRevisionConflictError)) {
      throw error;
    }
    const fresh = await requestRepo.findRequestById(record.id);
    if (fresh?.state !== 'approved' || (fresh?.consumptions.length ?? 0) > 0) {
      return 'skipped';
    }
    try {
      await attempt(fresh);
      return 'cancelled';
    } catch (error_) {
      if (error_ instanceof CoordinationRequestRevisionConflictError) {
        return 'conflict';
      }
      throw error_;
    }
  }
}
