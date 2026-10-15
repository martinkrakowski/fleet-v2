// Fleet API runtime wiring: one call configures all four bounded contexts with
// in-process cross-context adapters. The composition root is the only place
// where supplier-side use cases are bound to consumer-side ports; the use
// cases themselves never import across contexts.
import type { InspectWorkOrderUseCase } from "@fleet/work-execution/use-cases";

import { configureEvidenceUseCases, createConfiguredEvidenceUseCases } from "./evidence/composition";
import {
  configureKnowledgeComposition,
  createConfiguredKnowledgeComposition,
} from "./knowledge/composition";
import {
  configureOperatorComposition,
  createConfiguredOperatorComposition,
} from "./operator/composition";
import {
  configureWorkComposition,
  createConfiguredWorkComposition,
  type WorkCrossContextDelegates,
} from "./work/composition";

export interface FleetApiRuntimeOptions {
  /** Shared persistence directory for every context's file-backed adapters. */
  readonly stateDir?: string;
}

export function configureFleetApiRuntime(options?: FleetApiRuntimeOptions | null): void {
  if (options === null) {
    configureWorkComposition(null);
    configureEvidenceUseCases(null);
    configureKnowledgeComposition(null);
    configureOperatorComposition(null);
    return;
  }

  const stateDir = options?.stateDir;
  const operator = createConfiguredOperatorComposition({ stateDir });
  const knowledge = createConfiguredKnowledgeComposition({ stateDir });
  const evidence = createConfiguredEvidenceUseCases({ stateDir });

  // Authorization grants resolved in this process remember the attempt
  // coordinates the work-side consumption request does not carry.
  const resolveCoordinates = new Map<string, { attemptId: string; expectedHeadSha: string }>();

  // The notes-forwarding delegate resolves the note's project through the
  // work context's own lookup, captured as soon as the composition exists.
  const workLookup: { inspectWorkOrder?: InspectWorkOrderUseCase } = {};

  const crossContext: WorkCrossContextDelegates = {
    acceptance: {
      // One acceptance assessment per attempt candidate head; the work-side
      // request's coordinates map onto the evidence context's exact-head keys.
      assess: async (request) => {
        const result = await evidence.assessHeadAcceptance.assessHeadAcceptance({
          assessmentId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
          policyRevision: request.policyRevision,
        });
        switch (result.outcome) {
          case "accepted":
            return {
              outcome: "accepted",
              receiptId: result.receiptId,
              assessedHeadSha: result.candidateHeadSha,
            };
          case "blocked":
            return { outcome: "rejected", reason: result.blockers.join("; ") };
          default:
            return { outcome: "unknown", reason: result.reason };
        }
      },
    },
    briefKnowledge: {
      propose: async (request) => {
        const result = await knowledge.proposeBriefContext.proposeBriefContext({
          projectId: request.projectId,
          laneId: request.laneId,
          taskSummary: request.taskSummary,
        });
        if (result.outcome === "rejected") {
          return { outcome: "unavailable", reason: result.reason };
        }
        return {
          outcome: "proposed",
          proposals: result.proposals.map(
            ({ proposalId, knowledgeEntryId, version, proposedBecause }) => ({
              proposalId,
              knowledgeEntryId,
              version,
              proposedBecause,
            }),
          ),
        };
      },
      recordSelection: async (request) => {
        const result = await knowledge.recordContextSelection.recordContextSelection({
          attemptId: request.attemptId,
          selections: [...request.selections],
        });
        if (result.outcome === "recorded") {
          return { outcome: "recorded" };
        }
        return { outcome: "refused", reason: result.reason };
      },
      forwardNotes: async (request) => {
        const inspect = workLookup.inspectWorkOrder;
        if (!inspect) {
          return { outcome: "refused", reason: "Work context is not wired for notes forwarding" };
        }
        const inspection = await inspect.inspectWorkOrder({ workOrderId: request.workOrderId });
        if (inspection.outcome !== "found") {
          return { outcome: "refused", reason: `Work order not found: ${request.workOrderId}` };
        }
        const result = await knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes({
          projectId: inspection.workOrder.projectId,
          attemptId: request.attemptId,
          workOrderId: request.workOrderId,
          headCommitSha: request.headCommit,
          notesMarkdown: request.notes,
        });
        if (result.outcome === "captured") {
          return { outcome: "forwarded" };
        }
        return { outcome: "refused", reason: result.reason };
      },
    },
    authorization: {
      resolveGrant: async (request) => {
        const result = await operator.resolveActionAuthorization.resolveActionAuthorization({
          projectId: request.projectId,
          actionScope: `${request.workOrderId}/${request.actionKind}`,
          expectedHeadSha: request.expectedHeadSha,
        });
        if (result.outcome === "blocked") {
          return { outcome: "blocked", reason: result.reason };
        }
        resolveCoordinates.set(result.grantId, {
          attemptId: request.attemptId,
          expectedHeadSha: request.expectedHeadSha,
        });
        return { outcome: "granted", authorizationGrantId: result.grantId };
      },
      // The work-side consume request carries only the grant and action ids;
      // the coordinates recorded at resolve time scope the consumption.
      consumeGrant: async (request) => {
        const coordinates = resolveCoordinates.get(request.authorizationGrantId);
        if (!coordinates) {
          return {
            outcome: "refused",
            reason: `No in-process authorization resolve recorded grant ${request.authorizationGrantId}`,
          };
        }
        const result =
          await operator.recordAuthorizationConsumption.recordAuthorizationConsumption({
            consumptionId: `consumption-${request.authorizationGrantId}`,
            grantId: request.authorizationGrantId,
            actionId: request.actionId,
            attemptId: coordinates.attemptId,
            expectedHeadSha: coordinates.expectedHeadSha,
          });
        if (result.outcome === "consumed") {
          return { outcome: "consumed", actionId: request.actionId };
        }
        return { outcome: "refused", reason: result.reason };
      },
    },
    observation: {
      publish: async (request) => {
        const result = await operator.publishProjectObservation.publishProjectObservation({
          observationId: request.entry.id,
          projectId: request.projectId,
          eventKind: request.entry.action,
          sourceAttemptId: request.entry.attemptId,
          payloadSummary: request.entry.status,
        });
        if (result.outcome === "published") {
          return { outcome: "published" };
        }
        return { outcome: "delivery-gap", reason: result.reason };
      },
    },
  };

  const work = createConfiguredWorkComposition({ stateDir }, crossContext);
  workLookup.inspectWorkOrder = work.inspectWorkOrder;

  configureOperatorComposition(operator);
  configureKnowledgeComposition(knowledge);
  configureEvidenceUseCases(evidence);
  configureWorkComposition(work);
}
