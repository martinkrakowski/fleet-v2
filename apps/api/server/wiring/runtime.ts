// Fleet API runtime wiring: one call configures all four bounded contexts with
// in-process cross-context adapters. The composition root is the only place
// where supplier-side use cases are bound to consumer-side ports; the use
// cases themselves never import across contexts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { withFileLock, writeJsonAtomically } from "./file-store";

import {
  consumptionId,
  forgeActionScope,
  observationEventKind,
} from "@fleet/work-execution";
import type { InspectWorkOrderUseCase } from "@fleet/work-execution/use-cases";

import type { FleetInstallation } from "@fleet/installation";

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
  readonly ownerPublicKey?: string;
  readonly installation?: FleetInstallation;
}

/**
 * The attempt coordinates recorded when an authorization grant is resolved.
 * The work-side consumption request does not carry them, so they must
 * survive the resolving process to scope any later consumption.
 */
export interface FleetAuthorizationCoordinate {
  readonly attemptId: string;
  readonly expectedHeadSha: string;
}

/** Cross-process state file names inside the shared `stateDir`. */
const ACCEPTED_RECEIPTS_FILE = "accepted-receipts.json";
const AUTHORIZATION_COORDINATES_FILE = "authorization-coordinates.json";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isAuthorizationCoordinate(value: unknown): value is FleetAuthorizationCoordinate {
  return (
    isPlainRecord(value) &&
    typeof value.attemptId === "string" &&
    typeof value.expectedHeadSha === "string"
  );
}

/**
 * Read the acceptance receipts persisted under `stateDir`. ENOENT means {};
 * unreadable or malformed persisted state throws. Any other filesystem error (e.g. EACCES) throws.
 */
export function readAcceptedReceiptsFromState(stateDir: string): Record<string, string> {
  const filePath = join(stateDir, ACCEPTED_RECEIPTS_FILE);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isRecordOfStrings(parsed)) {
    throw new Error(
      `Unreadable accepted receipts state at ${filePath}: expected a JSON object of string values`,
    );
  }
  return { ...parsed };
}

/**
 * Atomically persist `receipts` to `<stateDir>/accepted-receipts.json`,
 * merging the receipts already on disk so records written by other processes
 * (a CLI run, an earlier API process) are never dropped.
 */
export async function persistAcceptedReceiptsToState(
  stateDir: string,
  receipts: Readonly<Record<string, string>>,
): Promise<void> {
  const filePath = join(stateDir, ACCEPTED_RECEIPTS_FILE);
  await withFileLock(`${filePath}.lock`, async () => {
    const diskReceipts = readAcceptedReceiptsFromState(stateDir);
    await writeJsonAtomically(filePath, {
      ...diskReceipts,
      ...receipts,
    });
  });
}

/**
 * Read the authorization coordinates persisted under `stateDir`. ENOENT
 * means an empty map; unreadable or malformed persisted state throws.
 * Any other filesystem error (e.g. EACCES) throws.
 */
export function readAuthorizationCoordinatesFromState(
  stateDir: string,
): Map<string, FleetAuthorizationCoordinate> {
  const filePath = join(stateDir, AUTHORIZATION_COORDINATES_FILE);
  const coordinates = new Map<string, FleetAuthorizationCoordinate>();
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return coordinates;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isPlainRecord(parsed)) {
    throw new Error(
      `Unreadable authorization coordinates state at ${filePath}: expected a JSON object`,
    );
  }
  for (const [grantId, coordinate] of Object.entries(parsed)) {
    if (isAuthorizationCoordinate(coordinate)) {
      coordinates.set(grantId, {
        attemptId: coordinate.attemptId,
        expectedHeadSha: coordinate.expectedHeadSha,
      });
    }
  }
  return coordinates;
}

/**
 * Atomically persist `coordinates` to `<stateDir>/authorization-coordinates.json`,
 * merging the coordinates already on disk so grants resolved by other
 * processes keep their scopes.
 */
