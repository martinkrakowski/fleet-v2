import { describe, expect, it } from "vitest";

import type { AttemptRecord } from "../execution-records.js";
import {
  classifyRunnerRefusal,
  historyEntryOf,
  seatMatchesAssignment,
  seatPlanFamilyConflicts,
  selectReviewSeat,
  selectSeat,
  type SeatHistoryEntry,
  type SeatSelectionResult,
} from "../seat-selection.js";
import { SeatPlan } from "../value-objects/SeatPlan.vo.js";

const sameFamily = (a: string, b: string) => a.split("-")[0] === b.split("-")[0];

function seat(id: string, model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, model, tool: "opencode", ...extra };
}

function plan(
  fixSeats: readonly Record<string, unknown>[],
  reviewSeats: readonly Record<string, unknown>[] = [],
): SeatPlan {
  return SeatPlan.create({
    version: 1,
    "first-pass": [seat("fp1", "alpha-1")],
    fix: fixSeats,
    review: reviewSeats,
  }).value!;
}

function h(overrides: Partial<SeatHistoryEntry> & { seatIndex: number }): SeatHistoryEntry {
  return { role: "fix", model: null, stopReason: "none", ...overrides };
}

function expectSelected(result: SeatSelectionResult, index: number): void {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.seatIndex).toBe(index);
  }
}

function expectRefused(result: SeatSelectionResult, contains: readonly string[] = []): void {
  expect(result.ok).toBe(false);
  if (result.ok === false) {
    for (const fragment of contains) {
      expect(result.reason).toContain(fragment);
    }
  }
}

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: "attempt-1",
    workOrderId: "wo-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/lanes/attempt-1",
    baseCommit: "abc123",
    state: "running",
    outcome: null,
    briefDigest: "digest-1",
    briefPackagePath: ".lane/brief.md",
    sessionId: "session-1",
    completionReceipt: null,
    artifacts: null,
    createdAtIso: "2026-10-15T08:00:00.000Z",
    updatedAtIso: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

describe("selectSeat", () => {
  it("rotates through fix seats round-robin", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [] }), 0);
    expectSelected(
      selectSeat({ plan: p, role: "fix", history: [h({ seatIndex: 0 })] }),
      1,
    );
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0 }), h({ seatIndex: 1 })],
      }),
      2,
    );
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0 }), h({ seatIndex: 1 }), h({ seatIndex: 2 })],
      }),
      0,
    );
  });

  it("does not let first-pass history move the fix cursor", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    expectSelected(
      selectSeat({ plan: p, role: "fix", history: [h({ role: "first-pass", seatIndex: 0 })] }),
      0,
    );
  });

  it("skips unhealthy seats", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0 })],
        unhealthySeatIds: ["B"],
      }),
      2,
    );
  });

  it("keeps a refused model out of the rest of the lane", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ role: "first-pass", seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" })],
      }),
      1,
    );
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [
          h({ role: "first-pass", seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" }),
          h({ seatIndex: 1, model: "beta-1", stopReason: "none" }),
        ],
      }),
      1,
    );
  });

  it("gates a fallback seat on its trigger classes", () => {
    const p = plan([seat("A", "alpha-1"), seat("F", "fallback-1", { on: ["rate-limited"] })]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [h({ seatIndex: 0 })] }), 0);
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" })],
      }),
      1,
    );
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [
          h({ seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" }),
          h({ seatIndex: 1, model: "fallback-1", stopReason: "none" }),
        ],
      }),
      1,
    );
  });

  it("reports exhaustion when every fix seat is blocked", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    const result = selectSeat({ plan: p, role: "fix", history: [], unhealthySeatIds: ["A", "B"] });
    expectRefused(result, ["Seat plan exhausted for role fix: ", "A", "B"]);
  });

  it("never lets an unknown stop reason trigger a fallback seat", () => {
    const p = plan([seat("A", "alpha-1"), seat("F", "fallback-1", { on: ["rate-limited"] })]);
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0, model: "alpha-1", stopReason: "unknown" })],
      }),
      0,
    );
  });
});

