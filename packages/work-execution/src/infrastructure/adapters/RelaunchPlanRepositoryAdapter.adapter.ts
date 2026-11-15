// @generated adapter stub — refined for lane CO29b (the refined port contract
// required this stub to implement `readByDigest`).
/**
 * RelaunchPlanRepositoryAdapter implements RelaunchPlanRepositoryPort:
 * an in-memory, digest-keyed plan store (manifest contract: plans are
 * immutable once written; the same content under the same digest is a no-op
 * and other content under a stored digest is refused). Composition roots may
 * replace it with a durable store behind the same port.
 */

import { isPlainRecordObject } from '../../domain/record-schema-version.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  RelaunchPlanReadResult,
  RelaunchPlanRepositoryPort,
} from '../../application/ports/out/RelaunchPlanRepositoryPort.out-port.js';

const PLAN_DIGEST = /^[0-9a-f]{7,64}$/;

export class RelaunchPlanRepositoryAdapter implements RelaunchPlanRepositoryPort {
  private readonly plans = new Map<string, unknown>();

  async readByDigest(planDigest: string): Promise<RelaunchPlanReadResult> {
    if (typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest)) {
      return { status: 'unreadable', reasonCode: 'invalid-digest' };
    }
    if (!this.plans.has(planDigest)) return { status: 'missing' };
    return { status: 'ok', plan: this.plans.get(planDigest) };
  }

  /** Store one plan under its digest; other content under a stored digest is refused. */
  store(planDigest: string, plan: unknown): 'stored' | 'no-op' | 'refused' {
    if (typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest) || snapshotPlainDataRecord(plan) === null) {
      return 'refused';
    }
    const stored = this.plans.get(planDigest);
    if (stored !== undefined) {
      return isPlainRecordObject(stored) && isPlainRecordObject(plan)
        ? (JSON.stringify(stored) === JSON.stringify(plan) ? 'no-op' : 'refused')
        : 'refused';
    }
    this.plans.set(planDigest, plan);
    return 'stored';
  }
}
