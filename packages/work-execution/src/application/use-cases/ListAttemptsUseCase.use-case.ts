/**
 * ListAttemptsUseCase: list recorded attempts with their work order and held
 * capacity reservation. Read-only: never contacts the runner, never saves,
 * never writes the journal. Recorded state, not a runner observation.
 */

import type {
  ListAttemptsPort,
  ListAttemptsRequest,
  ListAttemptsResult,
} from '../ports/in/ListAttemptsPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

export interface ListAttemptsDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly journal: ExecutionJournalPort;
}

function normaliseLimit(
  value: unknown,
): { ok: true; limit: number } | { ok: false } {
  if (value === undefined) {
    return { ok: true, limit: 100 };
  }
  let limit: number;
  if (typeof value === 'number') {
    limit = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    limit = Number(value);
  } else {
    return { ok: false };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { ok: false };
  }
  return { ok: true, limit };
}

export class ListAttemptsUseCase implements ListAttemptsPort {
  constructor(private readonly deps?: ListAttemptsDependencies) {}

  async execute(input?: unknown): Promise<ListAttemptsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListAttemptsUseCase');
    }

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { outcome: 'rejected', reason: 'list request must be an object' };
    }
    const record = input as Record<string, unknown>;

    const limitResult = normaliseLimit(record.limit);
    if (!limitResult.ok) {
      return {
        outcome: 'rejected',
        reason: 'limit must be an integer from 1 to 500',
      };
    }

    let projectId: string | undefined;
    if (record.projectId !== undefined && record.projectId !== '') {
      if (typeof record.projectId !== 'string') {
        return { outcome: 'rejected', reason: 'projectId must be a string' };
      }
      projectId = record.projectId;
    }

    return this.listAttempts({
      ...(projectId !== undefined ? { projectId } : {}),
      limit: limitResult.limit,
    });
  }

  async listAttempts(request: ListAttemptsRequest): Promise<ListAttemptsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListAttemptsUseCase');
    }

    const limitResult = normaliseLimit(request.limit);
    if (!limitResult.ok) {
      return {
        outcome: 'rejected',
        reason: 'limit must be an integer from 1 to 500',
      };
    }
    const projectId = request.projectId;
    if (projectId !== undefined && typeof projectId !== 'string') {
      return { outcome: 'rejected', reason: 'projectId must be a string' };
    }

    const [attempts, workOrders, reservations] = await Promise.all([
      this.deps.attemptRepo.listAllAttempts(),
      this.deps.workOrderRepo.listWorkOrdersByProject(),
      this.deps.journal.listActiveReservations(),
    ]);

    const workOrderById = new Map(
      workOrders.map((workOrder) => [workOrder.id, workOrder]),
    );
    const reservationByAttemptId = new Map(
      reservations
        .filter((reservation) => reservation.held === true)
        .map((reservation) => [reservation.attemptId, reservation]),
    );

    const filtered =
      projectId === undefined
        ? attempts
        : attempts.filter((attempt) => {
            const workOrder = workOrderById.get(attempt.workOrderId);
            return workOrder !== undefined && workOrder.projectId === projectId;
          });

    const ordered = [...filtered].sort((a, b) => {
      if (a.updatedAtIso !== b.updatedAtIso) {
        return a.updatedAtIso < b.updatedAtIso ? 1 : -1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const total = ordered.length;
    const rows = ordered.slice(0, limitResult.limit);
    const listed = rows.map((attempt) => {
      const workOrder = workOrderById.get(attempt.workOrderId);
      const reservation = reservationByAttemptId.get(attempt.id);
      return {
        attempt,
        workOrder: workOrder
          ? {
              id: workOrder.id,
              projectId: workOrder.projectId,
              taskId: workOrder.taskId,
              laneId: workOrder.laneId,
            }
          : null,
        reservation: reservation
          ? {
              hostId: reservation.hostId,
              hostName: reservation.hostName ?? null,
              slotIndex: reservation.slotIndex,
            }
          : null,
      };
    });

    return {
      outcome: 'listed',
      attempts: listed,
      total,
      truncated: total > limitResult.limit,
    };
  }
}
