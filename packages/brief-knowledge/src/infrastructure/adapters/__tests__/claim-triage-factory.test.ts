// Lane K6b tests: createClaimTriage's own gates, unit-level. No network and
// no disk: fetch and the key reader are injected stubs and the stateDir is a
// never-exercised path. Covers the acknowledgement gate (not exactly `true`
// disables triage), the key-file gate (an empty keyFile disables triage) and
// the assembled adapter (everything set makes the jev adapter), plus the
// disabled-projects pass-through that mirrors the ranking factory.
import { describe, expect, it } from "vitest";
import { createClaimTriage } from "../claim-triage-factory.js";
import type { RankingAdviceDecisions } from "../ranking-advice-factory.js";
import { JevClaimTriageAdapter } from "../JevClaimTriageAdapter.adapter.js";

function decisionsWith(
  overrides?: Partial<{
    keyFile: string;
    acknowledgement: unknown;
  }>,
): RankingAdviceDecisions {
  const acknowledgement = overrides?.acknowledgement;
  return {
    provider: "jev",
    model: "typesafe/jev-1.14",
    keyFile: overrides?.keyFile ?? "/tmp/jev-key",
    minConfidence: 0.5,
    monthlyBudgetUsd: 10,
    assumedCostPerCallUsd: 0.002,
    consumers: {
      "claim-triage": {
        // The declared acknowledgement must be exactly the boolean `true`.
        ...(acknowledgement === undefined
          ? { acknowledgeCandidateClaimsLeaveHost: true }
          : {
              acknowledgeCandidateClaimsLeaveHost: acknowledgement,
            }),
      },
    },
  } as unknown as RankingAdviceDecisions;
}

const OPTIONS = {
  stateDir: "/tmp/fleet-state",
  fetch: (async () => new Response("{}")) as typeof fetch,
  readKey: async () => "test-key",
};

describe("createClaimTriage", () => {
  it("gives undefined when the acknowledgement is the string \"true\"", () => {
    const port = createClaimTriage({
      ...OPTIONS,
      decisions: decisionsWith({ acknowledgement: "true" }),
    });
    expect(port).toBeUndefined();
  });

  it("gives undefined when the acknowledgement is the number 1", () => {
    const port = createClaimTriage({
      ...OPTIONS,
      decisions: decisionsWith({ acknowledgement: 1 }),
    });
    expect(port).toBeUndefined();
  });

  it("gives undefined when the acknowledgement is missing", () => {
    const decisions = decisionsWith();
    const withoutAck = {
      ...decisions,
      consumers: { "claim-triage": {} },
    } as unknown as RankingAdviceDecisions;
    const port = createClaimTriage({
      ...OPTIONS,
      decisions: withoutAck,
    });
    expect(port).toBeUndefined();
  });

  it("gives undefined when the keyFile is empty", () => {
    const port = createClaimTriage({
      ...OPTIONS,
      decisions: decisionsWith({ keyFile: "" }),
    });
    expect(port).toBeUndefined();
  });

  it("makes a JevClaimTriageAdapter when everything is set", () => {
    const port = createClaimTriage({
      ...OPTIONS,
      decisions: decisionsWith(),
    });
    expect(port).toBeInstanceOf(JevClaimTriageAdapter);
  });

  it("passes disabledProjects through to the adapter like the ranking factory", async () => {
    const port = createClaimTriage({
      ...OPTIONS,
      decisions: {
        ...decisionsWith(),
        disabledProjects: ["proj-disabled"],
      } as unknown as RankingAdviceDecisions,
    });
    if (!(port instanceof JevClaimTriageAdapter)) {
      expect(port).toBeInstanceOf(JevClaimTriageAdapter);
      return;
    }
    const advice = await port.triageAttempt({
      attemptId: "attempt-1",
      projectId: "proj-disabled",
      pathPrefixes: [],
      candidates: [{ id: "entry-a", claimText: "A reusable lesson." }],
    });
    // A disabled project is never triaged: no reservation, no send.
    expect(advice).toEqual({ status: "unknown", reason: "not-configured" });
  });
});
