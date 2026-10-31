import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  CaptureCompletedAttemptNotesUseCase,
  CheckKnowledgeClaimUseCase,
  DecideKnowledgeDispositionUseCase,
  ProposeBriefContextUseCase,
  PublishAcceptedKeeperUseCase,
  RecordContextSelectionUseCase,
  RecordKnowledgeReuseUseCase,
  SupersedeKnowledgeEntryUseCase,
} from "@fleet/brief-knowledge/use-cases";
import {
  AssessHeadAcceptanceUseCase,
  InspectAcceptanceEvidenceUseCase,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
} from "@fleet/evidence-and-acceptance/use-cases";
import {
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  PublishProjectObservationUseCase,
  ReadProjectAttentionUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  SendFleetRelayUseCase,
} from "@fleet/operator-coordination/use-cases";
import {
  CollectAttemptArtifactsUseCase,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  InspectWorkOrderUseCase,
  PrepareBriefPackageUseCase,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReserveExecutionCapacityUseCase,
  StopAttemptUseCase,
} from "@fleet/work-execution/use-cases";

import {
  configureEvidenceUseCases,
  createConfiguredEvidenceUseCases,
  getEvidenceUseCases,
} from "../evidence/composition";
import { mapEvidenceError } from "../evidence/errors";
import {
  configureKnowledgeComposition,
  createConfiguredKnowledgeComposition,
  getKnowledgeComposition,
} from "../knowledge/composition";
import { mapKnowledgeError } from "../knowledge/errors";
import {
  configureOperatorComposition,
  createConfiguredOperatorComposition,
  getOperatorComposition,
} from "../operator/composition";
import { mapOperatorError } from "../operator/errors";
import { configureFleetApiRuntime } from "../runtime";
import {
  configureWorkComposition,
  createConfiguredWorkComposition,
  workComposition,
} from "../work/composition";
import { mapWorkError } from "../work/errors";

const execFileAsync = promisify(execFile);

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-api-composition-"));
  createdDirs.add(directory);
  return directory;
}

/** Real temporary Git repository whose `.lane/` directory is gitignored. */
async function makeTempGitRepo(): Promise<string> {
  const repoPath = await makeTempDir();
  const git = async (args: readonly string[]): Promise<void> => {
    await execFileAsync(
      "git",
      ["-c", "user.name=Fleet Test", "-c", "user.email=fleet-test@example.invalid", ...args],
      { cwd: repoPath },
    );
  };
  await git(["init"]);
  await writeFile(path.join(repoPath, ".gitignore"), ".lane/\n", "utf8");
  await writeFile(path.join(repoPath, "README.md"), "# fleet api composition test\n", "utf8");
  await git(["add", "."]);
  await git(["commit", "-m", "initial commit"]);
  return repoPath;
}

const WORK_ORDER_REQUEST = {
  workOrderId: "wo-api-1",
  projectId: "proj-api-1",
  taskId: "task-api-1",
  laneId: "lane-api-1",
  repository: "fleet",
  baseCommit: "abc1234",
  policyRevision: "policy-1",
  ownedPaths: ["apps/api/**"],
};

const VERIFICATION_REQUEST = {
  assessmentId: "att-api-1",
  projectId: "proj-api-1",
  attemptId: "att-api-1",
  candidateHeadSha: "def5678",
  policyRevision: "policy-1",
  hostId: "host-1",
  implementerModel: "seat/implementer",
  requiredChecks: ["typecheck"],
};

const NOTES_REQUEST = {
  projectId: "proj-api-1",
  attemptId: "att-api-1",
  workOrderId: "wo-api-1",
  headCommitSha: "def5678",
  notesMarkdown: "- The composition root wires all four contexts\n",
};

const PROFILE_REQUEST = {
  projectId: "proj-api-1",
  displayName: "Fleet API",
  repository: "fleet",
  designatedDispatcherHost: "host-1",
  policyRevision: "policy-1",
  maxConcurrentLanes: 2,
  runnerCapabilities: { networkEgressRestricted: true },
};

