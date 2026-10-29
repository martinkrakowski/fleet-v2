/** The `brief` command group of the CLI driver; its entries moved verbatim from the command table. */

import { parseSeatTool } from '@fleet/work-execution';
import type { AcceptanceSpecProps, BriefContextDecision, BriefModelAssignment } from '@fleet/work-execution';
import { unhealthySeatIdsOf } from '../seat-plan.js';
import { str, optStr, strOrNull, num, strArr, nested, nestedArr, jsonStrArr, jsonObj, derivedV2Model, briefSeatPlan, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const briefCommands: Readonly<Record<string, CommandHandler>> = {
    prepare: async (p, rt) => {
      const contextDecisions = nestedArr<BriefContextDecision>(p, 'contextDecisions') ?? [];
      for (const decision of contextDecisions) {
        if (
          !decision ||
          typeof decision !== 'object' ||
          typeof decision.decisionBecause !== 'string' ||
          decision.decisionBecause.trim() === ''
        ) {
          throw new CliUsageError(
            "brief prepare contextDecisions requires a non-empty 'decisionBecause' for each item",
          );
        }
      }
      // H8: the seat tool is required and frozen into the manifest, so it is
      // covered by the digest. Missing or undeclared is a usage error (exit
      // 2), never a default to opencode.
      const nestedAssignment = nested<BriefModelAssignment>(p, 'modelAssignment');
      const rawSeatTool = p['seatTool'] ?? nestedAssignment?.seatTool;
      const seatTool = parseSeatTool(rawSeatTool);
      if (seatTool === undefined) {
        throw new CliUsageError(
          'brief prepare requires --seatTool naming a declared runner kind (opencode or agy)',
        );
      }
      if (
        nestedAssignment !== undefined &&
        nestedAssignment.seatTool !== undefined &&
        nestedAssignment.seatTool !== seatTool
      ) {
        throw new CliUsageError(
          `'--seatTool ${String(seatTool)}' conflicts with the seat tool in --modelAssignment`,
        );
      }
      const seatPlan = briefSeatPlan(p, rt);
      const unhealthy = new Set(unhealthySeatIdsOf(derivedV2Model(rt)));
      const planSeatForAssignment =
        seatPlan !== undefined && nestedAssignment === undefined && optStr(p, 'model') === undefined
          ? seatPlan['first-pass'].find((seat) => !unhealthy.has(seat.id))
          : undefined;
      if (
        seatPlan !== undefined &&
        nestedAssignment === undefined &&
        optStr(p, 'model') === undefined &&
        planSeatForAssignment === undefined
      ) {
        throw new CliUsageError(
          'Every first-pass seat of the seat plan is unhealthy; pass --model to choose one',
        );
      }
      let modelAssignment: BriefModelAssignment;
      if (nestedAssignment !== undefined) {
        modelAssignment = { ...nestedAssignment, seatTool };
      } else if (planSeatForAssignment !== undefined) {
        modelAssignment = {
          model: planSeatForAssignment.model,
          variant: planSeatForAssignment.variant ?? 'default',
          fallbackModel: str(p, 'fallbackModel') || planSeatForAssignment.model,
          seatTool,
          ...(planSeatForAssignment.agent !== undefined ? { agent: planSeatForAssignment.agent } : {}),
        } as BriefModelAssignment;
      } else {
        modelAssignment = {
          model: str(p, 'model'),
          variant: str(p, 'variant') || 'default',
          fallbackModel: str(p, 'fallbackModel'),
          seatTool,
        };
      }
      return rt.execution.prepareBriefPackage.prepareBriefPackage({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        policyRevision: str(p, 'policyRevision'),
        modelAssignment,
        independentReviewer: str(p, 'independentReviewer'),
        ownedPaths: strArr(p, 'ownedPaths'),
        // The edit-only diff check's allowed prefixes: one JSON array (or an
        // array in --json). A malformed value is a usage error (exit 2),
        // never a silent empty list.
        allowedPathPrefixes: jsonStrArr(p, 'allowedPathPrefixes', 'brief prepare'),
        permissions: strArr(p, 'permissions'),
        acceptanceChecks: strArr(p, 'acceptanceChecks'),
        acceptanceSpec: jsonObj(p, 'acceptanceSpec', 'brief prepare') as AcceptanceSpecProps | undefined,
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        resourceBounds: nested<Record<string, string>>(p, 'resourceBounds') ?? {},
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        ownerDecisionReferences: strArr(p, 'ownerDecisionReferences'),
        contextDecisions,
        attemptId: optStr(p, 'attemptId'),
        worktreePath: optStr(p, 'worktreePath'),
        handWrittenBriefPath: strOrNull(p, 'handWrittenBriefPath'),
        ...(seatPlan !== undefined ? { seatPlan } : {}),
      });
    },
};
