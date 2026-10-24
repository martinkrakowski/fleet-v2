// L9 (finding M17): the CLI and the API must address the same acceptance
// assessment for an attempt. The CLI writes under `assessment-<attemptId>`
// (assessmentIdForAttempt); the API's acceptance read and assess delegates
// must resolve that same assessment over the same state dir.
/**
 * Stores an accepted acceptance assessment under the shared prefixed id using
 * the evidence-and-acceptance adapters directly (the CLI's write path), then
 * builds the API runtime over the same temp state dir and proves both the
 * runtime's acceptance read delegate and its assess delegate find the same
 * assessment, not "Assessment not found".
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { assessmentIdForAttempt } from "@fleet/evidence-and-acceptance";
import type { AcceptanceAssessmentPort } from "@fleet/work-execution";
import type { AcceptanceEvidencePort } from "@fleet/work-execution";

import { createConfiguredEvidenceUseCases } from "../evidence/composition";
import { configureFleetApiRuntime } from "../runtime";
import { workComposition } from "../work/composition";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ATTEMPT_ID = "a1";
const PROJECT_ID = "proj-cross-root";
const POLICY_REVISION = "policy-1";
const IMPLEMENTER_MODEL = "seat/implementer";
const REVIEWER_MODEL = "openrouter/anthropic/claude-sonnet-4.5";

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-assessment-id-cross-root-"));
  createdDirs.add(directory);
  return directory;
}

/** A minimal v2 installation: forge mode none, receipt-only acceptance. */
function makeInstallation() {
  return { schemaVersion: 2, forge: { mode: "none" } } as const;
}

/** The collected attempt whose recorded seat implemented HEAD_SHA. */
function makeAttempt() {
  return {
    id: ATTEMPT_ID,
    ownerDecisionReferences: [],
    workOrderId: "wo-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/tmp/opencode/lanes/a1",
    baseCommit: BASE_COMMIT,
    state: "collected",
    outcome: "done",
    briefDigest: "digest-1",
    briefPackagePath: null,
    sessionId: "session-1",
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [HEAD_SHA],
      collectedArtifactPaths: [],
      notes: "present",
    },
    runner: {
      kind: "opencode",
      remotePort: 4166,
      host: null,
      agent: null,
      model: IMPLEMENTER_MODEL,
      variant: null,
    },
    createdAtIso: "2026-10-15T07:00:00.000Z",
    updatedAtIso: "2026-10-15T07:30:00.000Z",
  };
}

describe("assessment id cross-root (L9 M17)", () => {
  it("assessmentIdForAttempt prefixes the attempt id", () => {
    expect(assessmentIdForAttempt("a1")).toBe("assessment-a1");
  });

  it("the API runtime's acceptance read and assess delegates find a CLI-written assessment", async () => {
    const stateDir = await makeTempDir();
    const assessmentId = assessmentIdForAttempt(ATTEMPT_ID);

    // --- store the acceptance assessment as the CLI does ---
    // The evidence-and-acceptance adapters are used directly (the api package
    // cannot import the CLI); the owner-decision delegate records no doors so
    // the assessment can be carried all the way to acceptance.
    const evidence = createConfiguredEvidenceUseCases(
      { stateDir, installation: makeInstallation() },
      {
        attemptOwnerDecision: {
          readAttemptOwnerDecisionReferences: async () => ({
            outcome: "recorded",
            ownerDecisionReferences: [],
          }),
        },
      },
    );

    const verified = await evidence.requestVerification.execute({
      assessmentId,
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
      candidateHeadSha: HEAD_SHA,
      policyRevision: POLICY_REVISION,
      hostId: "host-1",
      implementerModel: IMPLEMENTER_MODEL,
      requiredChecks: ["typecheck"],
    });
    expect(verified.outcome).toBe("completed");

    const verificationReceipt = await evidence.recordVerificationReceipt.execute({
      assessmentId,
      receipt: {
        id: "vr-cross-root-1",
        assessmentId,
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD_SHA,
        hostId: "host-1",
        procedureName: "typecheck",
        result: "pass",
        exitCode: 0,
        evidenceRef: `seed@${HEAD_SHA}`,
        policyRevision: POLICY_REVISION,
        completedAtIso: "2026-10-15T08:00:00.000Z",
      },
    });
    expect(verificationReceipt.outcome).toBe("recorded");

    const reviewReceipt = await evidence.recordReviewReceipt.execute({
      assessmentId,
      receipt: {
        id: "rr-cross-root-1",
        assessmentId,
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD_SHA,
        reviewerModel: REVIEWER_MODEL,
        implementerModel: IMPLEMENTER_MODEL,
        readOnlyVerified: true,
        result: "pass",
        findings: [],
        evidenceRef: `review-seed@${HEAD_SHA}`,
        policyRevision: POLICY_REVISION,
        completedAtIso: "2026-10-15T08:05:00.000Z",
      },
    });
    expect(reviewReceipt.outcome).toBe("recorded");

    const stored = await evidence.assessHeadAcceptance.assessHeadAcceptance({
      assessmentId,
      candidateHeadSha: HEAD_SHA,
      policyRevision: POLICY_REVISION,
    });
    expect(stored.outcome).toBe("accepted");
    expect(stored.outcome === "accepted" && stored.candidateHeadSha).toBe(HEAD_SHA);

    // The attempt exists in the work context so the runtime's owner-decision
    // door check can see its (empty) frozen doors.
    await writeFile(join(stateDir, "attempts.json"), `${JSON.stringify([makeAttempt()], null, 2)}\n`, "utf8");

    // --- the API runtime over the same state dir ---
    configureFleetApiRuntime({ stateDir });
    try {
      const work = workComposition();

      // The API's acceptance read delegate (the merge gate's read).
      const acceptanceEvidencePort = (work.executeAuthorizedForgeAction as unknown as {
        deps: { acceptanceEvidencePort: AcceptanceEvidencePort };
      }).deps.acceptanceEvidencePort;
      const read = await acceptanceEvidencePort.readAcceptance({
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD_SHA,
      });
      expect(read.outcome).toBe("found");
      if (read.outcome === "found") {
        expect(read.assessment.candidateHeadSha).toBe(HEAD_SHA);
        expect(read.assessment.policyRevision).toBe(POLICY_REVISION);
        expect(read.assessment.state).toBe("accepted");
        expect(read.assessment.acceptanceReceiptId).toBe(
          stored.outcome === "accepted" ? stored.receiptId : null,
        );
      }

      // The API's acceptance assess delegate (the acceptance station's assess).
      const acceptancePort = (work.requestAttemptAcceptance as unknown as {
        deps: { acceptancePort: AcceptanceAssessmentPort };
      }).deps.acceptancePort;
      const assessed = await acceptancePort.assessHeadAcceptance({
        attemptId: ATTEMPT_ID,
        workOrderId: "wo-1",
        candidateHeadSha: HEAD_SHA,
        policyRevision: POLICY_REVISION,
      });
      expect(assessed.outcome).toBe("accepted");
      if (assessed.outcome === "accepted") {
        expect(assessed.assessedHeadSha).toBe(HEAD_SHA);
        expect(assessed.receiptId).toBe(stored.outcome === "accepted" ? stored.receiptId : "");
      }
    } finally {
      configureFleetApiRuntime(null);
    }
  });
});
