/** The `capacity` command group of the CLI driver; its entries moved verbatim from the command table. */

import { parseSeatTool } from '@fleet/work-execution';
import { laneRunnerCandidateHosts } from '../conductor-wiring.js';
import { str, optStr, num, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const capacityCommands: Readonly<Record<string, CommandHandler>> = {
    reserve: async (p, rt) => {
      // A v2 installation records the installation's own hosts (plan
      // section 3); the operator never types a host, a slot budget or a
      // worktree path. The host is chosen inside the reserve's locked
      // section among the installation's lane-runner hosts (H9a2).
      const isV2 = rt.installation?.schemaVersion === 2;
      if (isV2) {
        if (p['hostId'] !== undefined) {
          throw new CliUsageError(
            "'hostId' is not accepted for a v2 installation; the host is chosen from the installation's lane-runner hosts inside the reserve",
          );
        }
        if (p['maxSlots'] !== undefined) {
          throw new CliUsageError(
            "'maxSlots' is not accepted for a v2 installation; each host's declared maxLanes feeds the slot budget",
          );
        }
        if (p['worktreePath'] !== undefined) {
          throw new CliUsageError(
            "'worktreePath' is not accepted for a v2 installation; the worktree path is allocated from the attempt id inside the reserve",
          );
        }
        const v2Candidates = laneRunnerCandidateHosts(rt.installation);
        if (v2Candidates === undefined || v2Candidates.length === 0) {
          throw new CliUsageError(
            "the installation declares no lane-runner host; add one to the installation's hosts entry before reserving capacity",
          );
        }
        // H8: the seat tool comes from the request's chain seat and is required;
        // missing or undeclared is a usage error (exit 2), never a default.
        const seatToolV2 = parseSeatTool(p['seatTool']);
        if (seatToolV2 === undefined) {
          throw new CliUsageError(
            'capacity reserve requires --seatTool naming a declared runner kind (opencode or agy)',
          );
        }
        const v2Result = await rt.execution.reserveExecutionCapacity.reserveExecutionCapacity({
          reservationId: str(p, 'reservationId'),
          attemptId: str(p, 'attemptId'),
          workOrderId: str(p, 'workOrderId'),
          seatTool: seatToolV2,
          candidateHosts: v2Candidates,
          nowIso: optStr(p, 'nowIso'),
        });
        if (v2Result.outcome === 'reserved') {
          // The chosen host and the allocated path are the two facts the
          // operator needs to see; the reservation itself records both.
          return {
            ...v2Result,
            chosenHost: v2Result.reservation.hostName,
            chosenHostKind: v2Result.reservation.hostKind,
            worktreePath: v2Result.reservation.worktreePath,
          };
        }
        return v2Result;
      }
      // The runner's installation entry feeds capacity maxSlots (plan item 4):
      // a declared maxLanes is the host budget, and a conflicting operator
      // value is a usage error rather than a silent override.
      const declaredMaxLanes = rt.execution.runnerMaxLanes;
      if (declaredMaxLanes !== undefined && p['maxSlots'] !== undefined) {
        const supplied = num(p, 'maxSlots', declaredMaxLanes);
        if (supplied !== declaredMaxLanes) {
          throw new CliUsageError(
            `'--maxSlots ${supplied}' conflicts with the runner's declared maxLanes ${declaredMaxLanes}; the installation feeds capacity maxSlots`,
          );
        }
      }
      // H8: the seat tool comes from the request's chain seat and is required;
      // missing or undeclared is a usage error (exit 2), never a default.
      const seatTool = parseSeatTool(p['seatTool']);
      if (seatTool === undefined) {
        throw new CliUsageError(
          'capacity reserve requires --seatTool naming a declared runner kind (opencode or agy)',
        );
      }
      return rt.execution.reserveExecutionCapacity.reserveExecutionCapacity({
        reservationId: str(p, 'reservationId'),
        attemptId: str(p, 'attemptId'),
        workOrderId: str(p, 'workOrderId'),
        hostId: str(p, 'hostId'),
        worktreePath: str(p, 'worktreePath'),
        maxSlots: declaredMaxLanes ?? num(p, 'maxSlots', 1),
        seatTool,
        nowIso: optStr(p, 'nowIso'),
      });
    },
};
