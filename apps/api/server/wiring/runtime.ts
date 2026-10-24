// Fleet API runtime wiring: one call configures all four bounded contexts with
// in-process cross-context adapters. The composition root is the only place
// where supplier-side use cases are bound to consumer-side ports; the use
// cases themselves never import across contexts.
import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { GH_BINARY_CANDIDATES, resolveGhBinary } from "./gh-binary";
import { withFileLock, writeJsonAtomically } from "./file-store";

import {
  consumptionId,
  forgeActionScope,
  observationEventKind,
  type AttemptOwnerDecisionDelegate as WorkAttemptOwnerDecisionDelegate,
  type OwnerDecisionDelegate as WorkOwnerDecisionDelegate,
} from "@fleet/work-execution";
import { assessmentIdForAttempt } from "@fleet/evidence-and-acceptance";
import type {
  AttemptOwnerDecisionDelegate as EvidenceAttemptOwnerDecisionDelegate,
  OwnerDecisionDelegate as EvidenceOwnerDecisionDelegate,
} from "@fleet/evidence-and-acceptance";
import type {
  InspectAttemptUseCase,
  InspectWorkOrderUseCase,
} from "@fleet/work-execution/use-cases";

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

/** Whether `path` is an executable regular file (S4036: absolute gh only). */
function isExecutableRegularFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Run the reviewed GitHub CLI subprocess as an argument array for forge
 * evidence reads (D6). The binary is resolved from fixed absolute locations
 * (S4036), never through PATH; when none is found the invocation rejects so
 * the adapter reports an unreadable forge (fail closed, as a missing binary
 * does today). A completed invocation resolves with its exit code and
 * captured output; a spawn failure rejects so the adapter reports an
 * unreadable forge instead of guessing.
 */
