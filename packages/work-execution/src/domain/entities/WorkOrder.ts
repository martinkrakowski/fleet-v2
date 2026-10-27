// @generated entity stub — refined for migration step 1.
/**
 * WorkOrder is the aggregate root of one bounded work unit. It wraps a
 * WorkOrderRecord and enforces the lifecycle invariants: terminal states
 * accept no further dispatch, and a work order owns its paths and revision.
 */

import type { PlanRef, WorkOrderRecord, WorkOrderRisk } from '../execution-records.js';
import { resolveWorkOrderRisk } from '../execution-records.js';
import { PLAN_ID_PATTERN, PLANNED_LANE_ID_PATTERN } from '../lane-plan-records.js';
import type { WorkOrderStateValue } from '../value-objects/WorkOrderState.vo.js';
import { WorkOrderState } from '../value-objects/WorkOrderState.vo.js';

export class WorkOrder {
  private constructor(private record: WorkOrderRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: WorkOrderRecord): WorkOrder {
    const id = record.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('WorkOrder requires a non-empty id');
    }
    if (typeof record.projectId !== 'string' || record.projectId.trim().length === 0) {
      throw new Error('WorkOrder requires a non-empty projectId');
    }
    if (typeof record.repository !== 'string' || record.repository.trim().length === 0) {
      throw new Error('WorkOrder requires a non-empty repository');
    }
    if (typeof record.baseCommit !== 'string' || record.baseCommit.trim().length === 0) {
      throw new Error('WorkOrder requires a non-empty baseCommit');
    }
    if (!Array.isArray(record.ownedPaths) || record.ownedPaths.length === 0) {
      throw new Error('WorkOrder requires at least one owned path');
    }
    if (Number.isInteger(record.revision) === false || record.revision < 0) {
      throw new Error('WorkOrder requires a non-negative integer revision');
    }
    const state = WorkOrderState.create(record.state);
    if (!state.success || state.value === undefined) {
      throw new Error(`WorkOrder has an invalid state: ${String(record.state)}`);
    }
    if (record.planRef !== undefined) {
      const planRefErrorMessage = planRefError(record.planRef, record.projectId);
      if (planRefErrorMessage !== null) {
        throw new Error(planRefErrorMessage);
      }
    }
    return new WorkOrder(storedRecord(record));
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): WorkOrderRecord {
    return storedRecord(this.record);
  }

  getPlanRef(): PlanRef | null {
    const planRef = this.record.planRef;
    if (planRef === undefined) {
      return null;
    }
    return { projectId: planRef.projectId, planId: planRef.planId, laneId: planRef.laneId };
  }

  getState(): WorkOrderStateValue {
    return this.record.state;
  }

  /** The registered risk; a record stored without one is `high` (plan A5). */
  getRisk(): WorkOrderRisk {
    return resolveWorkOrderRisk(this.record);
  }

  /** Terminal states (merged, stopped) accept no further attempt dispatch. */
  isTerminal(): boolean {
    return this.record.state === 'merged' || this.record.state === 'stopped';
  }

  hasPrerequisites(): boolean {
    return this.record.prerequisiteWorkOrderIds.length > 0;
  }

  /** Optimistic concurrency: revisions only move forward. */
  nextRevision(): number {
    return this.record.revision + 1;
  }

  isOwnedPath(path: string): boolean {
    return this.record.ownedPaths.some(
      (owned) => path === owned || path.startsWith(`${owned}/`),
    );
  }
}

/** A fresh record; `planRef` and `risk` are copied when present and omitted when absent. */
function storedRecord(record: WorkOrderRecord): WorkOrderRecord {
  const stored: Omit<WorkOrderRecord, 'planRef' | 'risk'> & {
    planRef?: PlanRef;
    risk?: WorkOrderRisk;
  } = {
    id: record.id,
    projectId: record.projectId,
    taskId: record.taskId,
    laneId: record.laneId,
    repository: record.repository,
    baseCommit: record.baseCommit,
    ownedPaths: [...record.ownedPaths],
    policyRevision: record.policyRevision,
    prerequisiteWorkOrderIds: record.prerequisiteWorkOrderIds,
    state: record.state,
    revision: record.revision,
    createdAtIso: record.createdAtIso,
    updatedAtIso: record.updatedAtIso,
  };
  if (record.planRef !== undefined) {
    stored.planRef = {
      projectId: record.planRef.projectId,
      planId: record.planRef.planId,
      laneId: record.planRef.laneId,
    };
  }
  if (record.risk !== undefined) {
    stored.risk = record.risk;
  }
  return stored;
}

function planRefError(value: unknown, projectId: string): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return 'WorkOrder planRef must be { projectId, planId, laneId }';
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    typeof keys[0] !== 'string' ||
    typeof keys[1] !== 'string' ||
    typeof keys[2] !== 'string' ||
    !keys.includes('projectId') ||
    !keys.includes('planId') ||
    !keys.includes('laneId')
  ) {
    return 'WorkOrder planRef must be { projectId, planId, laneId }';
  }
  const record = value as Record<string, unknown>;
  if (record.projectId !== projectId) {
    return 'WorkOrder planRef projectId must equal the work order projectId';
  }
  if (typeof record.planId !== 'string' || !PLAN_ID_PATTERN.test(record.planId)) {
    return 'WorkOrder planRef planId is not a plan id';
  }
  if (typeof record.laneId !== 'string' || !PLANNED_LANE_ID_PATTERN.test(record.laneId)) {
    return 'WorkOrder planRef laneId is not a lane id';
  }
  return null;
}
