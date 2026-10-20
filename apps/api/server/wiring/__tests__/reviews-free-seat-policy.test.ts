// Free-seat flag (F5) wired into the evidence composition: with
// `policy.useFreeSeats: false`, request-review refuses a free reviewer
// before any assessment lookup; a paid reviewer passes the policy and
// reaches the repository.
import { describe, expect, it } from "vitest";

import type { FleetInstallation } from "@fleet/installation";

import { createConfiguredEvidenceUseCases } from "../evidence/composition";

const HEAD = "def5678";

const FREE_SEAT_TEST_INSTALLATION = {
  schemaVersion: 2,
  seats: [
    {
      id: "free-rev",
      tool: "opencode",
      model: "opencode/minimax-m3.1-flash-free",
      roles: ["reviewer"],
      costClass: "free",
    },
    {
      id: "paid-rev",
      tool: "opencode",
      model: "openrouter/openai/gpt-6-luna",
      roles: ["reviewer"],
      costClass: "paid",
    },
  ],
  policy: { useFreeSeats: false },
} as FleetInstallation;

function requestIndependentReview(reviewerModel: string) {
  return {
    assessmentId: "att-free-seat",
    projectId: "proj-free-seat-1",
    attemptId: "att-free-seat-1",
    candidateHeadSha: HEAD,
    policyRevision: "policy-1",
    implementerModel: "nvidia/z-ai/glm-5.3",
    reviewerModel,
  };
}

/** Seed an assessment for the free-seat fixture through the real wiring. */
function requestVerification(assessmentId: string, attemptId: string) {
  return {
    assessmentId,
    projectId: "proj-free-seat-1",
    attemptId,
    candidateHeadSha: HEAD,
    policyRevision: "policy-1",
    hostId: "host-1",
    implementerModel: "nvidia/z-ai/glm-5.3",
    requiredChecks: ["typecheck"],
  };
}

function reviewReceipt(assessmentId: string, reviewerModel: string) {
  return {
    id: `rr-${assessmentId}-1`,
    assessmentId,
    projectId: "proj-free-seat-1",
    attemptId: "att-free-seat-1",
    candidateHeadSha: HEAD,
    reviewerModel,
    implementerModel: "nvidia/z-ai/glm-5.3",
    readOnlyVerified: true,
    result: "pass",
    findings: [],
    evidenceRef: "evidence://review-free-seat",
    policyRevision: "policy-1",
    completedAtIso: "2026-10-16T08:00:00.000Z",
  };
}

describe("evidence composition free-seat policy (FS3b)", () => {
  it("refuses a free reviewer before the assessment lookup when the flag is false", async () => {
    const evidence = createConfiguredEvidenceUseCases({
      installation: FREE_SEAT_TEST_INSTALLATION,
    });

    const result = await evidence.requestIndependentReview.requestIndependentReview(
      requestIndependentReview("opencode/minimax-m3.1-flash-free"),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("policy.useFreeSeats is false");
    }
  });

  it("lets a paid reviewer through the policy to the missing-assessment rejection", async () => {
    const evidence = createConfiguredEvidenceUseCases({
      installation: FREE_SEAT_TEST_INSTALLATION,
    });

    const result = await evidence.requestIndependentReview.requestIndependentReview(
      requestIndependentReview("openrouter/openai/gpt-6-luna"),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("No assessment exists");
    }
  });

  it("keeps today's behaviour when the flag is absent", async () => {
    const evidence = createConfiguredEvidenceUseCases({
      installation: {
        ...FREE_SEAT_TEST_INSTALLATION,
        policy: {},
      } as FleetInstallation,
    });

    const result = await evidence.requestIndependentReview.requestIndependentReview(
      requestIndependentReview("opencode/minimax-m3.1-flash-free"),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("No assessment exists");
    }
  });

  it("refuses a review receipt naming a free reviewer when the flag is false", async () => {
    const evidence = createConfiguredEvidenceUseCases({
      installation: FREE_SEAT_TEST_INSTALLATION,
    });

    const verification = await evidence.requestVerification.execute(
      requestVerification("att-free-seat", "att-free-seat-1"),
    );
    expect(verification.outcome).toBe("completed");

    const result = await evidence.recordReviewReceipt.execute({
      assessmentId: "att-free-seat",
      receipt: reviewReceipt("att-free-seat", "opencode/minimax-m3.1-flash-free"),
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("policy.useFreeSeats is false");
    }
  });

  it("refuses a receipt naming a different reviewer than the request", async () => {
    const evidence = createConfiguredEvidenceUseCases({
      installation: FREE_SEAT_TEST_INSTALLATION,
    });

    await evidence.requestVerification.execute(
      requestVerification("att-free-seat", "att-free-seat-1"),
    );

    // Name a paid reviewer at request time; no review transport is configured,
    // so the request records the requested reviewer and returns the
    // unavailable rejection.
    const requested = await evidence.requestIndependentReview.requestIndependentReview(
      requestIndependentReview("openrouter/openai/gpt-6-luna"),
    );
    expect(requested.outcome).toBe("rejected");

    const result = await evidence.recordReviewReceipt.execute({
      assessmentId: "att-free-seat",
      receipt: reviewReceipt("att-free-seat", "openrouter/anthropic/claude-sonnet-4.5"),
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("requested reviewer 'openrouter/openai/gpt-6-luna'");
    }
  });
});
