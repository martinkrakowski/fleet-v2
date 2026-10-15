// Implemented for migration step 2 — read-only inspection, no state mutation.
/**
 * InspectWorkOrderUseCase: return the work order, its attempt identities and
 * the active capacity reservations held for those attempts. Observed status is
 * reported as typed records with source references; it is never inferred into
 * a pass and this use case never mutates anything.
 */

import type { CapacityReservationRecord } from '../../domain/execution-records.js';
import type {
  InspectWorkOrderPort,
  InspectWorkOrderRequest,
  InspectWorkOrderResult,
} from '../ports/in/InspectWorkOrderPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

export interface InspectWorkOrderDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
}

export class InspectWorkOrderUseCase implements InspectWorkOrderPort {
  constructor(private readonly deps?: InspectWorkOrderDependencies) {}

  async inspectWorkOrder(request: InspectWorkOrderRequest): Promise<InspectWorkOrderResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InspectWorkOrderUseCase');
    }

    const workOrder = await this.deps.workOrderRepo.findWorkOrderById(request.workOrderId);
    if (!workOrder) {
      return { outcome: 'not-found', workOrderId: request.workOrderId };
    }

    const attempts = await this.deps.attemptRepo.listAttemptsByWorkOrder(request.workOrderId);
    const attemptIds = new Set(attempts.map((attempt) => attempt.id));
    const allActive = await this.deps.journal.listActiveReservations();
    const activeReservations: readonly CapacityReservationRecord[] = allActive.filter(
      (reservation) => reservation.held && attemptIds.has(reservation.attemptId),
    );

    return { outcome: 'found', workOrder, attempts, activeReservations };
  }

  async execute(input?: unknown): Promise<InspectWorkOrderResult> {
    if (!this.deps || !input || typeof input !== 'object') {
      throw new Error('Not implemented: InspectWorkOrderUseCase');
    }
    return this.inspectWorkOrder(input as InspectWorkOrderRequest);
  }
}
