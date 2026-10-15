// @generated outbound contract scaffold — refined for migration step 1.
/**
 * WorkOrderRepositoryPort: persist work-order revisions with optimistic
 * concurrency and retrieve orders by project and dependency identity. Known
 * absence is returned as null, never conflated with unreadable state.
 */

import type { WorkOrderRecord } from '../../../domain/execution-records.js';

export interface WorkOrderRepositoryPort {
  /** Persist one work-order revision; a stale revision is an error, not a silent overwrite. */
  saveWorkOrder(record: WorkOrderRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null>;

  /** List work orders, optionally narrowed to one project. */
  listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]>;
}
