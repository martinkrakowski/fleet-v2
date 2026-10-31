/** The `work-order` command group of the CLI driver; its entries moved verbatim from the command table. */

import { CLOSE_WORK_ORDER_STATES, WORK_ORDER_RISKS, resolveWorkOrderRisk } from '@fleet/work-execution';
import { CliUsageError, str, optStr, strArr, enumOf } from './payload.js';
import type {
  CommandHandler,
} from './payload.js';

export const workOrderCommands: Readonly<Record<string, CommandHandler>> = {
    register: async (p, rt) => {
      // A given --supersedes-work-order-id must carry a value: a bare flag parses as `true`
      // and an empty value would name nothing to supersede, so both are usage errors.
      if (
        Object.hasOwn(p, 'supersedesWorkOrderId') &&
        (typeof p.supersedesWorkOrderId !== 'string' || p.supersedesWorkOrderId.trim() === '')
      ) {
        throw new CliUsageError('work-order register --supersedes-work-order-id needs a work order id');
      }
      return rt.execution.registerWorkOrder.registerWorkOrder({
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
        supersedesWorkOrderId: optStr(p, 'supersedesWorkOrderId'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
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
    stale: async (p, rt) => {
      // A given --project-id must carry a value: a bare flag parses as `true` and an empty value would widen the
      // listing to every project, so both are usage errors rather than a silent fleet-wide answer.
      if (Object.hasOwn(p, 'projectId') && (typeof p.projectId !== 'string' || p.projectId.trim() === '')) {
        throw new CliUsageError('work-order stale --project-id needs a project id');
      }
      return rt.execution.listStaleWorkOrders.listStaleWorkOrders({
        projectId: optStr(p, 'projectId'),
      });
    },
    rerun: async (p, rt) => {
      // Usage checks, in order, before any read. A bare flag parses as `true`, so it is a missing value.
      if (typeof p.from !== 'string' || p.from.trim() === '') {
        throw new CliUsageError('work-order rerun --from needs the stopped work order id');
      }
      if (typeof p.workOrderId !== 'string' || p.workOrderId.trim() === '') {
        throw new CliUsageError('work-order rerun --work-order-id needs the new work order id');
      }
      // An explicit --base-commit must be a full sha; a base commit copied from the source is not
      // re-validated, because registration accepts any. That asymmetry is intentional.
      if (Object.hasOwn(p, 'baseCommit') && (typeof p.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(p.baseCommit))) {
        throw new CliUsageError('work-order rerun --base-commit needs a full commit sha (40 hex characters)');
      }
      const from = str(p, 'from');
      const newId = str(p, 'workOrderId');
      if (p.yes !== true) {
        throw new CliUsageError(
          `work-order rerun needs --yes: it registers ${newId} as a new work order copying ${from}'s project, task, lane, repository, owned paths, policy revision and risk, superseding ${from}; it starts no run, changes nothing on ${from}, and the brief is frozen again by conductor start.`,
        );
      }
      const inspected = await rt.execution.inspectWorkOrder.inspectWorkOrder({ workOrderId: from });
      if (inspected.outcome !== 'found') {
        return inspected;
      }
      const source = inspected.workOrder;
      if (source.state !== 'stopped') {
        return { outcome: 'refused' as const, reason: 'source-not-stopped', workOrderId: from, state: source.state };
      }
      return rt.execution.registerWorkOrder.registerWorkOrder({
        workOrderId: newId,
        projectId: source.projectId,
        taskId: source.taskId,
        laneId: source.laneId,
        repository: source.repository,
        ownedPaths: source.ownedPaths,
        policyRevision: source.policyRevision,
        risk: resolveWorkOrderRisk(source),
        baseCommit: p.baseCommit !== undefined ? String(p.baseCommit) : source.baseCommit,
        prerequisiteWorkOrderIds: [],
        supersedesWorkOrderId: from,
        nowIso: optStr(p, 'nowIso'),
      });
    },
};