function runGhSubprocess(args: readonly string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr?: string;
}> {
  const ghBinary = resolveGhBinary(GH_BINARY_CANDIDATES, isExecutableRegularFile);
  if (ghBinary === undefined) {
    return Promise.reject(new Error("gh not found in fixed locations"));
  }
  return new Promise((resolve, reject) => {
    execFile(ghBinary, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const code = (error as { code?: number | string }).code;
      if (typeof code === "number") {
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      reject(error);
    });
  });
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

let runtimeConfigured = false;

export function isFleetApiRuntimeConfigured(): boolean {
  return runtimeConfigured;
}

export function configureFleetApiRuntime(options?: FleetApiRuntimeOptions | null): void {
  if (options === null) {
    runtimeConfigured = false;
    configureWorkComposition(null);
    configureEvidenceUseCases(null);
    configureKnowledgeComposition(null);
    configureOperatorComposition(null);
    return;
  }

  runtimeConfigured = true;

  const stateDir = options?.stateDir;
  const ownerPublicKey = options?.ownerPublicKey;
  const installation = options?.installation;
  const operator = createConfiguredOperatorComposition({ stateDir, ownerPublicKey });
  const knowledge = createConfiguredKnowledgeComposition({
    stateDir,
    // The installation's v2 decisions block only (D3); v1 files never carry
    // one, so a v1 installation keeps today's deterministic retrieval.
    ...(installation?.decisions !== undefined
      ? { decisions: installation.decisions }
      : {}),
  });
  // The attempt lookup below is filled in once the work composition exists;
  // the evidence delegates only run at assessment time.
  const attemptLookup: { inspectAttempt?: InspectAttemptUseCase } = {};
  const ownerDecisionDelegate: EvidenceOwnerDecisionDelegate = {
    // The coordination request's own authorization rule decides; this
    // delegate calls the supplier's application port, never its repository.
    checkOwnerDecision: async (request) => {
      const result = await operator.checkOwnerDecision.checkOwnerDecision({
        requestId: request.requestId,
        candidateHeadSha: request.candidateHeadSha,
      });
      return result.outcome === "approved"
        ? { outcome: "approved", decisionId: result.requestId }
        : result;
    },
  };
  const attemptOwnerDecisionDelegate: EvidenceAttemptOwnerDecisionDelegate & WorkAttemptOwnerDecisionDelegate = {
    // The doors come from the attempt record dispatch wrote from the
    // frozen brief package, never from a request body or worktree file.
    readAttemptOwnerDecisionReferences: async (request) => {
      const inspectAttempt = attemptLookup.inspectAttempt;
      if (!inspectAttempt) {
        return {
          outcome: "unknown",
          reason: "The work context is not wired for attempt inspection",
        };
      }
      const inspection = await inspectAttempt.inspectAttempt({
        attemptId: request.attemptId,
      });
      if (inspection.outcome !== "found") {
        return {
          outcome: "unknown",
          reason: `No attempt is recorded for ${request.attemptId}`,
        };
      }
      const recorded = inspection.attempt.ownerDecisionReferences;
      if (recorded === undefined) {
        return {
          outcome: "unknown",
          reason: `attempt ${request.attemptId} was recorded before owner decision references were frozen`,
        };
      }
      return { outcome: "recorded", ownerDecisionReferences: recorded };
    },
  };
  const evidence = createConfiguredEvidenceUseCases(
    { stateDir, installation, forgeGhRunner: runGhSubprocess },
    {
      ownerDecision: ownerDecisionDelegate,
      attemptOwnerDecision: attemptOwnerDecisionDelegate,
    },
  );

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

  // The work context re-checks forge-time doors through the same coordination
  // resolution the evidence context uses; the shapes differ per context, the
  // authority (the recorded request's own rule) does not.
  const workOwnerDecisionDelegate: WorkOwnerDecisionDelegate = {
    resolveOwnerDecision: async (request) => {
      const result = await operator.checkOwnerDecision.checkOwnerDecision({
        requestId: request.decisionReference,
        candidateHeadSha: request.candidateHeadSha,
      });
      return result.outcome === "approved"
        ? { outcome: "approved", decisionId: result.requestId }
        : result;
    },
  };

  const crossContext: WorkCrossContextDelegates = {
    ownerDecision: workOwnerDecisionDelegate,
    attemptOwnerDecision: attemptOwnerDecisionDelegate,
    acceptance: {
      // One acceptance assessment per attempt candidate head; the work-side
      // request's coordinates map onto the evidence context's exact-head keys.
      assess: async (request) => {
        // Always delegate to the use case: it re-checks the attempt's one-way
        // doors before its idempotent accepted path, so a stored acceptance
        // whose owner decision has been withdrawn still blocks here.
        const result = await evidence.assessHeadAcceptance.assessHeadAcceptance({
          assessmentId: assessmentIdForAttempt(request.attemptId),
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
            actionScope: forgeActionScope(request.actionKind),
            attemptId: request.attemptId ?? coordinates.attemptId,
            expectedHeadSha: request.expectedHeadSha ?? coordinates.expectedHeadSha,
          });
        if (result.outcome === "consumed") {
          return { outcome: "consumed", actionId: request.actionId };
        }
        return { outcome: "refused", reason: result.reason };
      },
    },
    acceptanceEvidence: {
      readAcceptance: async (request) => {
        let inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
          assessmentId: assessmentIdForAttempt(request.attemptId),
          candidateHeadSha: request.candidateHeadSha,
        });
        if (inspected.outcome === "not-found") {
          inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
            assessmentId: request.attemptId,
            candidateHeadSha: request.candidateHeadSha,
          });
        }
        // No head-only fallback: an assessment that is not bound to this
        // attempt is another attempt's evidence, and this attempt has none.
        if (inspected.outcome === "found") {
          return {
            outcome: "found",
            assessment: {
              candidateHeadSha: inspected.assessment.candidateHeadSha,
              policyRevision: inspected.assessment.policyRevision,
              state: inspected.assessment.state,
              acceptanceReceiptId: inspected.assessment.acceptanceReceiptId,
            },
          };
        }
        return {
          outcome: "not-found",
          reason: `No acceptance assessment found for head ${request.candidateHeadSha}`,
        };
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
  attemptLookup.inspectAttempt = work.inspectAttempt;

  configureOperatorComposition(operator);
  configureKnowledgeComposition(knowledge);
  configureEvidenceUseCases(evidence);
  configureWorkComposition(work);
}
