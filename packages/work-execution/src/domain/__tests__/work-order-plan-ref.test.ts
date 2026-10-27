import { describe, expect, it } from 'vitest';

import { WorkOrder } from '../entities/WorkOrder.js';
import type { PlanRef, WorkOrderRecord } from '../execution-records.js';

const VALID_WORK_ORDER: WorkOrderRecord = {
  id: 'wo-example-1',
  projectId: 'example-project',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'example-org/example-repo',
  baseCommit: 'a'.repeat(40),
  ownedPaths: ['packages/work-execution/src/domain'],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'approved',
  revision: 1,
  createdAtIso: '2026-10-27T10:00:00Z',
  updatedAtIso: '2026-10-27T10:00:00Z',
};

const PLAN_REF: PlanRef = {
  projectId: 'example-project',
  planId: '2026-10-27_example',
  laneId: 'A1',
};

describe('WorkOrder planRef', () => {
  it('stores a record without planRef exactly as before', () => {
    const workOrder = WorkOrder.fromRecord(VALID_WORK_ORDER);
    const record = workOrder.toRecord();
    expect(Object.prototype.hasOwnProperty.call(record, 'planRef')).toBe(false);
    expect(record).toEqual(VALID_WORK_ORDER);
    expect(workOrder.getPlanRef()).toBeNull();
  });

  it('round-trips a planRef and returns fresh copies', () => {
    const source: WorkOrderRecord = { ...VALID_WORK_ORDER, planRef: PLAN_REF };
    const workOrder = WorkOrder.fromRecord(source);
    expect(workOrder.toRecord()).toEqual(source);
    const toRecordPlanRef = workOrder.toRecord().planRef;
    expect(toRecordPlanRef).not.toBe(PLAN_REF);
    const getPlanRef = workOrder.getPlanRef();
    expect(getPlanRef).toEqual(PLAN_REF);
    expect(getPlanRef).not.toBe(PLAN_REF);
    expect(getPlanRef).not.toBe(toRecordPlanRef);
  });

  it('refuses malformed planRef values with fixed messages', () => {
    const cases: Array<[unknown, string]> = [
      [
        { projectId: 'other-project', planId: '2026-10-27_example', laneId: 'A1' },
        'WorkOrder planRef projectId must equal the work order projectId',
      ],
      [
        { projectId: 'example-project', planId: 'a/b', laneId: 'A1' },
        'WorkOrder planRef planId is not a plan id',
      ],
      [
        { projectId: 'example-project', planId: '2026-10-27_example', laneId: '' },
        'WorkOrder planRef laneId is not a lane id',
      ],
      [
        { projectId: 'example-project', planId: '2026-10-27_example', laneId: 'A1', extra: 1 },
        'WorkOrder planRef must be { projectId, planId, laneId }',
      ],
      [
        { projectId: 'example-project', planId: '2026-10-27_example' },
        'WorkOrder planRef must be { projectId, planId, laneId }',
      ],
      [[], 'WorkOrder planRef must be { projectId, planId, laneId }'],
      [null, 'WorkOrder planRef must be { projectId, planId, laneId }'],
    ];
    for (const [planRef, expected] of cases) {
      let message = '';
      try {
        WorkOrder.fromRecord({ ...VALID_WORK_ORDER, planRef: planRef as PlanRef });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(expected);
    }
  });
});