describe("selectReviewSeat", () => {
  const p = plan([seat("A", "alpha-1")], [seat("R1", "rho-1"), seat("R2", "sigma-1")]);

  it("rotates review seats by round", () => {
    expectSelected(selectReviewSeat({ plan: p, round: 0, implementerModels: [], sameFamily }), 0);
    expectSelected(selectReviewSeat({ plan: p, round: 1, implementerModels: [], sameFamily }), 1);
    expectSelected(selectReviewSeat({ plan: p, round: 2, implementerModels: [], sameFamily }), 0);
  });

  it("skips a review seat that shares a family with an implementer model", () => {
    expectSelected(
      selectReviewSeat({ plan: p, round: 0, implementerModels: ["rho-9"], sameFamily }),
      1,
    );
  });

  it("reports exhaustion when every review seat shares a family", () => {
    const result = selectReviewSeat({
      plan: p,
      round: 0,
      implementerModels: ["rho-9", "sigma-9"],
      sameFamily,
    });
    expectRefused(result, ["Seat plan exhausted for role review: ", "R1", "R2"]);
  });

  it("refuses a negative round", () => {
    expectRefused(selectReviewSeat({ plan: p, round: -1, implementerModels: [], sameFamily }));
  });
});

describe("seatPlanFamilyConflicts", () => {
  it("reports a review seat in an implementer's model family", () => {
    const p = SeatPlan.create({
      version: 1,
      "first-pass": [seat("a1", "alpha-1")],
      fix: [seat("b1", "beta-1")],
      review: [seat("r1", "alpha-9")],
    }).value!;
    const conflicts = seatPlanFamilyConflicts(p, sameFamily);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("r1");
    expect(conflicts[0]).toContain("a1");
  });

  it("returns no conflicts for a clean plan", () => {
    const p = SeatPlan.create({
      version: 1,
      "first-pass": [seat("a1", "alpha-1")],
      fix: [seat("b1", "beta-1")],
      review: [seat("r1", "rho-9")],
    }).value!;
    expect(seatPlanFamilyConflicts(p, sameFamily)).toEqual([]);
  });
});

describe("historyEntryOf", () => {
  it("prefers the model that actually ran over the bound seat", () => {
    const record = attemptRecord({
      runner: { kind: "opencode", remotePort: 1, host: null, agent: null, model: "beta-1", variant: null },
      seatSelection: {
        role: "first-pass",
        seatIndex: 0,
        seatId: "a1",
        model: "alpha-1",
        tool: "opencode",
        variant: null,
        agent: null,
      },
    });
    expect(historyEntryOf(record)).toEqual({
      role: "first-pass",
      seatIndex: 0,
      model: "beta-1",
      stopReason: "unknown",
    });
  });

  it("reads an absent stop reason as unknown", () => {
    expect(historyEntryOf(attemptRecord()).stopReason).toBe("unknown");
  });

  it("reads an absent seat selection as null role and index", () => {
    expect(historyEntryOf(attemptRecord())).toMatchObject({ role: null, seatIndex: null });
  });
});

describe("seatMatchesAssignment", () => {
  it("matches a default variant to an absent seat variant", () => {
    expect(
      seatMatchesAssignment(
        { model: "alpha-1", tool: "opencode", variant: "default" },
        { model: "alpha-1", tool: "opencode" },
      ),
    ).toBe(true);
  });

  it("does not match a present agent against an absent one", () => {
    expect(
      seatMatchesAssignment(
        { model: "alpha-1", tool: "opencode", agent: "x" },
        { model: "alpha-1", tool: "opencode" },
      ),
    ).toBe(false);
  });

  it("does not match a different tool", () => {
    expect(
      seatMatchesAssignment(
        { model: "alpha-1", tool: "opencode" },
        { model: "alpha-1", tool: "agy" },
      ),
    ).toBe(false);
  });
});

describe("classifyRunnerRefusal", () => {
  it.each([
    ["HTTP 429 Too Many Requests", "rate-limited"],
    ["Free usage exceeded", "rate-limited"],
    ["402 Payment Required", "payment"],
    ["ProviderModelNotFoundError: model foo not found", "model-missing"],
    ["request timed out", "timeout"],
    ["Runner refused the start (exit 2, usage error)", "runner-refused"],
  ])("classifies %j as %s", (input, expected) => {
    expect(classifyRunnerRefusal(input)).toBe(expected);
  });
});
