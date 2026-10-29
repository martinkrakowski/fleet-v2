// Implemented for migration step 2 — fresh fix rounds, never resumed sessions.
/**
 * PrepareFixAttemptUseCase: create a fresh attempt with numbered fixes after
 * the prior attempt is collected (artifact manifest sealed) or cancelled. A
 * fix round never resumes the prior session; its conversation is not the new
 * attempt's. The new identity is created only when no other attempt on the
 * work order can still touch the shared worktree and the fix identity is
 * unused. When the prior attempt carries a seat plan, the fix attempt is
 * bound to the next eligible fix seat (S1 round-robin); an exhausted plan
 * refuses.
 */

import type { AttemptRecord } from '../../domain/execution-records.js';
import { historyEntryOf, seatSelectionRecord, selectSeat } from '../../domain/seat-selection.js';
import { SeatPlan } from '../../domain/value-objects/SeatPlan.vo.js';
import {
  FIX_READY_PRIOR_STATES,
  FIX_NON_BLOCKING_SIBLING_STATES,
  attemptStateLabel,
} from '../../domain/value-objects/AttemptState.vo.js';
import type {
  PrepareFixAttemptPort,
  PrepareFixAttemptRequest,
  PrepareFixAttemptResult,
} from '../ports/in/PrepareFixAttemptPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';

export interface PrepareFixAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
}

export interface FixPriorCheckResult {
  readonly prior: AttemptRecord | null;
  readonly refusal: string | null;
}

/**
 * C1b: fix attempts share the lane's worktree, so a fix attempt starts only after its prior attempt is
 * collected (artifact manifest sealed) or cancelled, and while no other attempt on the work order can
 * still touch the worktree. Used by prepare and by dispatch; a refusal names only ids and states.
 */
