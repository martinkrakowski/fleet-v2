// Implemented for lane WB4c — plan decisions to owner items through the write port.
/**
 * SyncPlanDecisionsUseCase brings one stored plan's decision owner items in
 * line with the record (work-board plan §3.2, §3.9): every `open` decision
 * has one item keyed (projectId, planId, decisionId) with one lane block per
 * gating lane; a `decided` decision resolves its item `plan-decided` at the
 * record's revision; an id the record no longer carries resolves
 * `decision-removed` — only when the caller proved what the previous
 * revision held. `opened`, `exists`, `resolved`, `unchanged` and
 * `not-found` are all success for that decision; any refused delegate marks
 * that decision refused, and the overall outcome is `synced` only when
 * every decision succeeded. Refusal codes are fixed strings; no supplied
 * text is ever echoed.
 */

import type { LanePlanRecord, PlanDecisionSidecar } from '../../domain/lane-plan-records.js';
import type { LanePlanRepositoryPort } from '../ports/out/LanePlanRepositoryPort.out-port.js';
import type {
  DecisionLaneBlock,
  OwnerItemsWritePort,
  ResolvePlanDecisionResult,
  OpenDecisionItemResult,
} from '../ports/out/OwnerItemsWritePort.out-port.js';
import type {
  SyncPlanDecisionsDecisionResult,
  SyncPlanDecisionsPort,
  SyncPlanDecisionsRequest,
  SyncPlanDecisionsResult,
} from '../ports/in/SyncPlanDecisionsPort.in-port.js';

export interface SyncPlanDecisionsDependencies {
  readonly plans: LanePlanRepositoryPort;
  readonly ownerItems: OwnerItemsWritePort;
  /** Fresh clock, read at the top of each call. */
  readonly nowIso: () => string;
}

function planUnread(reason: string): SyncPlanDecisionsResult {
  return { outcome: 'refused', code: 'plan-unread', reason, decisions: [] };
}

function successResult(decisionId: string, outcome: string): SyncPlanDecisionsDecisionResult {
  return { decisionId, outcome } as SyncPlanDecisionsDecisionResult;
}

function refusedResult(decisionId: string, code: string): SyncPlanDecisionsDecisionResult {
  return { decisionId, outcome: 'refused', code };
}

/** One lane block per lane of the record whose `decisions` include the id. */
function decisionBlocks(record: LanePlanRecord, decisionId: string): DecisionLaneBlock[] {
  const blocks: DecisionLaneBlock[] = [];
  for (const lane of record.lanes) {
    if (lane.decisions.includes(decisionId)) {
      blocks.push({ kind: 'lane', ref: `${record.planId}/${lane.laneId}` });
    }
  }
  return blocks;
}

function openMapped(decisionId: string, answer: OpenDecisionItemResult): SyncPlanDecisionsDecisionResult {
  if (answer.outcome === 'refused') {
    return refusedResult(decisionId, answer.code);
  }
  return successResult(decisionId, answer.outcome);
}

function resolveMapped(decisionId: string, answer: ResolvePlanDecisionResult): SyncPlanDecisionsDecisionResult {
  if (answer.outcome === 'refused') {
    return refusedResult(decisionId, answer.code);
  }
  return successResult(decisionId, answer.outcome);
}

/** Ids the previous revision carried that the record no longer does. */
function removedDecisionIds(
  record: LanePlanRecord,
  previousDecisionIds: readonly string[] | null,
): string[] {
  if (previousDecisionIds === null) {
    return [];
  }
  const current = new Set(record.decisions.map((decision) => decision.id));
  const removed: string[] = [];
  for (const id of previousDecisionIds) {
    if (typeof id === 'string' && !current.has(id) && !removed.includes(id)) {
      removed.push(id);
    }
  }
  return removed;
}

function overallOutcome(decisions: readonly SyncPlanDecisionsDecisionResult[]): SyncPlanDecisionsResult {
  const refusedCount = decisions.filter((decision) => decision.outcome === 'refused').length;
  if (refusedCount === 0) {
    return { outcome: 'synced', decisions };
  }
  if (decisions.length > 0 && refusedCount === decisions.length) {
    return { outcome: 'refused', code: 'all-refused', reason: 'every decision was refused', decisions };
  }
  return { outcome: 'partial', decisions };
}

export class SyncPlanDecisionsUseCase implements SyncPlanDecisionsPort {
  constructor(private readonly deps: SyncPlanDecisionsDependencies) {}

  async execute(request: SyncPlanDecisionsRequest): Promise<SyncPlanDecisionsResult> {
    try {
      this.deps.nowIso();
    } catch {
      return { outcome: 'refused', code: 'clock', reason: 'the clock could not be read', decisions: [] };
    }
    let record: LanePlanRecord | null;
    try {
      record = await this.deps.plans.findLanePlan(request.projectId, request.planId);
    } catch {
      return planUnread('the plan record could not be read');
    }
    if (record === null) {
      return planUnread('the plan is not imported');
    }
    const decisions = await this.syncDecisions(record, request.projectId);
    const removals = await this.syncRemovals(record, request.projectId, request.previousDecisionIds);
    return overallOutcome([...decisions, ...removals]);
  }

  private async syncDecisions(
    record: LanePlanRecord,
    projectId: string,
  ): Promise<SyncPlanDecisionsDecisionResult[]> {
    const results: SyncPlanDecisionsDecisionResult[] = [];
    for (const decision of record.decisions) {
      results.push(await this.syncDecision(record, projectId, decision));
    }
    return results;
  }

  private async syncDecision(
    record: LanePlanRecord,
    projectId: string,
    decision: PlanDecisionSidecar,
  ): Promise<SyncPlanDecisionsDecisionResult> {
    if (decision.state === 'decided') {
      try {
        const answer = await this.deps.ownerItems.resolvePlanDecision({
          projectId,
          planId: record.planId,
          decisionId: decision.id,
          outcome: 'decided',
          planRevision: record.revision,
        });
        return resolveMapped(decision.id, answer);
      } catch {
        return refusedResult(decision.id, 'unreadable');
      }
    }
    try {
      const answer = await this.deps.ownerItems.openDecisionItem({
        projectId,
        planId: record.planId,
        decisionId: decision.id,
        subject: decision.question,
        blocks: decisionBlocks(record, decision.id),
      });
      return openMapped(decision.id, answer);
    } catch {
      return refusedResult(decision.id, 'unreadable');
    }
  }

  private async syncRemovals(
    record: LanePlanRecord,
    projectId: string,
    previousDecisionIds: readonly string[] | null,
  ): Promise<SyncPlanDecisionsDecisionResult[]> {
    const results: SyncPlanDecisionsDecisionResult[] = [];
    for (const decisionId of removedDecisionIds(record, previousDecisionIds)) {
      try {
        const answer = await this.deps.ownerItems.resolvePlanDecision({
          projectId,
          planId: record.planId,
          decisionId,
          outcome: 'removed',
          planRevision: record.revision,
        });
        results.push(resolveMapped(decisionId, answer));
      } catch {
        results.push(refusedResult(decisionId, 'unreadable'));
      }
    }
    return results;
  }
}
