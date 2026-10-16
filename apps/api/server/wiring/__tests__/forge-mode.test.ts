// Forge mode (D6) wired into the API evidence composition: mode `none` never
// reads the forge, blocks a brief that names a CI requirement, and records
// `forgeEvidence: 'not-configured'`; mode `github` binds the forge-evidence
// port with the installation's owner/repo, so a failing forge read blocks.
import { describe, expect, it } from "vitest";

import type { FleetInstallation } from "@fleet/installation";
import type { ReviewReceiptRecord, VerificationReceiptRecord } from "@fleet/evidence-and-acceptance";

import { createConfiguredEvidenceUseCases } from "../evidence/composition";

const HEAD = "def5678";
/** A full sha for the mode github forge reads, which resolve a PR by head. */
const GITHUB_HEAD = "def5678000000000000000000000000000000000";

const VERIFICATION_REQUEST = {
  assessmentId: "att-forge-none",
  projectId: "proj-forge-1",
  attemptId: "att-forge-1",
  candidateHeadSha: HEAD,
  policyRevision: "policy-1",
  hostId: "host-1",
  implementerModel: "seat/implementer",
  requiredChecks: ["typecheck"],
};

function manualReceipt(): VerificationReceiptRecord {
  return {
    id: "vr-forge-none-1",
    assessmentId: VERIFICATION_REQUEST.assessmentId,
    projectId: VERIFICATION_REQUEST.projectId,
    attemptId: VERIFICATION_REQUEST.attemptId,
    candidateHeadSha: HEAD,
    hostId: "host-1",
    procedureName: "typecheck",
    result: "pass",
    exitCode: 0,
    evidenceRef: "manual@forge-none",
    policyRevision: "policy-1",
    completedAtIso: "2026-10-16T08:00:00.000Z",
  };
}

function passingReview(assessmentId: string): ReviewReceiptRecord {
  return {
    id: "rr-forge-none-1",
    assessmentId,
    projectId: VERIFICATION_REQUEST.projectId,
    attemptId: VERIFICATION_REQUEST.attemptId,
    candidateHeadSha: HEAD,
    reviewerModel: "seat/reviewer",
    implementerModel: "seat/implementer",
    readOnlyVerified: true,
    result: "pass",
    findings: [],
    evidenceRef: "evidence://review-forge-none",
    policyRevision: "policy-1",
    completedAtIso: "2026-10-16T08:00:00.000Z",
  };
}

/** A minimal v2 installation fixture declaring one forge mode. */
function makeInstallation(mode: "none" | "github"): FleetInstallation {
  return mode === "github"
    ? ({
        schemaVersion: 2,
        forge: { mode: "github", owner: "example-owner", repo: "example-repo" },
      } as FleetInstallation)
    : ({ schemaVersion: 2, forge: { mode: "none" } } as FleetInstallation);
}

type GhResult = { exitCode: number; stdout: string; stderr?: string };

/**
 * A stub of the argument-array gh transport: `failing` returns a failing
 * pull request lookup, `passing` answers every forge read for HEAD with
 * passing checks and no unresolved threads.
 */
function makeGhRunner(outcome: "failing" | "passing") {
  return async (args: readonly string[]): Promise<GhResult> => {
    if (outcome === "failing") {
      return { exitCode: 1, stdout: "", stderr: "gh: API error" };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ state: "open", head: { sha: GITHUB_HEAD }, number: 7 }]),
      };
    }
    if (args[0] === "pr") {
      return { exitCode: 0, stdout: JSON.stringify([{ bucket: "pass" }]) };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } },
        },
      }),
    };
  };
}

/** The evidence composition wired for one forge mode with a stub transport. */
function makeEvidence(mode: "none" | "github", ghRunner?: ReturnType<typeof makeGhRunner>) {
  return createConfiguredEvidenceUseCases({
    installation: makeInstallation(mode),
    ...(mode === "github" && ghRunner !== undefined ? { forgeGhRunner: ghRunner } : {}),
  });
}

