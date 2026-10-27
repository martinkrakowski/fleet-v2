import { describe, expect, it } from "vitest";
import { parseEvidenceEnvelope } from "./map-evidence";

const HEAD = "a".repeat(40);

const ASSESSMENT = {
  id: "ev_live_1",
  projectId: "proj-live",
  attemptId: "att_live_1",
  candidateHeadSha: HEAD,
  policyRevision: "policy-3",
  implementerModel: "model-impl",
  requestedReviewerModel: "model-review",
  requiredChecks: ["verify-build", "verify-test"],
  state: "accepted",
  forgeEvidence: "not-configured",
  verificationReceipts: [
    {
      id: "vr_live_1",
      assessmentId: "ev_live_1",
      projectId: "proj-live",
      attemptId: "att_live_1",
      candidateHeadSha: HEAD,
      hostId: "host-a",
      procedureName: "verify-build",
      result: "pass",
      exitCode: 0,
      coverage: { ran: true, unitKind: "checks", units: 3 },
      evidenceRef: "ref-a",
      policyRevision: "policy-3",
      completedAtIso: "2026-10-24T10:10:00Z",
    },
  ],
  reviewReceipts: [
    {
      id: "rr_live_1",
      assessmentId: "ev_live_1",
      projectId: "proj-live",
      attemptId: "att_live_1",
      candidateHeadSha: HEAD,
      reviewerModel: "model-review",
      implementerModel: "model-impl",
      readOnlyVerified: true,
      result: "pass",
      findings: [
        {
          findingId: "f_live_1",
          severity: "minor",
          summary: "<img src=x onerror=alert(1)>",
          filePath: "src/x.ts",
          line: 3,
          state: "fixed",
          dispositionReason: "fixed",
          dispositionEvidenceRef: "ref-b",
        },
      ],
      evidenceRef: "ref-c",
      policyRevision: "policy-3",
      completedAtIso: "2026-10-24T10:20:00Z",
      kind: "security",
    },
    {
      id: "rr_live_2",
      assessmentId: "ev_live_1",
      projectId: "proj-live",
      attemptId: "att_live_1",
      candidateHeadSha: HEAD,
      reviewerModel: "model-review",
      implementerModel: "model-impl",
      readOnlyVerified: false,
      result: "pending",
      findings: [],
      evidenceRef: "ref-d",
      policyRevision: "policy-3",
      completedAtIso: "2026-10-24T10:25:00Z",
    },
  ],
  findingDispositions: [
    {
      id: "fd_live_1",
      assessmentId: "ev_live_1",
      findingId: "f_live_1",
      candidateHeadSha: HEAD,
      state: "fixed",
      reason: "fix applied",
      evidenceRef: "ref-e",
      recordedBy: "model-impl",
      recordedAtIso: "2026-10-24T10:30:00Z",
    },
  ],
  acceptanceReceiptId: "acc_live_1",
  blockers: [],
  revision: 2,
  updatedAtIso: "2026-10-24T10:35:00Z",
};

const EXPECTED_EVIDENCE = {
  assessmentId: "ev_live_1",
  candidateHeadSha: HEAD,
  state: "accepted",
  revision: 2,
  updatedAtIso: "2026-10-24T10:35:00Z",
  policyRevision: "policy-3",
  implementerModel: "model-impl",
  requestedReviewerModel: "model-review",
  requiredChecks: ["verify-build", "verify-test"],
  blockers: [],
  acceptanceReceiptId: "acc_live_1",
  verifications: [
    {
      id: "vr_live_1",
      procedureName: "verify-build",
      result: "pass",
      exitCode: 0,
      coverage: { ran: true, unitKind: "checks", units: 3 },
      completedAtIso: "2026-10-24T10:10:00Z",
    },
  ],
  reviews: [
    {
      id: "rr_live_1",
      reviewerModel: "model-review",
      implementerModel: "model-impl",
      readOnlyVerified: true,
      result: "pass",
      kind: "security",
      findings: [
        {
          findingId: "f_live_1",
          severity: "minor",
          summary: "<img src=x onerror=alert(1)>",
          state: "fixed",
        },
      ],
      completedAtIso: "2026-10-24T10:20:00Z",
    },
    {
      id: "rr_live_2",
      reviewerModel: "model-review",
      implementerModel: "model-impl",
      readOnlyVerified: false,
      result: "pending",
      kind: null,
      findings: [],
      completedAtIso: "2026-10-24T10:25:00Z",
    },
  ],
  dispositions: [
    {
      id: "fd_live_1",
      findingId: "f_live_1",
      state: "fixed",
      reason: "fix applied",
      recordedBy: "model-impl",
      recordedAtIso: "2026-10-24T10:30:00Z",
    },
  ],
  reviewTally: { pass: 1, fail: 0, unknown: 0, disagreement: false },
};