export async function persistAuthorizationCoordinatesToState(
  stateDir: string,
  coordinates: ReadonlyMap<string, FleetAuthorizationCoordinate>,
): Promise<void> {
  const filePath = join(stateDir, AUTHORIZATION_COORDINATES_FILE);
  await withFileLock(`${filePath}.lock`, async () => {
    const merged = readAuthorizationCoordinatesFromState(stateDir);
    for (const [grantId, coordinate] of coordinates) {
      merged.set(grantId, coordinate);
    }
    await writeJsonAtomically(
      filePath,
      Object.fromEntries(merged),
    );
  });
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
  const ownerPublicKey = options?.ownerPublicKey;
  const installation = options?.installation;
  const operator = createConfiguredOperatorComposition({ stateDir, ownerPublicKey });
  const knowledge = createConfiguredKnowledgeComposition({ stateDir });
  const evidence = createConfiguredEvidenceUseCases({ stateDir });

  // Authorization grants resolved in this process remember the attempt
  // coordinates the work-side consumption request does not carry. With a
  // shared stateDir they are persisted atomically on resolve and reloaded
  // on consumption, so a grant resolved by an earlier process stays scoped.
  const resolveCoordinates = new Map<string, FleetAuthorizationCoordinate>();

  // The notes-forwarding delegate resolves the note's project through the
  // work context's own lookup, captured as soon as the composition exists.
  const workLookup: { inspectWorkOrder?: InspectWorkOrderUseCase } = {};

  // Live registry of acceptance receipts per candidate head: the acceptance
  // delegate records entries and the merge gate consumes them, so a merge is
  // only ever authorized for a head whose acceptance receipt exists. With a
  // shared stateDir the registry is persisted atomically on every acceptance
  // and re-read before each lookup, so receipts recorded by earlier processes
  // (CLI runs, restarted API processes) survive this process boundary.
  const liveAcceptedReceiptByHead: Record<string, string> = {};
  const acceptedReceiptByHead: Record<string, string> =
    stateDir === undefined
      ? liveAcceptedReceiptByHead
      : new Proxy(liveAcceptedReceiptByHead, {
          get(target, property, receiver) {
            if (typeof property === "string") {
              return { ...readAcceptedReceiptsFromState(stateDir), ...target }[property];
            }
            return Reflect.get(target, property, receiver);
          },
        });

  const crossContext: WorkCrossContextDelegates = {
    acceptance: {
      // One acceptance assessment per attempt candidate head; the work-side
      // request's coordinates map onto the evidence context's exact-head keys.
      assess: async (request) => {
        const inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
          assessmentId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
        });
        if (
          inspected.outcome === "found" &&
          inspected.assessment.state === "accepted" &&
          inspected.assessment.candidateHeadSha === request.candidateHeadSha &&
          inspected.assessment.policyRevision === request.policyRevision &&
          inspected.assessment.acceptanceReceiptId !== null
        ) {
          acceptedReceiptByHead[inspected.assessment.candidateHeadSha] =
            inspected.assessment.acceptanceReceiptId;
          if (stateDir !== undefined) {
            persistAcceptedReceiptsToState(stateDir, liveAcceptedReceiptByHead);
          }
          return {
            outcome: "accepted",
            receiptId: inspected.assessment.acceptanceReceiptId,
            assessedHeadSha: inspected.assessment.candidateHeadSha,
          };
        }
        const result = await evidence.assessHeadAcceptance.assessHeadAcceptance({
          assessmentId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
          policyRevision: request.policyRevision,
        });
        switch (result.outcome) {
          case "accepted": {
            acceptedReceiptByHead[result.candidateHeadSha] = result.receiptId;
            if (stateDir !== undefined) {
              await persistAcceptedReceiptsToState(stateDir, {
                [result.candidateHeadSha]: result.receiptId,
              });
            }
            return {
              outcome: "accepted",
              receiptId: result.receiptId,
              assessedHeadSha: result.candidateHeadSha,
            };
          }
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
          actionScope: forgeActionScope(request.actionKind),
          expectedHeadSha: request.expectedHeadSha,
        });
        if (result.outcome === "blocked") {
          return { outcome: "blocked", reason: result.reason };
        }
        resolveCoordinates.set(result.grantId, {
          attemptId: request.attemptId,
          expectedHeadSha: request.expectedHeadSha,
        });
        if (stateDir !== undefined) {
          await persistAuthorizationCoordinatesToState(
            stateDir,
            new Map([
              [
                result.grantId,
                {
                  attemptId: request.attemptId,
                  expectedHeadSha: request.expectedHeadSha,
                },
              ],
            ]),
          );
        }
        return { outcome: "granted", authorizationGrantId: result.grantId };
      },
      // The work-side consume request carries only the grant and action ids;
      // the coordinates recorded at resolve time scope the consumption.
      consumeGrant: async (request) => {
        if (stateDir !== undefined) {
          // Reload the persisted coordinates so a restarted process honors
          // grants resolved before it started.
          for (const [grantId, coordinate] of readAuthorizationCoordinatesFromState(stateDir)) {
            if (!resolveCoordinates.has(grantId)) {
              resolveCoordinates.set(grantId, coordinate);
            }
          }
        }
        const coordinates = resolveCoordinates.get(request.authorizationGrantId);
        if (!coordinates) {
          return {
            outcome: "refused",
            reason: `No in-process authorization resolve recorded grant ${request.authorizationGrantId}`,
          };
        }
        const result =
          await operator.recordAuthorizationConsumption.recordAuthorizationConsumption({
            consumptionId: consumptionId(request.actionId),
            grantId: request.authorizationGrantId,
            actionId: request.actionId,
            actionKind: request.actionKind,
            attemptId: request.attemptId ?? coordinates.attemptId,
            expectedHeadSha: request.expectedHeadSha ?? coordinates.expectedHeadSha,
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
          eventKind: observationEventKind(request.entry.action, request.entry.status),
          sourceAttemptId: request.entry.attemptId,
          payloadSummary: request.entry.status,
        });
        if (result.outcome === "published") {
          return { outcome: "published" };
        }
        return { outcome: "delivery-gap", reason: result.reason };
      },
    },
    acceptedReceiptByHead,
  };

  const work = createConfiguredWorkComposition({ stateDir, installation }, crossContext);
  workLookup.inspectWorkOrder = work.inspectWorkOrder;

  configureOperatorComposition(operator);
  configureKnowledgeComposition(knowledge);
  configureEvidenceUseCases(evidence);
  configureWorkComposition(work);
}
