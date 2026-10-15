// @generated entity stub — refined for migration step 1.
/**
 * WorkOrder is the aggregate root of one bounded work unit. It wraps a
 * WorkOrderRecord and enforces the lifecycle invariants: terminal states
 * accept no further dispatch, and a work order owns its paths and revision.
 */

import type { WorkOrderRecord } from '../execution-records.js';
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
    return new WorkOrder({ ...record, ownedPaths: [...record.ownedPaths] });
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): WorkOrderRecord {
    return { ...this.record, ownedPaths: [...this.record.ownedPaths] };
  }

  getState(): WorkOrderStateValue {
    return this.record.state;
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
