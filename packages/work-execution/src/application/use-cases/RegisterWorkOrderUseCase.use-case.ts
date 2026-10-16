// Implemented for migration step 2 — registration only, no dispatch authority.
/**
 * RegisterWorkOrderUseCase: record one approved bounded work unit with its
 * base commit, owned paths, policy revision and prerequisites. Recording is
 * registration, not dispatch: invalid input, duplicate identities, conflicting
 * path ownership on active work orders and missing prerequisites are rejected
 * explicitly and authorize nothing.
 */

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import type {
  RegisterWorkOrderPort,
  RegisterWorkOrderRequest,
  RegisterWorkOrderResult,
} from '../ports/in/RegisterWorkOrderPort.in-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

export interface RegisterWorkOrderDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Terminal work orders no longer claim their paths against new lanes. */
function isActiveWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state !== 'merged' && state !== 'stopped';
}

/** Exact match, or one path nested underneath the other. */
function pathsOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export class RegisterWorkOrderUseCase implements RegisterWorkOrderPort {
  constructor(private readonly deps?: RegisterWorkOrderDependencies) {}

  async registerWorkOrder(request: RegisterWorkOrderRequest): Promise<RegisterWorkOrderResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }

    const requiredFields: readonly (keyof RegisterWorkOrderRequest)[] = [
      'workOrderId',
      'projectId',
      'taskId',
      'laneId',
      'repository',
      'baseCommit',
      'policyRevision',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'rejected', reason: `Missing required work order fields: ${missingFields.join(', ')}` };
    }
    if (!Array.isArray(request.ownedPaths) || request.ownedPaths.length === 0) {
      return { outcome: 'rejected', reason: 'Work order must own at least one path' };
    }
    if (request.ownedPaths.some((path) => !isNonEmpty(path))) {
      return { outcome: 'rejected', reason: 'Work order owned paths must be non-empty strings' };
    }

    const existingById = await this.deps.workOrderRepo.findWorkOrderById(request.workOrderId);
    if (existingById !== null) {
      return { outcome: 'rejected', reason: `Work order already registered: ${request.workOrderId}` };
    }

    const existing = await this.deps.workOrderRepo.listWorkOrdersByProject(request.projectId);

    for (const order of existing) {
      if (!isActiveWorkOrder(order.state)) {
        continue;
      }
      const conflictingPath = order.ownedPaths.find((owned) =>
        request.ownedPaths.some((path) => pathsOverlap(path, owned)),
      );
      if (conflictingPath !== undefined) {
        return {
          outcome: 'rejected',
          reason: `Owned path conflicts with active work order ${order.id}: ${conflictingPath}`,
        };
      }
    }

    const prerequisites = request.prerequisiteWorkOrderIds ?? [];
    for (const prerequisiteId of prerequisites) {
      const prerequisite = await this.deps.workOrderRepo.findWorkOrderById(prerequisiteId);
      if (!prerequisite) {
        return { outcome: 'rejected', reason: `Missing prerequisite work order: ${prerequisiteId}` };
      }
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    const record: WorkOrderRecord = {
      id: request.workOrderId,
      projectId: request.projectId,
      taskId: request.taskId,
      laneId: request.laneId,
      repository: request.repository,
      baseCommit: request.baseCommit,
      ownedPaths: [...request.ownedPaths],
      policyRevision: request.policyRevision,
      prerequisiteWorkOrderIds: [...prerequisites],
      state: 'approved',
      revision: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    await this.deps.workOrderRepo.saveWorkOrder(record);
    return { outcome: 'registered', workOrder: record };
  }

  async execute(input?: unknown): Promise<RegisterWorkOrderResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    return this.registerWorkOrder(input as RegisterWorkOrderRequest);
  }
}
