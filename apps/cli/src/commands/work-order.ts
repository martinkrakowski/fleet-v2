/** The `work-order` command group of the CLI driver; its entries moved verbatim from the command table. */

import { CLOSE_WORK_ORDER_STATES, WORK_ORDER_RISKS } from '@fleet/work-execution';
import { CliUsageError, str, optStr, strArr, enumOf } from './payload.js';
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
    close: async (p, rt) => {
      // A bare `--work-order-id` followed by another flag parses as `true`; that is a missing id, not the id "true".
      if (typeof p.workOrderId !== 'string' || p.workOrderId.trim() === '') {
        throw new CliUsageError('work-order close requires --work-order-id');
      }
      const workOrderId = str(p, 'workOrderId');
      if (workOrderId.trim() === '') {
        throw new CliUsageError('work-order close requires --work-order-id');
      }
      const state = enumOf(p, 'state', CLOSE_WORK_ORDER_STATES, 'work-order close --state');
      if (p.yes !== true) {
        throw new CliUsageError(
          `work-order close needs --yes: it marks the work order ${state} and releases its owned paths to new work orders; --state merged needs a run that ended merged; it changes no run, attempt, branch or pull request, and cannot be undone.`,
        );
      }
      return rt.execution.closeWorkOrder.closeWorkOrder({ workOrderId, state });
    },
    stale: async (p, rt) =>
      rt.execution.listStaleWorkOrders.listStaleWorkOrders({
        projectId: optStr(p, 'projectId'),
      }),
};
