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
});