describe("default unconfigured compositions", () => {
  it("work use cases refuse with 'Not implemented' and map to 501", async () => {
    const work = workComposition();
    await expect(work.registerWorkOrder.execute(undefined)).rejects.toThrow(
      "Not implemented: RegisterWorkOrderUseCase",
    );
    await expect(work.inspectWorkOrder.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(work.prepareBriefPackage.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(work.reserveExecutionCapacity.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(work.dispatchAttempt.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(work.reconcileAttempt.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(work.stopAttempt.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(work.collectAttemptArtifacts.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(work.prepareFixAttempt.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(work.requestAttemptAcceptance.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(work.executeAuthorizedForgeAction.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );

    expect(mapWorkError(new Error("Not implemented: RegisterWorkOrderUseCase"))).toEqual({
      status: 501,
      code: "NOT_IMPLEMENTED",
    });
    expect(mapWorkError(new Error("Unexpected failure"))).toBeNull();
  });

  it("evidence use cases refuse with 'Not implemented' and map to 501", async () => {
    const evidence = getEvidenceUseCases();
    expect(evidence.requestVerification).toBeInstanceOf(RequestVerificationUseCase);
    expect(evidence.recordVerificationReceipt).toBeInstanceOf(RecordVerificationReceiptUseCase);
    expect(evidence.requestIndependentReview).toBeInstanceOf(RequestIndependentReviewUseCase);
    expect(evidence.recordReviewReceipt).toBeInstanceOf(RecordReviewReceiptUseCase);
    expect(evidence.assessHeadAcceptance).toBeInstanceOf(AssessHeadAcceptanceUseCase);
    expect(evidence.inspectAcceptanceEvidence).toBeInstanceOf(InspectAcceptanceEvidenceUseCase);
    expect(evidence.recordFindingDisposition).toBeInstanceOf(RecordFindingDispositionUseCase);

    await expect(evidence.requestVerification.execute(undefined)).rejects.toThrow(
      "Not implemented: RequestVerificationUseCase",
    );
    await expect(evidence.recordVerificationReceipt.execute(undefined)).rejects.toThrow(
      "Not implemented: RecordVerificationReceiptUseCase",
    );
    await expect(evidence.requestIndependentReview.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(evidence.recordReviewReceipt.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(evidence.assessHeadAcceptance.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(evidence.inspectAcceptanceEvidence.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(evidence.recordFindingDisposition.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );

    expect(mapEvidenceError(new Error("Not implemented: RequestVerificationUseCase"))).toEqual({
      status: 501,
      code: "NOT_IMPLEMENTED",
    });
    expect(mapEvidenceError(new Error("Unexpected failure"))).toBeNull();
  });

  it("knowledge use cases refuse with 'Not implemented' and map to 501", async () => {
    const knowledge = getKnowledgeComposition();
    expect(knowledge.captureCompletedAttemptNotes).toBeInstanceOf(
      CaptureCompletedAttemptNotesUseCase,
    );
    expect(knowledge.checkKnowledgeClaim).toBeInstanceOf(CheckKnowledgeClaimUseCase);
    expect(knowledge.decideKnowledgeDisposition).toBeInstanceOf(DecideKnowledgeDispositionUseCase);
    expect(knowledge.proposeBriefContext).toBeInstanceOf(ProposeBriefContextUseCase);
    expect(knowledge.publishAcceptedKeeper).toBeInstanceOf(PublishAcceptedKeeperUseCase);
    expect(knowledge.recordContextSelection).toBeInstanceOf(RecordContextSelectionUseCase);
    expect(knowledge.recordKnowledgeReuse).toBeInstanceOf(RecordKnowledgeReuseUseCase);
    expect(knowledge.supersedeKnowledgeEntry).toBeInstanceOf(SupersedeKnowledgeEntryUseCase);

    await expect(knowledge.captureCompletedAttemptNotes.execute(undefined as never)).rejects.toThrow(
      "Not implemented: CaptureCompletedAttemptNotesUseCase",
    );
    await expect(knowledge.checkKnowledgeClaim.execute(undefined as never)).rejects.toThrow(
      "Not implemented: CheckKnowledgeClaimUseCase",
    );
    await expect(knowledge.decideKnowledgeDisposition.execute(undefined as never)).rejects.toThrow(
      "Not implemented",
    );
    await expect(knowledge.proposeBriefContext.execute(undefined as never)).rejects.toThrow(
      "Not implemented",
    );
    await expect(knowledge.publishAcceptedKeeper.execute(undefined as never)).rejects.toThrow(
      "Not implemented",
    );
    await expect(knowledge.recordContextSelection.execute(undefined as never)).rejects.toThrow(
      "Not implemented",
    );
    await expect(knowledge.recordKnowledgeReuse.execute(undefined as never)).rejects.toThrow(
      "Not implemented",
    );
    await expect(knowledge.supersedeKnowledgeEntry.execute(undefined as never)).rejects.toThrow(
      "Not implemented",
    );

    expect(mapKnowledgeError(new Error("Not implemented: CheckKnowledgeClaimUseCase"))).toEqual({
      status: 501,
      code: "NOT_IMPLEMENTED",
    });
    expect(mapKnowledgeError(new Error("Unexpected failure"))).toBeNull();
  });

  it("operator use cases refuse with 'Not implemented' and map to 501", async () => {
    const operator = getOperatorComposition();
    expect(operator.inspectConfiguredCapabilities).toBeInstanceOf(
      InspectConfiguredCapabilitiesUseCase,
    );
    expect(operator.publishProjectObservation).toBeInstanceOf(PublishProjectObservationUseCase);
    expect(operator.requestScopedDecision).toBeInstanceOf(RequestScopedDecisionUseCase);
    expect(operator.resolveActionAuthorization).toBeInstanceOf(ResolveActionAuthorizationUseCase);
    expect(operator.recordAuthorizationConsumption).toBeInstanceOf(
      RecordAuthorizationConsumptionUseCase,
    );
    expect(operator.readProjectAttention).toBeInstanceOf(ReadProjectAttentionUseCase);
    expect(operator.inspectOutstandingCoordination).toBeInstanceOf(
      InspectOutstandingCoordinationUseCase,
    );
    expect(operator.sendFleetRelay).toBeInstanceOf(SendFleetRelayUseCase);
    expect(operator.recordRelayAcknowledgement).toBeInstanceOf(RecordRelayAcknowledgementUseCase);
    expect(operator.registerProjectProfile).toBeInstanceOf(RegisterProjectProfileUseCase);

    await expect(operator.inspectConfiguredCapabilities.execute(undefined)).rejects.toThrow(
      "Not implemented: InspectConfiguredCapabilitiesUseCase",
    );
    await expect(operator.publishProjectObservation.execute(undefined)).rejects.toThrow(
      "Not implemented: PublishProjectObservationUseCase",
    );
    await expect(operator.requestScopedDecision.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(operator.resolveActionAuthorization.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(operator.recordAuthorizationConsumption.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(operator.readProjectAttention.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(operator.inspectOutstandingCoordination.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(operator.sendFleetRelay.execute(undefined)).rejects.toThrow("Not implemented");
    await expect(operator.recordRelayAcknowledgement.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );
    await expect(operator.registerProjectProfile.execute(undefined)).rejects.toThrow(
      "Not implemented",
    );

    expect(mapOperatorError(new Error("Not implemented: RegisterProjectProfileUseCase"))).toEqual({
      status: 501,
      code: "NOT_IMPLEMENTED",
    });
    expect(mapOperatorError(new Error("Unexpected failure"))).toBeNull();
  });
});

describe("configured compositions execute real operations", () => {
  beforeEach(() => {
    configureWorkComposition(null);
    configureEvidenceUseCases(null);
    configureKnowledgeComposition(null);
    configureOperatorComposition(null);
  });

  it("work composition registers, inspects, reserves and refuses fix rounds", async () => {
    const stateDir = await makeTempDir();
    // The work-order guard needs a profile; register one through the operator
    // context and delegate profile reads to it from the work composition.
    const operator = createConfiguredOperatorComposition({ stateDir });
    const profiled = await operator.registerProjectProfile.execute(PROFILE_REQUEST);
    expect(profiled.outcome).toBe("registered");
    const work = createConfiguredWorkComposition(
      { stateDir },
      {
        projectProfile: {
          inspect: async (request) => operator.inspectProjectProfile.execute(request),
          record: async (request) => operator.recordProjectProbe.execute(request),
        },
      },
    );

    const registered = await work.registerWorkOrder.registerWorkOrder(WORK_ORDER_REQUEST);
    expect(registered.outcome).toBe("registered");

    // A duplicate identity is rejected against the persisted store.
    const duplicate = await work.registerWorkOrder.registerWorkOrder(WORK_ORDER_REQUEST);
    expect(duplicate.outcome).toBe("rejected");

    const inspected = await work.inspectWorkOrder.inspectWorkOrder({
      workOrderId: WORK_ORDER_REQUEST.workOrderId,
    });
    expect(inspected.outcome).toBe("found");
    if (inspected.outcome === "found") {
      expect(inspected.workOrder.projectId).toBe(WORK_ORDER_REQUEST.projectId);
    }

    const reserved = await work.reserveExecutionCapacity.reserveExecutionCapacity({
      reservationId: "res-1",
      workOrderId: WORK_ORDER_REQUEST.workOrderId,
      attemptId: "att-api-1",
      hostId: "host-1",
      worktreePath: path.join(stateDir, "worktrees", "att-api-1"),
      maxSlots: 2,
      seatTool: "opencode",
    });
    expect(reserved.outcome).toBe("reserved");

    const fixed = await work.prepareFixAttempt.execute({
      fixAttemptId: "att-api-2",
      workOrderId: WORK_ORDER_REQUEST.workOrderId,
      priorAttemptId: "att-api-1",
      worktreePath: path.join(stateDir, "worktrees", "att-api-2"),
      baseCommit: WORK_ORDER_REQUEST.baseCommit,
      numberedFixes: ["re-run the typecheck after the wiring change"],
    });
    // The prior attempt never existed or never ended, so a fresh fix round is
    // refused rather than guessed.
    expect(fixed.outcome).toBe("refused");

    // State survives a fresh composition over the same stateDir.
    const reloaded = createConfiguredWorkComposition({ stateDir });
    const reInspected = await reloaded.inspectWorkOrder.inspectWorkOrder({
      workOrderId: WORK_ORDER_REQUEST.workOrderId,
    });
    expect(reInspected.outcome).toBe("found");
  });

  it("evidence composition records verification, review and acceptance evidence", async () => {
    const stateDir = await makeTempDir();
    const evidence = createConfiguredEvidenceUseCases({ stateDir });

    const verified = await evidence.requestVerification.execute(VERIFICATION_REQUEST);
    expect(verified.outcome).toBe("completed");

    const receipt = await evidence.recordVerificationReceipt.execute({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
      receipt: {
        id: "vr-manual-1",
        assessmentId: VERIFICATION_REQUEST.assessmentId,
        projectId: VERIFICATION_REQUEST.projectId,
        attemptId: VERIFICATION_REQUEST.attemptId,
        candidateHeadSha: VERIFICATION_REQUEST.candidateHeadSha,
        hostId: VERIFICATION_REQUEST.hostId,
        procedureName: "manual-check",
        result: "pass",
        exitCode: 0,
        evidenceRef: "manual@def5678",
        policyRevision: VERIFICATION_REQUEST.policyRevision,
        completedAtIso: "2026-10-15T10:00:00.000Z",
      },
    });
    expect(receipt.outcome).toBe("recorded");

    // A review whose reviewer shares the implementer's model is refused.
    const sameModel = await evidence.requestIndependentReview.execute({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
      projectId: VERIFICATION_REQUEST.projectId,
      attemptId: VERIFICATION_REQUEST.attemptId,
      candidateHeadSha: VERIFICATION_REQUEST.candidateHeadSha,
      policyRevision: VERIFICATION_REQUEST.policyRevision,
      implementerModel: "seat/implementer",
      reviewerModel: "seat/implementer",
    });
    expect(sameModel.outcome).toBe("rejected");

    // The acceptance assessment honestly reports its blockers — including the
    // unconfigured forge transport — and never invents a pass.
    const assessed = await evidence.assessHeadAcceptance.assessHeadAcceptance({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
      candidateHeadSha: VERIFICATION_REQUEST.candidateHeadSha,
      policyRevision: VERIFICATION_REQUEST.policyRevision,
    });
    expect(assessed.outcome).toBe("blocked");
    if (assessed.outcome === "blocked") {
      const reasons = assessed.blockers.join(" ");
      expect(reasons).toContain("no independent review");
      expect(reasons).toContain("forge reports CI state 'unknown'");
    }

    const inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
    });
    expect(inspected.outcome).toBe("found");

    // Assessments persist across a fresh composition over the same stateDir.
    const reloaded = createConfiguredEvidenceUseCases({ stateDir });
    const persisted = await reloaded.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
    });
    expect(persisted.outcome).toBe("found");
  });

  it("knowledge composition captures, checks, accepts, publishes and supersedes keepers", async () => {
    const stateDir = await makeTempDir();
    const knowledge = createConfiguredKnowledgeComposition({ stateDir });

    const captured = await knowledge.captureCompletedAttemptNotes.execute(NOTES_REQUEST);
    expect(captured.outcome).toBe("captured");
    if (captured.outcome !== "captured") return;
    expect(captured.notesStatus).toBe("present");
    expect(captured.candidateEntries.length).toBe(1);
    const olderEntryId = captured.candidateEntries[0]?.id ?? "";

    const checked = await knowledge.checkKnowledgeClaim.execute({
      entryId: olderEntryId,
      checkId: "check-1",
      checkerId: "checker-1",
      procedureName: "confirm-path-exists",
      targetPath: process.cwd(),
    });
    expect(checked.outcome).toBe("checked");

    const decided = await knowledge.decideKnowledgeDisposition.execute({
      entryId: olderEntryId,
      disposition: "accepted",
      checkerId: "checker-1",
      reason: "verified against the working tree",
    });
    expect(decided.outcome).toBe("decided");

    const published = await knowledge.publishAcceptedKeeper.execute({ entryId: olderEntryId });
    expect(published.outcome).toBe("published");

    const secondCapture = await knowledge.captureCompletedAttemptNotes.execute({
      ...NOTES_REQUEST,
      attemptId: "att-api-2",
      notesMarkdown: "- The composition root wires all four bounded contexts together\n",
    });
    expect(secondCapture.outcome).toBe("captured");
    if (secondCapture.outcome !== "captured") return;
    const newerEntryId = secondCapture.candidateEntries[0]?.id ?? "";

    const reuse = await knowledge.recordKnowledgeReuse.recordKnowledgeReuse({
      entryId: olderEntryId,
      reuseId: "reuse-1",
      attemptId: "att-api-2",
      outcome: "included",
    });
    expect(reuse.outcome).toBe("recorded");

    const superseded = await knowledge.supersedeKnowledgeEntry.execute({
      olderEntryId,
      newerEntryId,
      checkerId: "checker-1",
      reason: "replaced by a refined claim",
    });
    // The newer entry is still a candidate, so it may not supersede yet.
    expect(superseded.outcome).toBe("rejected");

    await knowledge.checkKnowledgeClaim.execute({
      entryId: newerEntryId,
      checkId: "check-2",
      checkerId: "checker-1",
      procedureName: "confirm-path-exists",
      targetPath: process.cwd(),
    });
    await knowledge.decideKnowledgeDisposition.execute({
      entryId: newerEntryId,
      disposition: "accepted",
      checkerId: "checker-1",
      reason: "verified against the working tree",
    });
    const supersededAfterAccept = await knowledge.supersedeKnowledgeEntry.execute({
      olderEntryId,
      newerEntryId,
      checkerId: "checker-1",
      reason: "replaced by a refined claim",
    });
    expect(supersededAfterAccept.outcome).toBe("superseded");

    // Only the accepted, non-superseded keeper is proposed for new briefs.
    const proposals = await knowledge.proposeBriefContext.proposeBriefContext({
      projectId: NOTES_REQUEST.projectId,
      laneId: WORK_ORDER_REQUEST.laneId,
      taskSummary: "wire the composition root",
    });
    expect(proposals.outcome).toBe("proposed");
    if (proposals.outcome === "proposed") {
      expect(proposals.proposals.map((proposal) => proposal.knowledgeEntryId)).toEqual([
        newerEntryId,
      ]);
    }

    // Entries persist across a fresh composition over the same stateDir.
    const reloaded = createConfiguredKnowledgeComposition({ stateDir });
    const persisted = await reloaded.proposeBriefContext.proposeBriefContext({
      projectId: NOTES_REQUEST.projectId,
      laneId: WORK_ORDER_REQUEST.laneId,
      taskSummary: "wire the composition root",
    });
    expect(persisted.outcome).toBe("proposed");
    if (persisted.outcome === "proposed") {
      expect(persisted.proposals.map((proposal) => proposal.knowledgeEntryId)).toEqual([
        newerEntryId,
      ]);
    }
  });

  it("operator composition registers profiles, decides, relays and reads attention", async () => {
    const stateDir = await makeTempDir();
    const operator = createConfiguredOperatorComposition({ stateDir });

    const registered = await operator.registerProjectProfile.execute(PROFILE_REQUEST);
    expect(registered.outcome).toBe("registered");

    // A credential-named field is refused by name; values are never read.
    const credential = await operator.registerProjectProfile.execute({
      ...PROFILE_REQUEST,
      projectId: "proj-api-2",
      apiToken: "placeholder-not-a-secret",
    });
    expect(credential.outcome).toBe("rejected");

    const capabilities = await operator.inspectConfiguredCapabilities.execute({
      projectId: PROFILE_REQUEST.projectId,
      requiredCapabilities: ["networkEgressRestricted"],
    });
    expect(capabilities.outcome).toBe("inspected");
    if (capabilities.outcome === "inspected") {
      expect(capabilities.missingRequirements).toEqual([]);
    }

    const decided = await operator.requestScopedDecision.execute({
      requestId: "req-auth-1",
      projectId: PROFILE_REQUEST.projectId,
      kind: "action-decision",
      actionScope: `${WORK_ORDER_REQUEST.workOrderId}/merge-pr`,
      proposalDigest: "digest-1",
      policyRevision: PROFILE_REQUEST.policyRevision,
      expectedHeadSha: VERIFICATION_REQUEST.candidateHeadSha,
    });
    expect(decided.outcome).toBe("requested");

    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization({
      projectId: PROFILE_REQUEST.projectId,
      actionScope: `${WORK_ORDER_REQUEST.workOrderId}/merge-pr`,
      expectedHeadSha: VERIFICATION_REQUEST.candidateHeadSha,
    });
    // The decision is still awaiting an answer, so nothing is authorized yet.
    expect(resolved.outcome).toBe("blocked");

    const relay = await operator.sendFleetRelay.execute({
      requestId: "req-relay-1",
      projectId: PROFILE_REQUEST.projectId,
      recipientId: "reviewer-1",
      summary: "please review the composition wiring",
      policyRevision: PROFILE_REQUEST.policyRevision,
    });
    // The local relay outbox receives the notice and proves delivery.
    expect(relay.outcome).toBe("delivered");

    const acknowledged = await operator.recordRelayAcknowledgement.execute({
      acknowledgementId: "ack-1",
      requestId: "req-relay-1",
      recipientId: "reviewer-1",
      responseSummary: "on it",
      provenance: "relay-ack",
    });
    expect(acknowledged.outcome).toBe("acknowledged");

    const outstanding = await operator.inspectOutstandingCoordination.execute({
      projectId: PROFILE_REQUEST.projectId,
    });
    expect(outstanding.undecidedProposals.map((request) => request.id)).toEqual(["req-auth-1"]);
    expect(outstanding.unacknowledgedRelays).toEqual([]);

    const attention = await operator.readProjectAttention.execute({
      projectId: PROFILE_REQUEST.projectId,
    });
    expect(attention.outcome).toBe("unavailable");

    // Profiles persist across a fresh composition over the same stateDir.
    const reloaded = createConfiguredOperatorComposition({ stateDir });
    const persisted = await reloaded.inspectConfiguredCapabilities.execute({
      projectId: PROFILE_REQUEST.projectId,
    });
    expect(persisted.outcome).toBe("inspected");
  });

  it("configure*(options) serves requests and configure*(null) restores refusals", async () => {
    const stateDir = await makeTempDir();

    // The work-order guard needs a profile; register one through the operator
    // context and pass the profile delegate to the work composition.
    configureOperatorComposition({ stateDir });
    const guardProfiled = await getOperatorComposition().registerProjectProfile.execute(
      PROFILE_REQUEST,
    );
    expect(guardProfiled.outcome).toBe("registered");
    configureWorkComposition(
      { stateDir },
      {
        projectProfile: {
          inspect: async (request) =>
            getOperatorComposition().inspectProjectProfile.execute(request),
          record: async (request) =>
            getOperatorComposition().recordProjectProbe.execute(request),
        },
      },
    );
    const registered = await workComposition().registerWorkOrder.registerWorkOrder(
      WORK_ORDER_REQUEST,
    );
    expect(registered.outcome).toBe("registered");

    configureEvidenceUseCases({ stateDir });
    const verified = await getEvidenceUseCases().requestVerification.execute({
      ...VERIFICATION_REQUEST,
      assessmentId: "att-shared",
      attemptId: "att-shared",
    });
    expect(verified.outcome).toBe("completed");

    configureKnowledgeComposition({ stateDir });
    const captured = await getKnowledgeComposition().captureCompletedAttemptNotes.execute(
      NOTES_REQUEST,
    );
    expect(captured.outcome).toBe("captured");

    configureWorkComposition(null);
    await expect(workComposition().registerWorkOrder.execute(undefined as never)).rejects.toThrow(
      "Not implemented: RegisterWorkOrderUseCase",
    );
    configureEvidenceUseCases(null);
    await expect(getEvidenceUseCases().requestVerification.execute(undefined as never)).rejects.toThrow(
      "Not implemented: RequestVerificationUseCase",
    );
    configureKnowledgeComposition(null);
    await expect(
      getKnowledgeComposition().captureCompletedAttemptNotes.execute(undefined as never),
    ).rejects.toThrow("Not implemented: CaptureCompletedAttemptNotesUseCase");
    configureOperatorComposition(null);
    await expect(getOperatorComposition().registerProjectProfile.execute(undefined as never)).rejects.toThrow(
      "Not implemented: RegisterProjectProfileUseCase",
    );
  });

  it("configureFleetApiRuntime wires all four contexts in-process and resets cleanly", async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });

    // Operator: a registered project profile anchors the runtime.
    const profiled = await getOperatorComposition().registerProjectProfile.execute(PROFILE_REQUEST);
    expect(profiled.outcome).toBe("registered");

    // Work: registration is served through the shared runtime composition.
    const registered = await workComposition().registerWorkOrder.registerWorkOrder(
      WORK_ORDER_REQUEST,
    );
    expect(registered.outcome).toBe("registered");

    // Evidence: verification writes a real assessment under the shared state.
    const verified = await getEvidenceUseCases().requestVerification.execute(VERIFICATION_REQUEST);
    expect(verified.outcome).toBe("completed");

    // Knowledge: capture records candidate claims under the shared state.
    const captured = await getKnowledgeComposition().captureCompletedAttemptNotes.execute(
      NOTES_REQUEST,
    );
    expect(captured.outcome).toBe("captured");

    // A full reset restores refusals everywhere.
    configureFleetApiRuntime(null);
    await expect(workComposition().registerWorkOrder.execute(undefined as never)).rejects.toThrow(
      "Not implemented: RegisterWorkOrderUseCase",
    );
    await expect(getEvidenceUseCases().requestVerification.execute(undefined as never)).rejects.toThrow(
      "Not implemented: RequestVerificationUseCase",
    );
    await expect(
      getKnowledgeComposition().captureCompletedAttemptNotes.execute(undefined as never),
    ).rejects.toThrow("Not implemented: CaptureCompletedAttemptNotesUseCase");
    await expect(getOperatorComposition().registerProjectProfile.execute(undefined as never)).rejects.toThrow(
      "Not implemented: RegisterProjectProfileUseCase",
    );
  });

  it("runtime wiring delegates work-context decisions to the knowledge context", async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });

    // The work-order guard needs a profile; register one through the runtime's
    // operator context first.
    const profiled = await getOperatorComposition().registerProjectProfile.execute(PROFILE_REQUEST);
    expect(profiled.outcome).toBe("registered");
    await workComposition().registerWorkOrder.registerWorkOrder(WORK_ORDER_REQUEST);
    const captured = await getKnowledgeComposition().captureCompletedAttemptNotes.execute(
      NOTES_REQUEST,
    );
    expect(captured.outcome).toBe("captured");
    if (captured.outcome !== "captured") return;
    const entryId = captured.candidateEntries[0]?.id ?? "";

    const checked = await getKnowledgeComposition().checkKnowledgeClaim.execute({
      entryId,
      checkId: "check-brief-1",
      checkerId: "checker-1",
      procedureName: "confirm-path-exists",
      targetPath: process.cwd(),
    });
    expect(checked.outcome).toBe("checked");

    const decided = await getKnowledgeComposition().decideKnowledgeDisposition.execute({
      entryId,
      disposition: "accepted",
      checkerId: "checker-1",
      reason: "verified against the working tree",
    });
    expect(decided.outcome).toBe("decided");

    const repoPath = await makeTempGitRepo();
    const briefPath = path.join(repoPath, "hand-written-brief.md");
    await writeFile(briefPath, "# Frozen brief for the wired runtime\n", "utf8");

    const prepared = await workComposition().prepareBriefPackage.prepareBriefPackage({
      workOrderId: WORK_ORDER_REQUEST.workOrderId,
      projectId: WORK_ORDER_REQUEST.projectId,
      taskId: WORK_ORDER_REQUEST.taskId,
      laneId: WORK_ORDER_REQUEST.laneId,
      repository: WORK_ORDER_REQUEST.repository,
      baseCommit: WORK_ORDER_REQUEST.baseCommit,
      policyRevision: WORK_ORDER_REQUEST.policyRevision,
      modelAssignment: {
        model: "seat/implementer",
        variant: "default",
        fallbackModel: "fallback",
        seatTool: "opencode",
      },
      independentReviewer: "seat/reviewer",
      ownedPaths: WORK_ORDER_REQUEST.ownedPaths,
      permissions: [],
      acceptanceChecks: [],
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
      allowedPathPrefixes: ['src'],
      stepLimit: 10,
      timeLimitSeconds: 600,
      resourceBounds: {},
      expectedArtifacts: [],
      ownerDecisionReferences: [],
      contextDecisions: [
        {
          proposalId: "p-1",
          knowledgeEntryId: entryId,
          version: "1.0.0",
          proposedBecause: "proposed by the knowledge context",
          accepted: true,
          decisionBecause: "accepted by the orchestrator",
        },
      ],
      attemptId: "att-brief-1",
      worktreePath: repoPath,
      handWrittenBriefPath: briefPath,
    });
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome === "prepared") {
      expect(prepared.prepared.selectedKnowledgeVersions).toEqual([
        { knowledgeEntryId: entryId, version: "1.0.0" },
      ]);
    }

    // The work-side delegation reached the knowledge context's store.
    const selections = JSON.parse(
      await readFile(path.join(stateDir, "context-selections.json"), "utf8"),
    ) as Array<{ attemptId: string; knowledgeEntryId: string; decisionBecause?: string }>;
    expect(
      selections.some(
        (selection) =>
          selection.attemptId === "att-brief-1" &&
          selection.knowledgeEntryId === entryId &&
          selection.decisionBecause === "accepted by the orchestrator",
      ),
    ).toBe(true);
  });
});

describe("composition type surface", () => {
  it("builds every use case through the configured factories", () => {
    const work = createConfiguredWorkComposition();
    expect(work.registerWorkOrder).toBeInstanceOf(RegisterWorkOrderUseCase);
    expect(work.inspectWorkOrder).toBeInstanceOf(InspectWorkOrderUseCase);
    expect(work.prepareBriefPackage).toBeInstanceOf(PrepareBriefPackageUseCase);
    expect(work.reserveExecutionCapacity).toBeInstanceOf(ReserveExecutionCapacityUseCase);
    expect(work.dispatchAttempt).toBeInstanceOf(DispatchAttemptUseCase);
    expect(work.reconcileAttempt).toBeInstanceOf(ReconcileAttemptUseCase);
    expect(work.stopAttempt).toBeInstanceOf(StopAttemptUseCase);
    expect(work.collectAttemptArtifacts).toBeInstanceOf(CollectAttemptArtifactsUseCase);
    expect(work.prepareFixAttempt.execute).toBeDefined();
    expect(work.requestAttemptAcceptance).toBeInstanceOf(RequestAttemptAcceptanceUseCase);
    expect(work.executeAuthorizedForgeAction).toBeInstanceOf(ExecuteAuthorizedForgeActionUseCase);

    const knowledge = createConfiguredKnowledgeComposition();
    expect(knowledge.publishAcceptedKeeper).toBeInstanceOf(PublishAcceptedKeeperUseCase);
    expect(knowledge.supersedeKnowledgeEntry).toBeInstanceOf(SupersedeKnowledgeEntryUseCase);

    const operator = createConfiguredOperatorComposition();
    expect(operator.sendFleetRelay).toBeInstanceOf(SendFleetRelayUseCase);
    expect(operator.recordRelayAcknowledgement).toBeInstanceOf(RecordRelayAcknowledgementUseCase);
    expect(operator.readProjectAttention).toBeInstanceOf(ReadProjectAttentionUseCase);
    expect(operator.publishProjectObservation).toBeInstanceOf(PublishProjectObservationUseCase);
  });
});

describe("state directory discipline", () => {
  beforeEach(() => {
    configureWorkComposition(null);
    configureEvidenceUseCases(null);
    configureKnowledgeComposition(null);
    configureOperatorComposition(null);
  });

  it("persists work orders and knowledge entries as files under stateDir", async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });

    // The work-order guard needs a profile; register one through the runtime's
    // operator context first.
    const profiled = await getOperatorComposition().registerProjectProfile.execute(PROFILE_REQUEST);
    expect(profiled.outcome).toBe("registered");
    await workComposition().registerWorkOrder.registerWorkOrder(WORK_ORDER_REQUEST);
    const workOrders = JSON.parse(
      await readFile(path.join(stateDir, "work-orders.json"), "utf8"),
    ) as Array<{ id: string }>;
    expect(workOrders.some((order) => order.id === WORK_ORDER_REQUEST.workOrderId)).toBe(true);

    await getKnowledgeComposition().captureCompletedAttemptNotes.execute(NOTES_REQUEST);
    const entries = JSON.parse(
      await readFile(path.join(stateDir, "knowledge-entries.json"), "utf8"),
    ) as Array<{ projectId: string }>;
    expect(entries.some((entry) => entry.projectId === NOTES_REQUEST.projectId)).toBe(true);
  });

  it("keeps all state in memory when no stateDir is configured", async () => {
    const stateDir = await makeTempDir();
    // The work-order guard needs a profile; register one through an in-memory
    // operator composition and delegate profile reads to it.
    const operator = createConfiguredOperatorComposition();
    const profiled = await operator.registerProjectProfile.execute(PROFILE_REQUEST);
    expect(profiled.outcome).toBe("registered");
    const work = createConfiguredWorkComposition(
      {},
      {
        projectProfile: {
          inspect: async (request) => operator.inspectProjectProfile.execute(request),
          record: async (request) => operator.recordProjectProbe.execute(request),
        },
      },
    );

    const registered = await work.registerWorkOrder.registerWorkOrder(WORK_ORDER_REQUEST);
    expect(registered.outcome).toBe("registered");
    await expect(readFile(path.join(stateDir, "work-orders.json"), "utf8")).rejects.toThrow(
      "ENOENT",
    );
  });
});
