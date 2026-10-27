// Acceptance blocker kinds reach the API's acceptance delegate: evidence's
// blocked/stale/rejected results carry their kinds as data (A11). The API
// maps blocked -> rejected and stale/rejected -> unknown; reason strings are
// unchanged. All seeding runs over a temp state dir with a forge-mode-none
// installation so the forge is never read.
/**
 * Covers the API composition root's acceptance delegate mapping evidence
 * blocker kinds into the work side's AssessmentBlocker union. Assessments are
 * seeded through the evidence-and-acceptance adapters directly (the CLI's
 * write path), then the API runtime is configured over the same state dir.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { assessmentIdForAttempt } from "@fleet/evidence-and-acceptance";
import type { AcceptanceAssessmentPort } from "@fleet/work-execution";

import { createConfiguredEvidenceUseCases } from "../evidence/composition";
import { configureFleetApiRuntime } from "../runtime";
import { workComposition } from "../work/composition";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const BASE_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ATTEMPT_ID = "a1";
const MISSING_ATTEMPT_ID = "a-missing";
const PROJECT_ID = "proj-blocker-kinds";
const POLICY_REVISION = "policy-1";
const IMPLEMENTER_MODEL = "seat/implementer";

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-acceptance-blockers-"));
  createdDirs.add(directory);
  return directory;
}

/** A minimal v2 installation: forge mode none, receipt-only acceptance. */
function makeInstallation() {
  return { schemaVersion: 2, forge: { mode: "none" } } as const;
}

/** The collected attempt whose recorded seat implemented HEAD_SHA. */
function makeAttempt(attemptId = ATTEMPT_ID) {
  return {
    id: attemptId,
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

/**
 * Stores a verified-but-unreviewed acceptance assessment under the given
 * assessment id using the evidence-and-acceptance adapters directly, with no
 * owner-decision doors recorded. No review receipt is recorded, so assessing
 * blocks on a missing independent review.
 */
async function storeVerifiedAssessment(stateDir: string, assessmentId: string) {
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
      id: `vr-${assessmentId}-1`,
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
}

describe("acceptance blocker kinds via the API delegate", () => {
  it("maps a missing review to a review-missing blocker (blocked -> rejected)", async () => {
    const stateDir = await makeTempDir();
    await storeVerifiedAssessment(stateDir, assessmentIdForAttempt(ATTEMPT_ID));
    await writeFile(
      join(stateDir, "attempts.json"),
      `${JSON.stringify([makeAttempt()], null, 2)}\n`,
      "utf8",
    );

    configureFleetApiRuntime({ stateDir, installation: makeInstallation() });
    try {
      const work = workComposition();
      const acceptancePort = (work.requestAttemptAcceptance as unknown as {
        deps: { acceptancePort: AcceptanceAssessmentPort };
      }).deps.acceptancePort;

      const assessed = await acceptancePort.assessHeadAcceptance({
        attemptId: ATTEMPT_ID,
        workOrderId: "wo-1",
        candidateHeadSha: HEAD_SHA,
        policyRevision: POLICY_REVISION,
      });
      expect(assessed).toEqual({
        outcome: "rejected",
        reason: "no independent review was recorded for this candidate head",
        blockerDetails: [
          {
            kind: "review-missing",
            text: "no independent review was recorded for this candidate head",
          },
        ],
      });
    } finally {
      configureFleetApiRuntime(null);
    }
  });

  it("maps a moved candidate head to a stale blocker (stale -> unknown)", async () => {
    const stateDir = await makeTempDir();
    await storeVerifiedAssessment(stateDir, assessmentIdForAttempt(ATTEMPT_ID));
    await writeFile(
      join(stateDir, "attempts.json"),
      `${JSON.stringify([makeAttempt()], null, 2)}\n`,
      "utf8",
    );

    configureFleetApiRuntime({ stateDir, installation: makeInstallation() });
    try {
      const work = workComposition();
      const acceptancePort = (work.requestAttemptAcceptance as unknown as {
        deps: { acceptancePort: AcceptanceAssessmentPort };
      }).deps.acceptancePort;

      const assessed = await acceptancePort.assessHeadAcceptance({
        attemptId: ATTEMPT_ID,
        workOrderId: "wo-1",
        candidateHeadSha: OTHER_SHA,
        policyRevision: POLICY_REVISION,
      });
      expect(assessed.outcome).toBe("unknown");
      if (assessed.outcome === "unknown") {
        expect(assessed.blockerDetails).toEqual([
          { kind: "stale", text: "Candidate head or policy revision changed" },
        ]);
      }
    } finally {
      configureFleetApiRuntime(null);
    }
  });

  it("maps a missing assessment to an other blocker (rejected -> unknown)", async () => {
    const stateDir = await makeTempDir();
    await writeFile(
      join(stateDir, "attempts.json"),
      `${JSON.stringify([makeAttempt(MISSING_ATTEMPT_ID)], null, 2)}\n`,
      "utf8",
    );

    configureFleetApiRuntime({ stateDir, installation: makeInstallation() });
    try {
      const work = workComposition();
      const acceptancePort = (work.requestAttemptAcceptance as unknown as {
        deps: { acceptancePort: AcceptanceAssessmentPort };
      }).deps.acceptancePort;

      const assessed = await acceptancePort.assessHeadAcceptance({
        attemptId: MISSING_ATTEMPT_ID,
        workOrderId: "wo-1",
        candidateHeadSha: HEAD_SHA,
        policyRevision: POLICY_REVISION,
      });
      expect(assessed).toEqual({
        outcome: "unknown",
        reason: "Assessment not found",
        blockerDetails: [{ kind: "other", text: "Assessment not found" }],
      });
    } finally {
      configureFleetApiRuntime(null);
    }
  });
});