function foundEnvelope(
  overrides: Record<string, unknown> = {},
  assessment: Record<string, unknown> = ASSESSMENT,
): { code: string; result: Record<string, unknown> } {
  return {
    code: "OK",
    result: {
      outcome: "found",
      assessment,
      reviewTally: { pass: 1, fail: 0, unknown: 0, disagreement: false },
      ...overrides,
    },
  };
}

describe("parseEvidenceEnvelope", () => {
  it("parses a full found envelope, dropping provenance and location fields", () => {
    const parsed = parseEvidenceEnvelope(foundEnvelope());
    expect(parsed).toEqual({ outcome: "found", evidence: EXPECTED_EVIDENCE });
    expect(parsed?.outcome === "found").toBe(true);
    if (parsed?.outcome === "found") {
      expect(parsed.evidence.reviews[0].findings[0].summary).toBe(
        "<img src=x onerror=alert(1)>",
      );
      expect(parsed.evidence.reviews[1].kind).toBeNull();
      const json = JSON.stringify(parsed.evidence);
      expect(json).not.toContain("host-a");
      expect(json).not.toContain("ref-a");
      expect(json).not.toContain("filePath");
    }
  });

  it("parses a not-found envelope", () => {
    expect(
      parseEvidenceEnvelope({
        code: "OK",
        result: { outcome: "not-found", query: "head not assessed" },
      }),
    ).toEqual({ outcome: "not-found" });
  });

  it("keeps a served review kind and defaults an absent one to null", () => {
    const withKind = parseEvidenceEnvelope(foundEnvelope());
    expect(withKind?.outcome === "found" && withKind.evidence.reviews[0].kind).toBe(
      "security",
    );
    const withoutKindAssessment = {
      ...ASSESSMENT,
      reviewReceipts: [ASSESSMENT.reviewReceipts[1]],
    };
    const withoutKind = parseEvidenceEnvelope(foundEnvelope({}, withoutKindAssessment));
    expect(
      withoutKind?.outcome === "found" && withoutKind.evidence.reviews[0].kind,
    ).toBeNull();
  });

  it("keeps a served review tally and defaults an absent one to null", () => {
    const withTally = parseEvidenceEnvelope(foundEnvelope());
    expect(withTally?.outcome === "found").toBe(true);
    if (withTally?.outcome === "found") {
      expect(withTally.evidence.reviewTally).toEqual({
        pass: 1,
        fail: 0,
        unknown: 0,
        disagreement: false,
      });
    }
    const absent = parseEvidenceEnvelope(
      foundEnvelope({ reviewTally: undefined }),
    );
    expect(absent?.outcome === "found").toBe(true);
    if (absent?.outcome === "found") {
      expect(absent.evidence.reviewTally).toBeNull();
    }
    expect(
      parseEvidenceEnvelope(
        foundEnvelope({
          reviewTally: { pass: -1, fail: 0, unknown: 0, disagreement: false },
        }),
      ),
    ).toBeNull();
  });

  it("refuses a result word outside the enum", () => {
    const badVerification = {
      ...ASSESSMENT.verificationReceipts[0],
      result: "passed",
    };
    expect(
      parseEvidenceEnvelope(
        foundEnvelope({}, {
          ...ASSESSMENT,
          verificationReceipts: [badVerification],
        }),
      ),
    ).toBeNull();
  });

  it("refuses coverage with an unknown unit kind", () => {
    const badCoverage = {
      ...ASSESSMENT.verificationReceipts[0],
      coverage: { ran: true, unitKind: "lines", units: 3 },
    };
    expect(
      parseEvidenceEnvelope(
        foundEnvelope({}, {
          ...ASSESSMENT,
          verificationReceipts: [badCoverage],
        }),
      ),
    ).toBeNull();
  });

  it("returns null for a non-OK code", () => {
    expect(
      parseEvidenceEnvelope({ code: "NOT_IMPLEMENTED", result: null }),
    ).toBeNull();
  });
});
