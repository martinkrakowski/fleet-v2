/** KF-36b: what still holds a work order: held slots, unfinished runs, merged runs. Shared by the run-end release and the operator close. */
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';

/** The reads the hold facts need; narrowed so every caller supplies only what it has. */
export interface WorkOrderHoldFactsDeps {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations'>;
}

/** What still holds the work order, as sorted identity lists. */
export interface WorkOrderHoldFacts {
  /** Held reservations whose attemptId is one of the run's attempts. */
  readonly heldAttemptIds: readonly string[];
  /** Runs naming the work order (except `exceptRunId`) not in a terminal state. */
  readonly nonTerminalRunIds: readonly string[];
  /** Runs naming the work order (except `exceptRunId`) in journal state `merged`. */
  readonly mergedRunIds: readonly string[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Read what still holds one work order: held capacity reservations on the given
 * attempts, and the journal state of every other run naming the work order.
 * Each run's journal is read once; the lists come back sorted in code-unit
 * order, as elsewhere in this package.
 */
export async function workOrderHoldFacts(deps: WorkOrderHoldFactsDeps,
  workOrderId: string,
  attemptIds: readonly string[],
  exceptRunId: string | null,
): Promise<WorkOrderHoldFacts> {
  const reservations = await deps.executionJournal.listActiveReservations();
  const heldAttemptIds = reservations
    .filter((reservation) => reservation.held && attemptIds.includes(reservation.attemptId))
    .map((reservation) => reservation.attemptId)
    .sort(byCodeUnit);
  const nonTerminalRunIds: string[] = [];
  const mergedRunIds: string[] = [];
  const runs = await deps.runRepo.list();
  for (const run of runs) {
    if (run.workOrderId !== workOrderId || run.runId === exceptRunId) {
      continue;
    }
    const state = laneRunJournalState(await deps.runJournal.listForRun(run.runId), run.runId);
    if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
      if (state === 'merged') {
        mergedRunIds.push(run.runId);
      }
      continue;
    }
    nonTerminalRunIds.push(run.runId);
  }
  return {
    heldAttemptIds,
    nonTerminalRunIds: nonTerminalRunIds.sort(byCodeUnit),
    mergedRunIds: mergedRunIds.sort(byCodeUnit),
  };
}