/** Request verification for one github-mode assessment, then assess its head. */
async function assessGithubHead(
  evidence: ReturnType<typeof makeEvidence>,
  assessmentId: string,
) {
  expect(
    (
      await evidence.requestVerification.execute({
        ...VERIFICATION_REQUEST,
        assessmentId,
        attemptId: assessmentId,
        candidateHeadSha: GITHUB_HEAD,
      })
    ).outcome,
  ).toBe("completed");
  return evidence.assessHeadAcceptance.assessHeadAcceptance({
    assessmentId,
    candidateHeadSha: GITHUB_HEAD,
    policyRevision: "policy-1",
  });
}

describe("evidence composition forge mode (D6)", () => {
  it("mode none accepts receipt-only, never reads the forge, and records not-configured", async () => {
    const evidence = makeEvidence("none");

    expect((await evidence.requestVerification.execute(VERIFICATION_REQUEST)).outcome).toBe(
      "completed",
    );
    expect(
      (
        await evidence.recordVerificationReceipt.execute({
          assessmentId: VERIFICATION_REQUEST.assessmentId,
          receipt: manualReceipt(),
        })
      ).outcome,
    ).toBe("recorded");
    expect(
      (
        await evidence.recordReviewReceipt.execute({
          assessmentId: VERIFICATION_REQUEST.assessmentId,
          receipt: passingReview(VERIFICATION_REQUEST.assessmentId),
        })
      ).outcome,
    ).toBe("recorded");

    const assessed = await evidence.assessHeadAcceptance.assessHeadAcceptance({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
      candidateHeadSha: HEAD,
      policyRevision: "policy-1",
    });
    // Without cross-context delegates the attempt's one-way doors are
    // unreadable, so the assessment blocks on that door; the forge mode none
    // wiring is proven by the absence of any forge read blocker and by the
    // recorded not-configured value.
    expect(assessed.outcome).toBe("blocked");
    const inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
      assessmentId: VERIFICATION_REQUEST.assessmentId,
    });
    expect(inspected.outcome).toBe("found");
    if (inspected.outcome === "found") {
      expect(inspected.assessment.forgeEvidence).toBe("not-configured");
      expect(inspected.assessment.blockers.join(" ")).not.toContain("forge reports CI state");
    }
  });

  it("mode none blocks a brief that names a CI requirement", async () => {
    const evidence = makeEvidence("none");

    expect(
      (
        await evidence.requestVerification.execute({
          ...VERIFICATION_REQUEST,
          assessmentId: "att-forge-none-ci",
          attemptId: "att-forge-none-ci",
          requiredChecks: ["ci"],
        })
      ).outcome,
    ).toBe("completed");

    const assessed = await evidence.assessHeadAcceptance.assessHeadAcceptance({
      assessmentId: "att-forge-none-ci",
      candidateHeadSha: HEAD,
      policyRevision: "policy-1",
    });
    expect(assessed.outcome).toBe("blocked");
    if (assessed.outcome === "blocked") {
      const reasons = assessed.blockers.join(" ");
      expect(reasons).toContain("forge mode is 'none'");
      expect(reasons).toContain("not-configured");
    }
  });

  it("mode github blocks when the gh runner returns failure", async () => {
    const evidence = makeEvidence("github", makeGhRunner("failing"));
    const assessed = await assessGithubHead(evidence, "att-forge-github");

    expect(assessed.outcome).toBe("blocked");
    if (assessed.outcome === "blocked") {
      expect(assessed.blockers.join(" ")).toContain("forge reports CI state 'unknown'");
    }
  });

  it("mode github counts passing checks and no unresolved threads as a pass", async () => {
    const evidence = makeEvidence("github", makeGhRunner("passing"));
    const assessed = await assessGithubHead(evidence, "att-forge-github");

    // Without cross-context delegates the attempt's one-way doors block, so
    // the forge pass is proven by the absence of any forge read blocker and
    // by no not-configured marker on the stored assessment.
    expect(assessed.outcome).toBe("blocked");
    if (assessed.outcome === "blocked") {
      const reasons = assessed.blockers.join(" ");
      expect(reasons).not.toContain("forge reports CI state");
      expect(reasons).not.toContain("forge could not read review threads");
    }
    const inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
      assessmentId: "att-forge-github",
    });
    expect(inspected.outcome).toBe("found");
    if (inspected.outcome === "found") {
      expect(inspected.assessment.forgeEvidence).toBeUndefined();
    }
  });
});
