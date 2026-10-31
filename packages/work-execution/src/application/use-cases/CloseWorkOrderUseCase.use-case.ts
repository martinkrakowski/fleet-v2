// @generated use-case scaffold — implemented for KF-36b-1a.
/**
 * CloseWorkOrderUseCase: an operator closes a stale work order — one whose
 * run-end release failed or never ran. Fail closed: a refusal saves nothing,
 * and a failed write is re-read once and never reported as a race unless the
 * stored revision really moved.
 */
import { workOrderReleaseFor } from '../../domain/lane-run-transitions.js';
import type { WorkOrderStateValue } from '../../domain/value-objects/WorkOrderState.vo.js';
import { CAPACITY_RELEASE_STATES } from '../../domain/value-objects/AttemptState.vo.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  CloseWorkOrderRequest,
  CloseWorkOrderResult,
  CloseWorkOrderState,
} from '../ports/in/CloseWorkOrderPort.in-port.js';
import { CLOSE_WORK_ORDER_STATES } from '../ports/in/CloseWorkOrderPort.in-port.js';
import type { CloseWorkOrderPort as CloseWorkOrderPortContract } from '../ports/in/CloseWorkOrderPort.in-port.js';
import { workOrderHoldFacts } from './work-order-hold-facts.js';
import type { WorkOrderHoldFactsDeps } from './work-order-hold-facts.js';

/** The reads and writes the close needs; narrowed so composition supplies only what it has. */
export interface CloseWorkOrderDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById' | 'saveWorkOrder'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runRepo: WorkOrderHoldFactsDeps['runRepo'];
  readonly runJournal: WorkOrderHoldFactsDeps['runJournal'];
  readonly executionJournal: WorkOrderHoldFactsDeps['executionJournal'];
  readonly now?: () => string;
}

type CloseWorkOrderRequestRecord = {
  workOrderId?: unknown;
  state?: unknown;
  nowIso?: unknown;
};

export class CloseWorkOrderUseCase implements CloseWorkOrderPortContract {
  constructor(private readonly deps?: CloseWorkOrderDependencies) {}

  async execute(input: unknown): Promise<CloseWorkOrderResult> {
    if (!this.deps) {
      throw new Error('Not implemented: CloseWorkOrderUseCase');
    }
    if (input === null || typeof input !== 'object') {
      return { outcome: 'refused', workOrderId: '', reason: 'invalid-request' };
    }
    const record = input as CloseWorkOrderRequestRecord;
    return this.closeWorkOrder({
      workOrderId: record.workOrderId as string,
      state: record.state as CloseWorkOrderState,
      nowIso: record.nowIso as string | undefined,
    });
  }

  async closeWorkOrder(request: CloseWorkOrderRequest): Promise<CloseWorkOrderResult> {
    if (!this.deps) {
      throw new Error('Not implemented: CloseWorkOrderUseCase');
    }
    return this.close(this.deps, request);
  }

  private async close(deps: CloseWorkOrderDependencies,
    request: CloseWorkOrderRequest,
  ): Promise<CloseWorkOrderResult> {
    const workOrderId = typeof request.workOrderId === 'string' ? request.workOrderId.trim() : '';
    const state = request.state;
    if (workOrderId.length === 0
      || !(CLOSE_WORK_ORDER_STATES as readonly unknown[]).includes(state)
      || !isValidNowIso(request.nowIso)) {
      return { outcome: 'refused', workOrderId, reason: 'invalid-request' };
    }
    const workOrder = await deps.workOrderRepo.findWorkOrderById(workOrderId);
    if (workOrder === null) {
      return { outcome: 'not-found', workOrderId };
    }
    if (workOrder.state === 'merged' || workOrder.state === 'stopped') {
      return { outcome: 'refused', workOrderId, reason: 'already-terminal' };
    }
    const attempts = await deps.attemptRepo.listAttemptsByWorkOrder(workOrderId);
    const holdFacts = await workOrderHoldFacts(deps, workOrderId,
      attempts.map((attempt) => attempt.id),
      null,
    );
    if (holdFacts.nonTerminalRunIds.length > 0) {
      return {
        outcome: 'refused',
        workOrderId,
        reason: 'run-not-terminal',
        runIds: holdFacts.nonTerminalRunIds,
      };
    }
    const unfinishedAttemptIds = attempts
      .filter((attempt) => !(CAPACITY_RELEASE_STATES as readonly string[]).includes(attempt.state))
      .map((attempt) => attempt.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (unfinishedAttemptIds.length > 0) {
      return { outcome: 'refused', workOrderId, reason: 'attempt-not-ended', attemptIds: unfinishedAttemptIds };
    }
    // An operator close is stricter than the run-end release: a held slot
    // blocks `merged` too (the paths' content is on main, but the slot is
    // still somebody's).
    if (holdFacts.heldAttemptIds.length > 0) {
      return { outcome: 'refused', workOrderId, reason: 'slot-held', attemptIds: holdFacts.heldAttemptIds };
    }
    // `merged` needs evidence: some run naming the work order reached `merged`.
    // A hand-carried work order has no run at all and closes as `stopped`.
    if (state === 'merged' && holdFacts.mergedRunIds.length === 0) {
      return { outcome: 'refused', workOrderId, reason: 'no-merged-run' };
    }
    const answer = workOrderReleaseFor({
      runEnds: state,
      workOrderState: workOrder.state,
      slotHeld: false,
      otherRunActive: false,
    });
    if (answer === null) {
      return { outcome: 'refused', workOrderId, reason: 'already-terminal' };
    }
    const now = deps.now ?? (() => new Date().toISOString());
    const revision = workOrder.revision + 1;
    try {
      await deps.workOrderRepo.saveWorkOrder({
        ...workOrder,
        state: answer as WorkOrderStateValue,
        revision,
        updatedAtIso: request.nowIso ?? now(),
      });
    } catch (error) {
      // Re-read once: a stale revision is a race only when the stored revision
      // really moved; otherwise the write itself failed, and that failure is
      // never dressed up as a race.
      const fresh = await deps.workOrderRepo.findWorkOrderById(workOrderId);
      if (fresh === null || fresh.revision !== workOrder.revision) {
        return { outcome: 'refused', workOrderId, reason: 'stale-revision' };
      }
      throw error;
    }
    return { outcome: 'closed', workOrderId, state: answer, revision };
  }
}

/** An absent `nowIso` falls back to the clock; a present one must be a non-blank ISO timestamp. */
function isValidNowIso(nowIso: unknown): boolean {
  if (nowIso === undefined) return true;
  return typeof nowIso === 'string' && nowIso.trim().length > 0 && !Number.isNaN(Date.parse(nowIso));
}
