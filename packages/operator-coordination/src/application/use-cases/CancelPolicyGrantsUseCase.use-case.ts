/**
 * CancelPolicyGrantsUseCase implements CancelPolicyGrantsPort. It cancels every
 * unconsumed policy grant of one installation setting issued under a revision
 * other than the current one, across all projects. Consumed grants, owner
 * grants and the other setting's grants are never written; running it twice
 * cancels nothing the second time.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import {
  POLICY_GRANT_SOURCES,
  POLICY_SETTING_REVISION_PATTERN,
  parsePolicyDecisionRevision,
} from '../../domain/policy-grants.js';
import type {
  CancelPolicyGrantsPort,
  CancelPolicyGrantsRequest,
  CancelPolicyGrantsResult,
} from '../ports/in/CancelPolicyGrantsPort.in-port.js';
import type { PolicyGrantClock } from '../ports/in/IssuePolicyForgeGrantPort.in-port.js';
import { CoordinationRequestRevisionConflictError } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';

export interface CancelPolicyGrantsDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly clock: PolicyGrantClock;
}

function refused(reason: string): CancelPolicyGrantsResult {
  return { outcome: 'refused', reason };
}

export class CancelPolicyGrantsUseCase implements CancelPolicyGrantsPort {
  constructor(private readonly deps?: CancelPolicyGrantsDependencies) {}

  async cancelPolicyGrants(request: CancelPolicyGrantsRequest): Promise<CancelPolicyGrantsResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<CancelPolicyGrantsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: CancelPolicyGrantsUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: CancelPolicyGrantsUseCase');
    }
    const request = input as CancelPolicyGrantsRequest;
    if (!POLICY_GRANT_SOURCES.includes(request.source)) {
      return refused('a policy grant source must be autoMerge or conductor');
    }
    if (
      typeof request.currentRevision !== 'string' ||
      !POLICY_SETTING_REVISION_PATTERN.test(request.currentRevision.trim())
    ) {
      return refused('currentRevision must be 12 lower-case hex characters');
    }
    const currentRevision = request.currentRevision.trim();
    const now = this.deps.clock.nowIso();

    const all = await this.deps.requestRepo.listRequests();
    let consumedLeft = 0;
    const targets: CoordinationRequestRecord[] = [];
    for (const record of all) {
      const parsed = parsePolicyDecisionRevision(record.decisionRevision);
      if (parsed === null || parsed.source !== request.source || parsed.revision === currentRevision) {
        continue;
      }
      if (record.consumptions.length > 0) {
        consumedLeft += 1;
        continue;
      }
      if (record.state === 'approved') {
        targets.push(record);
      }
    }

    const cancelled = await this.cancelTargets(targets, now);
    const cancelledGrantIds = [...cancelled.cancelledIds].sort((left, right) =>
      left.localeCompare(right),
    );
    if (cancelled.unresolvedIds.length > 0) {
      return {
        outcome: 'partial',
        cancelledGrantIds,
        unresolvedGrantIds: [...cancelled.unresolvedIds].sort((left, right) =>
          left.localeCompare(right),
        ),
        consumedLeft,
      };
    }
    return {
      outcome: 'cancelled',
      cancelledGrantIds,
      consumedLeft,
    };
  }

  /**
   * Cancel one live policy grant; a conflict re-reads once and skips when the
   * record is no longer approved-and-unconsumed, and a second conflict leaves
   * it uncancelled without a retry.
   */
  private async cancelOne(
    record: CoordinationRequestRecord,
    now: string,
  ): Promise<'cancelled' | 'skipped' | 'conflict'> {
    const attempt = async (target: CoordinationRequestRecord): Promise<void> => {
      const cancelled: CoordinationRequestRecord = {
        ...target,
        state: 'cancelled',
        revision: target.revision + 1,
        updatedAtIso: now,
      };
      await this.deps!.requestRepo.saveRequest(CoordinationRequest.fromRecord(cancelled).toRecord());
    };
    try {
      await attempt(record);
      return 'cancelled';
    } catch (error) {
      if (!(error instanceof CoordinationRequestRevisionConflictError)) {
        throw error;
      }
      const fresh = await this.deps!.requestRepo.findRequestById(record.id);
      if (fresh === null || fresh.state !== 'approved' || fresh.consumptions.length > 0) {
        return 'skipped';
      }
      try {
        await attempt(fresh);
        return 'cancelled';
      } catch (second) {
        if (second instanceof CoordinationRequestRevisionConflictError) {
          return 'conflict';
        }
        throw second;
      }
    }
  }

  /** Sequential cancels over a promise chain (never `for … await`). */
  private async cancelTargets(
    targets: readonly CoordinationRequestRecord[],
    now: string,
  ): Promise<{ readonly cancelledIds: string[]; readonly unresolvedIds: string[] }> {
    const cancelledIds: string[] = [];
    const unresolvedIds: string[] = [];
    await targets.reduce(
      (chain, record) =>
        chain.then(async () => {
          const outcome = await this.cancelOne(record, now);
          if (outcome === 'cancelled' && record.grantId !== null) {
            cancelledIds.push(record.grantId);
          } else if (outcome === 'conflict' && record.grantId !== null) {
            unresolvedIds.push(record.grantId);
          }
        }),
      Promise.resolve(),
    );
    return { cancelledIds, unresolvedIds };
  }
}
