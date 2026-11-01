/**
 * ListLaneRunsUseCase: the read-only schedule view of the live lane runs
 * (plan §3.6, lane A-R-1) that the CLI (`conductor schedule`) and, next,
 * `GET /v1/runs` share. Every dependency is a `Pick` of read methods only,
 * so listing cannot change anything. The result carries only what VZ1's
 * `deriveConductorSchedule` returns plus the session-start marks: never a
 * lease holder id, ssh alias, port, transport or worktree path.
 */

import type {
  ListLaneRunsPort,
  ListLaneRunsRequest,
  ListLaneRunsResult,
} from '../ports/in/ListLaneRunsPort.in-port.js';
import { LIST_LANE_RUNS_SESSION_MARK_LIMIT } from '../ports/in/ListLaneRunsPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ConductorPassTracePort } from '../ports/out/ConductorPassTracePort.out-port.js';
import { deriveConductorSchedule, deriveSessionStartMarks } from '../../domain/conductor-schedule.js';
import type { ConductorPassTraceRead } from '../../domain/conductor-pass-trace.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { journalsForRuns } from './run-journal-reads.js';

export interface ListLaneRunsDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly driverLease: Pick<ConductorDriverLeasePort, 'read'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAllAttempts'>;
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations'>;
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'>;
  /** VZ5b: optional pass-trace read; absent keeps today's schedule exactly. */
  readonly passTrace?: Pick<ConductorPassTracePort, 'list'>;
}

/**
 * The newest trace the schedule should read: undefined when no passTrace dep
 * was given (today's behaviour), null when the ring is empty, else the read
 * result with an unknown-version unreadable preserved.
 */
function latestTraceOf(
  traceList: Awaited<ReturnType<ConductorPassTracePort['list']>> | undefined,
): ConductorPassTraceRead | null | undefined {
  if (traceList === undefined) {
    return undefined;
  }
  if (traceList.outcome === 'listed') {
    const traces = traceList.traces;
    return traces.length >= 1 ? { ok: true, record: traces[traces.length - 1]! } : null;
  }
  return traceList.reason === 'unknown-schema-version'
    ? { ok: false, reason: 'unknown-schema-version' }
    : { ok: false, reason: 'malformed' };
}

export class ListLaneRunsUseCase implements ListLaneRunsPort {
  constructor(private readonly deps?: ListLaneRunsDependencies) {}

  async listLaneRuns(request: ListLaneRunsRequest): Promise<ListLaneRunsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListLaneRunsUseCase');
    }
    const isPlainObject =
      typeof request === 'object' &&
      request !== null &&
      (Object.getPrototypeOf(request) === Object.prototype ||
        Object.getPrototypeOf(request) === null);
    if (!isPlainObject || !isZonedIsoDateTime(request.nowIso)) {
      return { outcome: 'rejected', reason: 'invalid-request' };
    }

    const [halt, driver, runs, reservations, attempts, orders, traceList] = await Promise.all([
      this.deps.halt.read(),
      this.deps.driverLease.read(),
      this.deps.runRepo.list(),
      this.deps.executionJournal.listActiveReservations(),
      this.deps.attemptRepo.listAllAttempts(),
      this.deps.workOrderRepo.listWorkOrdersByProject(),
      this.deps.passTrace !== undefined
        ? this.deps.passTrace.list()
        : Promise.resolve(undefined),
    ]);

    const journals = await journalsForRuns(
      this.deps.runJournal,
      runs.map((run) => run.runId),
    );

    const latestTrace = latestTraceOf(traceList);

    const schedule = deriveConductorSchedule(
      {
        halt: halt.state,
        driverLease: driver,
        runs,
        journals,
        reservations,
        attemptWorkOrderIds: new Map(
          attempts.map((attempt) => [attempt.id, attempt.workOrderId]),
        ),
        workOrders: new Map(
          orders.map((order) => [order.id, { repository: order.repository, ownedPaths: order.ownedPaths }]),
        ),
        ...(latestTrace === undefined ? {} : { latestTrace }),
      },
      request.nowIso,
    );

    const { marks, truncated } = deriveSessionStartMarks(
      [...journals.values()].flat(),
      {
        dispatchStaggerMs: schedule.caps?.dispatchStaggerMs ?? null,
        limit: LIST_LANE_RUNS_SESSION_MARK_LIMIT,
      },
    );

    return { outcome: 'listed', schedule, sessionStarts: marks, truncated };
  }
}
