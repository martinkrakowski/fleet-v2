// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort
 * (local-transactional-store). Implementation lands in wave 2; every method
 * refuses until then.
 */

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import type { WorkOrderRepositoryPort } from '../../application/ports/out/WorkOrderRepositoryPort.out-port.js';

export class WorkOrderRepositoryAdapter implements WorkOrderRepositoryPort {
  async saveWorkOrder(_record: WorkOrderRecord): Promise<void> {
    throw new Error('Not implemented: WorkOrderRepositoryAdapter.saveWorkOrder');
  }

  async findWorkOrderById(_workOrderId: string): Promise<WorkOrderRecord | null> {
    throw new Error('Not implemented: WorkOrderRepositoryAdapter.findWorkOrderById');
  }

  async listWorkOrdersByProject(_projectId?: string): Promise<readonly WorkOrderRecord[]> {
    throw new Error('Not implemented: WorkOrderRepositoryAdapter.listWorkOrdersByProject');
  }
}
