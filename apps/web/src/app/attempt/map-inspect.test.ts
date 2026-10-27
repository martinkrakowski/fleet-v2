import { describe, expect, it } from "vitest";
import { parseInspectEnvelope } from "./map-inspect";

const FOUND_ATTEMPT = {
  id: "att_live_1",
  workOrderId: "wo-live-1",
  kind: "initial",
  fixNumber: 1,
  priorAttemptId: null,
  state: "ended",
  outcome: "ok",
  sessionId: "ses_live_1",
  createdAtIso: "2026-10-24T10:00:00Z",
  updatedAtIso: "2026-10-24T10:05:00Z",
  baseCommit: "a".repeat(40),
  briefDigest: "digest-1",
  stopReason: "verification failed",
  reviewerSeat: "gpt-6-luna",
  ownerDecisionReferences: [],
  completionReceipt: {
    endedAtIso: "2026-10-24T10:04:00Z",
    exitStatus: 0,
    authoritative: true,
    stoppedByRequest: false,
  },
  runner: {
    kind: "opencode",
    agent: "lane",
    model: "example/model-a",
    variant: null,
  },
  usage: {
    source: "opencode-db",
    readAtIso: "2026-10-24T10:05:00Z",
    steps: 40,
    wallSeconds: 1500,
    tokensInput: 1000,
    tokensOutput: 500,
    costUsd: 0.12,
    model: "example/model-a",
    reason: null,
  },
  artifacts: {
    headCommit: "a".repeat(40),
    commitsSinceBase: ["b".repeat(40)],
    collectedArtifactPaths: [],
    notes: "present",
  },
};

function envelope(result: unknown): { code: string; result: unknown } {
  return { code: "OK", result };
}

function omit(key: string, value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

describe("parseInspectEnvelope", () => {
  it("parses a found envelope", () => {
    const parsed = parseInspectEnvelope(
      envelope({ outcome: "found", attempt: FOUND_ATTEMPT }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.outcome).toBe("found");
    if (parsed?.outcome === "found") {
      expect(parsed.attempt.id).toBe("att_live_1");
      expect(parsed.attempt.runner).toEqual({
        kind: "opencode",
        agent: "lane",
        model: "example/model-a",
        variant: null,
      });
      expect(parsed.attempt.usage?.steps).toBe(40);
      expect(parsed.attempt.artifacts?.commitCount).toBe(1);
      expect(parsed.attempt.completion).toEqual({
        endedAtIso: "2026-10-24T10:04:00Z",
        exitStatus: 0,
        authoritative: true,
        stoppedByRequest: false,
      });
    }
  });

  it("parses a not-found envelope", () => {
    expect(
      parseInspectEnvelope(
        envelope({ outcome: "not-found", attemptId: "att_live_1" }),
      ),
    ).toEqual({ outcome: "not-found", attemptId: "att_live_1" });
  });

  it("parses an unknown envelope and keeps the reason", () => {
    expect(
      parseInspectEnvelope(
        envelope({
          outcome: "unknown",
          attemptId: "att_live_1",
          reason: "the recorded host cannot be resolved",
        }),
      ),
    ).toEqual({
      outcome: "unknown",
      attemptId: "att_live_1",
      reason: "the recorded host cannot be resolved",
    });
  });

  it("reads an absent ownerDecisionReferences as null", () => {
    const parsed = parseInspectEnvelope(
      envelope({
        outcome: "found",
        attempt: omit("ownerDecisionReferences", FOUND_ATTEMPT),
      }),
    );

    if (parsed?.outcome === "found") {
      expect(parsed.attempt.ownerDecisionReferences).toBeNull();
    }
  });

  it("keeps an empty ownerDecisionReferences list", () => {
    const parsed = parseInspectEnvelope(
      envelope({ outcome: "found", attempt: FOUND_ATTEMPT }),
    );

    if (parsed?.outcome === "found") {
      expect(parsed.attempt.ownerDecisionReferences).toEqual([]);
    }
  });

  it("reads an absent usage as null", () => {
    const parsed = parseInspectEnvelope(
      envelope({
        outcome: "found",
        attempt: omit("usage", FOUND_ATTEMPT),
      }),
    );

    if (parsed?.outcome === "found") {
      expect(parsed.attempt.usage).toBeNull();
    }
  });

  it("returns null when the completion receipt has a string exit status", () => {
    expect(
      parseInspectEnvelope(
        envelope({
          outcome: "found",
          attempt: {
            ...FOUND_ATTEMPT,
            completionReceipt: {
              endedAtIso: "2026-10-24T10:04:00Z",
              exitStatus: "0",
              authoritative: true,
              stoppedByRequest: false,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when code is not OK", () => {
    expect(
      parseInspectEnvelope({
        operationId: "op-1",
        code: "NOT_IMPLEMENTED",
        result: null,
      }),
    ).toBeNull();
  });

  it("returns null for an unknown outcome", () => {
    expect(
      parseInspectEnvelope(
        envelope({ outcome: "gone", attemptId: "att_live_1" }),
      ),
    ).toBeNull();
  });
});
