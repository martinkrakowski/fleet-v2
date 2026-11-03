// Implemented for lane WB4c (consumer-side delegation to operator-coordination).
/**
 * OwnerItemsWriteAdapter implements OwnerItemsWritePort by delegating
 * in-process to operator-coordination's RecordOwnerItemPort and
 * ResolveOwnerItemPort, bound by the composition root (same delegate
 * pattern as LaneRunParkNoticeAdapter). The delegate body carries exactly
 * the project, the `decision` kind, the subject, the plan-decision ref and
 * the lane blocks — never an id, a time or a state. Unbound delegates
 * refuse `not-configured`; a thrown or unrecognized delegate answer is
 * `unreadable`, never a guess.
 */

import type { RecordOwnerItemPort, ResolveOwnerItemPort } from '@fleet/operator-coordination';

import type {
  OpenDecisionItemRequest,
  OpenDecisionItemResult,
  OwnerItemsWritePort,
  ResolvePlanDecisionRequest,
  ResolvePlanDecisionResult,
} from '../../application/ports/out/OwnerItemsWritePort.out-port.js';

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface OwnerItemsWriteDelegate {
  readonly recordOwnerItem?: RecordOwnerItemPort['recordOwnerItem'];
  readonly resolveOwnerItem?: ResolveOwnerItemPort['resolveOwnerItem'];
}

/** The actor the plan sync raises decision items as. */
export const PLAN_DECISION_ACTOR = 'plan-import';

function unreadableOpen(): OpenDecisionItemResult {
  return { outcome: 'refused', code: 'unreadable', reason: 'the owner-item recorder returned an unreadable answer' };
}

function unreadableResolve(): ResolvePlanDecisionResult {
  return { outcome: 'refused', code: 'unreadable', reason: 'the owner-item resolver returned an unreadable answer' };
}

export class OwnerItemsWriteAdapter implements OwnerItemsWritePort {
  constructor(
    private readonly delegate?: OwnerItemsWriteDelegate,
    private readonly actor: string = PLAN_DECISION_ACTOR,
  ) {}

  async openDecisionItem(request: OpenDecisionItemRequest): Promise<OpenDecisionItemResult> {
    const recordOwnerItem = this.delegate?.recordOwnerItem;
    if (!recordOwnerItem) {
      return { outcome: 'refused', code: 'not-configured', reason: 'no owner-item recorder is bound' };
    }
    const body = {
      projectId: request.projectId,
      kind: 'decision',
      subject: request.subject,
      refs: [{ kind: 'plan-decision', planId: request.planId, decisionId: request.decisionId }],
      blocks: request.blocks,
    };
    try {
      const answer = await recordOwnerItem(body, this.actor);
      if (answer.outcome === 'recorded') {
        return { outcome: 'opened' };
      }
      if (answer.outcome === 'exists') {
        return { outcome: 'exists' };
      }
      if (answer.outcome === 'key-held' || answer.outcome === 'refused') {
        return { outcome: 'refused', code: 'refused', reason: answer.reason };
      }
      return unreadableOpen();
    } catch {
      return { outcome: 'refused', code: 'unreadable', reason: 'the owner-item recorder threw' };
    }
  }

  async resolvePlanDecision(request: ResolvePlanDecisionRequest): Promise<ResolvePlanDecisionResult> {
    const resolveOwnerItem = this.delegate?.resolveOwnerItem;
    if (!resolveOwnerItem) {
      return { outcome: 'refused', code: 'not-configured', reason: 'no owner-item resolver is bound' };
    }
    const delegateRequest = {
      action: 'plan-decision',
      projectId: request.projectId,
      planId: request.planId,
      decisionId: request.decisionId,
      outcome: request.outcome,
      planRevision: request.planRevision,
    };
    try {
      const answer = await resolveOwnerItem(delegateRequest, this.actor);
      if (answer.outcome === 'resolved' || answer.outcome === 'unchanged' || answer.outcome === 'not-found') {
        return { outcome: answer.outcome };
      }
      if (answer.outcome === 'refused') {
        return { outcome: 'refused', code: 'refused', reason: answer.reason };
      }
      return unreadableResolve();
    } catch {
      return { outcome: 'refused', code: 'unreadable', reason: 'the owner-item resolver threw' };
    }
  }
}
