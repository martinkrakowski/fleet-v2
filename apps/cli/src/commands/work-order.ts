/** The `work-order` command group of the CLI driver; its entries moved verbatim from the command table. */

import { WORK_ORDER_RISKS } from '@fleet/work-execution';
import { str, optStr, strArr, enumOf } from './payload.js';
import type {
  CommandHandler,
} from './payload.js';

export const workOrderCommands: Readonly<Record<string, CommandHandler>> = {
    register: async (p, rt) =>
      rt.execution.registerWorkOrder.registerWorkOrder({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        ownedPaths: strArr(p, 'ownedPaths'),
        policyRevision: str(p, 'policyRevision'),
        prerequisiteWorkOrderIds: strArr(p, 'prerequisiteWorkOrderIds'),
        risk:
          p.risk === undefined
            ? undefined
            : enumOf(p, 'risk', WORK_ORDER_RISKS, 'work-order register --risk'),
        nowIso: optStr(p, 'nowIso'),
      }),
    inspect: async (p, rt) =>
      rt.execution.inspectWorkOrder.inspectWorkOrder({ workOrderId: str(p, 'workOrderId') }),
};
