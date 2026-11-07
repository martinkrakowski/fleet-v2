// @generated adapter stub — refined for lane T2c.
/**
 * PermissionRequestRepositoryAdapter implements PermissionRequestRepositoryPort
 * as pure in-process memory. It holds `PermissionRequest` entities so the
 * "first verdict wins" rule lives in the domain; a decided request is never
 * overwritten. Caps: at most 128 pending (no verdict) records and at most 512
 * records in total. When the total cap is reached the oldest decided records
 * are dropped first; pending records are never dropped. No filesystem, no
 * network, no subprocess, no clock reading, no console.
 */

import { PermissionRequest } from '../../domain/entities/PermissionRequest.js';
import type {
  PermissionRequestRecord,
  PermissionVerdictRecord,
} from '../../domain/entities/PermissionRequest.js';
import type { PermissionRequestRepositoryPort } from '../../application/ports/out/PermissionRequestRepositoryPort.out-port.js';

const MAX_PENDING_RECORDS = 128;
const MAX_TOTAL_RECORDS = 512;

export interface PermissionRequestRepositoryAdapterOptions {
  readonly now?: () => number;
}

export class PermissionRequestRepositoryAdapter implements PermissionRequestRepositoryPort {
  private readonly records = new Map<string, PermissionRequest>();

  constructor(private readonly options?: PermissionRequestRepositoryAdapterOptions) {}

  private now(): number {
    return this.options?.now ? this.options.now() : Date.now();
  }

  record(
    request: PermissionRequestRecord,
  ): { readonly stored: boolean; readonly reason?: 'too-many-pending-requests' } {
    const existing = this.records.get(request.requestId);
    if (existing !== undefined && existing.getVerdict() !== undefined) {
      // A decided request is never overwritten.
      return { stored: false };
    }

    const now = this.now();

    // Prune records that are not pending and whose deadlineAt has passed.
    for (const [id, entity] of this.records.entries()) {
      if (entity.getState() !== 'pending' && Date.parse(entity.getDeadlineAtIso()) <= now) {
        this.records.delete(id);
      }
    }

    // Drop the oldest decided/expired records while the total cap is reached; pending
    // records are never dropped.
    while (this.records.size >= MAX_TOTAL_RECORDS) {
      const oldestNonPending = this.firstNonPending();
      if (oldestNonPending === undefined) {
        break;
      }
      this.records.delete(oldestNonPending.getId());
    }

    if (this.livePendingCount(now) >= MAX_PENDING_RECORDS || this.records.size >= MAX_TOTAL_RECORDS) {
      return { stored: false, reason: 'too-many-pending-requests' };
    }

    const entity = new PermissionRequest(
      {
        requestId: request.requestId,
        threadId: request.threadId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        requestedAtIso: request.requestedAtIso,
        deadlineAtIso: request.deadlineAtIso,
      },
      request.verdict !== undefined || request.state !== undefined
        ? { state: request.state, verdict: request.verdict }
        : undefined,
    );
    this.records.set(request.requestId, entity);
    return { stored: true };
  }

  find(requestId: string): PermissionRequestRecord | undefined {
    const entity = this.records.get(requestId);
    return entity === undefined ? undefined : entity.toRecord();
  }

  listPending(): readonly PermissionRequestRecord[] {
    const pending: PermissionRequestRecord[] = [];
    const now = this.now();
    for (const entity of this.records.values()) {
      if (entity.getState() === 'pending' && Date.parse(entity.getDeadlineAtIso()) > now) {
        pending.push(entity.toRecord());
      }
    }
    return pending;
  }

  recordVerdict(
    requestId: string,
    verdict: PermissionVerdictRecord,
  ): { readonly outcome: 'recorded' | 'unchanged' | 'conflict' | 'unknown' | 'expired' } {
    const entity = this.records.get(requestId);
    if (entity === undefined) {
      return { outcome: 'unknown' };
    }
    const outcome = entity.decide(verdict.decision, verdict.actorId, verdict.decidedAtIso);
    return { outcome };
  }

  expire(
    requestId: string,
    reasonCode: 'timed-out' | 'interrupted',
    expiredAtIso?: string,
  ): { readonly outcome: 'expired' | 'noop' | 'unknown' } {
    const entity = this.records.get(requestId);
    if (entity === undefined) {
      return { outcome: 'unknown' };
    }
    const outcome = entity.expire(
      reasonCode,
      expiredAtIso ?? new Date(this.now()).toISOString(),
    );
    return { outcome };
  }

  private firstNonPending(): PermissionRequest | undefined {
    for (const entity of this.records.values()) {
      if (entity.getState() !== 'pending') {
        return entity;
      }
    }
    return undefined;
  }

  private livePendingCount(now: number): number {
    let count = 0;
    for (const entity of this.records.values()) {
      if (entity.getState() === 'pending' && Date.parse(entity.getDeadlineAtIso()) > now) {
        count += 1;
      }
    }
    return count;
  }
}