export async function checkFixPriorSettled(
  attemptRepo: AttemptRepositoryPort,
  fix: { readonly fixAttemptId: string; readonly workOrderId: string; readonly priorAttemptId: string | null },
): Promise<FixPriorCheckResult> {
  if (!fix.priorAttemptId || fix.priorAttemptId.trim().length === 0) {
    return { prior: null, refusal: 'Prior attempt not found for work order' };
  }
  const prior = await attemptRepo.findAttemptById(fix.priorAttemptId);
  if (!prior || prior.workOrderId !== fix.workOrderId) {
    return { prior: null, refusal: 'Prior attempt not found for work order' };
  }
  if (!FIX_READY_PRIOR_STATES.includes(prior.state)) {
    const label = attemptStateLabel(prior.state);
    return {
      prior,
      refusal: `Prior attempt ${prior.id} is ${label}; a fix attempt starts only after it is collected or cancelled`,
    };
  }
  const siblings = await attemptRepo.listAttemptsByWorkOrder(fix.workOrderId);
  const blocker = siblings.find(
    (a) =>
      a.id !== fix.fixAttemptId &&
      a.id !== prior.id &&
      !FIX_NON_BLOCKING_SIBLING_STATES.includes(a.state),
  );
  if (blocker) {
    const blockerLabel = attemptStateLabel(blocker.state);
    return {
      prior,
      refusal: `Attempt ${blocker.id} on the same work order is ${blockerLabel}; a fix attempt starts only after it is collected or cancelled`,
    };
  }
  return { prior, refusal: null };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Oldest first; ties keep repository order. */
function byCreatedAt(left: AttemptRecord, right: AttemptRecord): number {
  return left.createdAtIso.localeCompare(right.createdAtIso);
}

export class PrepareFixAttemptUseCase implements PrepareFixAttemptPort {
  constructor(private readonly deps?: PrepareFixAttemptDependencies) {}

  async prepareFixAttempt(request: PrepareFixAttemptRequest): Promise<PrepareFixAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PrepareFixAttemptUseCase');
    }

    const requiredFields: readonly (keyof PrepareFixAttemptRequest)[] = [
      'fixAttemptId',
      'workOrderId',
      'priorAttemptId',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'refused', reason: `Missing required fix attempt fields: ${missingFields.join(', ')}` };
    }
    if (request.fixAttemptId === request.priorAttemptId) {
      return { outcome: 'refused', reason: 'fixAttemptId must differ from priorAttemptId' };
    }
    if (!Array.isArray(request.numberedFixes) || request.numberedFixes.length === 0) {
      return { outcome: 'refused', reason: 'numberedFixes must record at least one fix' };
    }
    const hasBriefDigest = request.briefDigest !== undefined;
    const hasBriefPackagePath = request.briefPackagePath !== undefined;
    if (hasBriefDigest !== hasBriefPackagePath) {
      return { outcome: 'refused', reason: 'briefDigest and briefPackagePath must be given together' };
    }
    if (hasBriefDigest && (!isNonEmpty(request.briefDigest) || !isNonEmpty(request.briefPackagePath))) {
      return { outcome: 'refused', reason: 'briefDigest and briefPackagePath must be non-empty strings' };
    }

    const check = await checkFixPriorSettled(this.deps.attemptRepo, {
      fixAttemptId: request.fixAttemptId,
      workOrderId: request.workOrderId,
      priorAttemptId: request.priorAttemptId,
    });
    if (check.refusal !== null || check.prior === null) {
      return { outcome: 'refused', reason: check.refusal ?? 'Prior attempt not found for work order' };
    }
    const prior = check.prior;

    if (request.worktreePath !== undefined && request.worktreePath !== prior.worktreePath) {
      return {
        outcome: 'refused',
        reason: `worktreePath does not match prior attempt: expected ${prior.worktreePath}, got ${request.worktreePath}`,
      };
    }
    if (request.baseCommit !== undefined && request.baseCommit !== prior.baseCommit) {
      return {
        outcome: 'refused',
        reason: `baseCommit does not match prior attempt: expected ${prior.baseCommit}, got ${request.baseCommit}`,
      };
    }

    const existingFix = await this.deps.attemptRepo.findAttemptById(request.fixAttemptId);
    if (existingFix) {
      return { outcome: 'refused', reason: `Fix attempt id already exists: ${request.fixAttemptId}` };
    }

    // S1: a prior attempt with a seat plan hands the next fix seat to this
    // attempt by the per-lane round-robin. No plan keeps today's behaviour.
    let seatFields: Pick<AttemptRecord, 'seatPlan' | 'seatSelection'> = {};
    if (prior.seatPlan) {
      const created = SeatPlan.create(prior.seatPlan);
      if (!created.success || created.value === undefined) {
        return {
          outcome: 'refused',
          reason: 'Prior attempt carries an invalid seat plan: ' + (created.error?.message ?? 'unknown error'),
        };
      }
      const unhealthy = request.unhealthySeatIds ?? [];
      if (!Array.isArray(unhealthy) || !unhealthy.every((id) => typeof id === 'string')) {
        return { outcome: 'refused', reason: 'unhealthySeatIds must be an array of strings' };
      }
      const lane = [...(await this.deps.attemptRepo.listAttemptsByWorkOrder(request.workOrderId))].sort(byCreatedAt);
      const selection = selectSeat({
        plan: created.value,
        role: 'fix',
        history: lane.map(historyEntryOf),
        unhealthySeatIds: unhealthy,
      });
      if (!selection.ok) {
        return { outcome: 'refused', reason: 'No fix seat available: ' + selection.reason };
      }
      seatFields = {
        seatPlan: created.value.toJSON(),
        seatSelection: seatSelectionRecord('fix', selection.seatIndex, selection.seat),
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    // A fix attempt is a fresh identity: it never inherits or resumes the
    // prior session's sessionId or conversation.
    const record: AttemptRecord = {
      id: request.fixAttemptId,
      workOrderId: request.workOrderId,
      kind: 'fix',
      fixNumber: prior.fixNumber + 1,
      priorAttemptId: prior.id,
      worktreePath: prior.worktreePath,
      baseCommit: prior.baseCommit,
      state: 'intent-recorded',
      outcome: null,
      briefDigest: request.briefDigest ?? null,
      briefPackagePath: request.briefPackagePath ?? null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      ...seatFields,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    await this.deps.attemptRepo.saveAttempt(record);
    return { outcome: 'prepared', attempt: record };
  }

  async execute(input?: unknown): Promise<PrepareFixAttemptResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: PrepareFixAttemptUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: PrepareFixAttemptUseCase');
    }
    return this.prepareFixAttempt(input as PrepareFixAttemptRequest);
  }
}
