// @generated use-case scaffold — implemented for KF-36b-2.
/**
 * ListStaleWorkOrdersUseCase: a read-only listing of the work orders whose
 * state disagrees with their lane runs: active work orders whose every run is
 * terminal, active work orders with no run, and non-terminal runs whose work
 * order is terminal. It never writes; a throw from a read propagates, so an
 * unreadable store is never shown as "nothing stale".
 */

import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { WorkOrderStateValue } from '../../domain/value-objects/WorkOrderState.vo.js';
import type {
  ListStaleWorkOrdersPort,
  ListStaleWorkOrdersRequest,
  ListStaleWorkOrdersResult,
  StaleWorkOrderEntry,
  StaleWorkOrderKind,
} from '../ports/in/ListStaleWorkOrdersPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import { journalsForRuns } from './run-journal-reads.js';

/** The reads the listing needs; narrowed so composition supplies only what it has. */
export interface ListStaleWorkOrdersDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type RunView = { readonly runId: string; readonly state: LaneRunStateValue };

function isTerminalRun(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

function isTerminalWorkOrder(state: WorkOrderStateValue): boolean {
  return state === 'merged' || state === 'stopped';
}

export class ListStaleWorkOrdersUseCase implements ListStaleWorkOrdersPort {
  constructor(private readonly deps?: ListStaleWorkOrdersDependencies) {}

  async execute(input: unknown): Promise<ListStaleWorkOrdersResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListStaleWorkOrdersUseCase');
    }
    const request = (input ?? {}) as ListStaleWorkOrdersRequest;
    return this.listStaleWorkOrders(request);
  }

  async listStaleWorkOrders(request: ListStaleWorkOrdersRequest): Promise<ListStaleWorkOrdersResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListStaleWorkOrdersUseCase');
    }
    return this.list(this.deps, request);
  }

  private async list(
    deps: ListStaleWorkOrdersDependencies,
    request: ListStaleWorkOrdersRequest,
  ): Promise<ListStaleWorkOrdersResult> {
    const projectId =
      typeof request.projectId === 'string' && request.projectId.trim() !== ''
        ? request.projectId.trim()
        : undefined;
    const workOrders = await deps.workOrderRepo.listWorkOrdersByProject(projectId);
    const runs = await deps.runRepo.list();

    // Read every run's journal state exactly once, keyed by run id: one
    // grouped journal read for the whole scan (EX-3a).
    const entriesByRun = await journalsForRuns(
      deps.runJournal,
      runs.map((run) => run.runId),
    );
    const runStates = new Map<string, LaneRunStateValue>();
    for (const run of runs) {
      runStates.set(run.runId, laneRunJournalState(entriesByRun.get(run.runId) ?? [], run.runId));
    }

    // Group runs by work order id. A run whose work order does not exist is out
    // of scope here and ignored, never an error.
    const knownWorkOrderIds = new Set(workOrders.map((workOrder) => workOrder.id));
    const runsByWorkOrder = new Map<string, RunView[]>();
    for (const run of runs) {
      if (!knownWorkOrderIds.has(run.workOrderId)) {
        continue;
      }
      const views = runsByWorkOrder.get(run.workOrderId) ?? [];
      views.push({ runId: run.runId, state: runStates.get(run.runId) ?? 'ready' });
      runsByWorkOrder.set(run.workOrderId, views);
    }

    const entries: StaleWorkOrderEntry[] = [];
    for (const workOrder of workOrders) {
      const workOrderRuns = runsByWorkOrder.get(workOrder.id) ?? [];
      let kind: StaleWorkOrderKind | null = null;
      let listedRuns: RunView[] = workOrderRuns;
      let suggestedClose: 'merged' | 'stopped' | null = null;

      if (isTerminalWorkOrder(workOrder.state)) {
        // A closed work order with a non-terminal run: the run started or kept
        // going underneath the close. Only those runs disagree.
        const nonTerminalRuns = workOrderRuns.filter((run) => !isTerminalRun(run.state));
        if (nonTerminalRuns.length > 0) {
          kind = 'run-on-closed-work-order';
          listedRuns = nonTerminalRuns;
        }
      } else if (workOrderRuns.length === 0) {
        // Active with no run: hand-carried or never started; attemptCount helps tell which.
        kind = 'no-run';
        listedRuns = [];
      } else if (workOrderRuns.every((run) => isTerminalRun(run.state))) {
        // Active, every run terminal: the work order's release never landed.
        kind = 'runs-ended';
        suggestedClose = workOrderRuns.some((run) => run.state === 'merged') ? 'merged' : 'stopped';
      }

      if (kind === null) {
        continue;
      }
      const attempts = await deps.attemptRepo.listAttemptsByWorkOrder(workOrder.id);
      entries.push({
        kind,
        workOrderId: workOrder.id,
        workOrderState: workOrder.state,
        runs: [...listedRuns].sort((a, b) => byCodeUnit(a.runId, b.runId)),
        attemptCount: attempts.length,
        suggestedClose,
      });
    }

    entries.sort((a, b) => byCodeUnit(a.workOrderId, b.workOrderId));
    return { outcome: 'listed', entries };
  }
}
