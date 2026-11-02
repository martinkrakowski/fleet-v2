import { describe, expect, it } from "vitest";

import type { AttemptRecord } from "../execution-records.js";
import {
  classifyRunnerRefusal,
  historyEntryOf,
  pickNextSeat,
  seatMatchesAssignment,
  seatOutcomeOfStopReason,
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

  it("reports exhaustion when every model in the fix chain was refused", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    const result = selectSeat({
      plan: p,
      role: "fix",
      history: [
        h({ role: "first-pass", seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" }),
        h({ role: "first-pass", seatIndex: 1, model: "beta-1", stopReason: "rate-limited" }),
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("ignores a stored seat index outside the plan instead of throwing", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    for (const seatIndex of [-2, -1, 1.5, 7]) {
      const result = selectSeat({ plan: p, role: "fix", history: [h({ seatIndex })] });
      expect(result.ok).toBe(true);
    }
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

  it("skips an unhealthy review seat", () => {
    expectSelected(
      selectReviewSeat({ plan: p, round: 0, implementerModels: [], sameFamily, unhealthySeatIds: [p.getSeats("review")[0].id] }),
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

describe("pickNextSeat", () => {
  function nextPlan(firstPass: readonly Record<string, unknown>[]): SeatPlan {
    return SeatPlan.create({
      version: 1,
      "first-pass": firstPass,
      fix: [seat("fx1", "alpha-1")],
      review: [],
    }).value!;
  }

  const neverBlocked = () => false;

  it("rotates to the next seat after the failed index, cyclically", () => {
    const p = nextPlan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const picked = pickNextSeat(p, "first-pass", 1, "provider-error", neverBlocked);
    expect(picked).toMatchObject({ ok: true, role: "first-pass", seatIndex: 2 });
    expect(picked.ok && picked.seat.id).toBe("C");
    expect(pickNextSeat(p, "first-pass", 2, "rate-limited", neverBlocked)).toMatchObject({
      ok: true,
      seatIndex: 0,
    });
  });

  it("skips seats the block predicate blocks", () => {
    const p = nextPlan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const blocked = (s: { id: string }) => s.id === "B";
    expect(pickNextSeat(p, "first-pass", 0, "rate-limited", blocked)).toMatchObject({
      ok: true,
      seatIndex: 2,
    });
  });

  it("holds a fallback seat until the outcome maps to one of its declared triggers", () => {
    const p = nextPlan([
      seat("A", "alpha-1"),
      { ...seat("F", "delta-1"), on: ["rate-limited"] },
    ]);
    expect(pickNextSeat(p, "first-pass", 0, "rate-limited", neverBlocked)).toMatchObject({
      ok: true,
      seatIndex: 1,
    });
    // A timeout is not a trigger the fallback declares: with the failed seat
    // blocked, the plan is exhausted.
    const blockFailed = (s: { id: string }) => s.id === "A";
    expect(pickNextSeat(p, "first-pass", 0, "timeout", blockFailed)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
  });

  it("maps every remaining trigger class to provider-error", () => {
    const p = nextPlan([
      seat("A", "alpha-1"),
      { ...seat("F", "delta-1"), on: ["payment", "model-missing", "no-route", "runner-refused", "gate-failed"] },
    ]);
    expect(pickNextSeat(p, "first-pass", 0, "provider-error", neverBlocked)).toMatchObject({
      ok: true,
      seatIndex: 1,
    });
    // rate-limited and timeout are their own outcomes and never provider-error:
    // with the failed seat blocked, the declared triggers never fire.
    expect(
      pickNextSeat(p, "first-pass", 0, "rate-limited", (s) => s.id === "A"),
    ).toEqual({ ok: false, reason: "no-seat-allowed" });
  });

  it("never returns the failed seat, so a one-seat plan reads no-seat-allowed", () => {
    const p = nextPlan([seat("A", "alpha-1")]);
    expect(pickNextSeat(p, "first-pass", 0, "provider-error", neverBlocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
    // For a one-seat plan with an unblocked seat and no trigger, rate-limited also reads no-seat-allowed.
    expect(pickNextSeat(p, "first-pass", 0, "rate-limited", neverBlocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
    // A wrap-around onto the failed seat is not a move either: with the other
    // seats blocked the plan is exhausted.
    const two = nextPlan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    expect(pickNextSeat(two, "first-pass", 0, "rate-limited", (s) => s.id === "B")).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
  });

  it("returns no-seat-allowed when no seat is allowed, the role is empty or the index is out of plan", () => {
    const blocked = () => true;
    const p = nextPlan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    expect(pickNextSeat(p, "first-pass", 0, "rate-limited", blocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
    expect(pickNextSeat(p, "review", 0, "rate-limited", neverBlocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
    expect(pickNextSeat(p, "first-pass", 2, "rate-limited", neverBlocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
    expect(pickNextSeat(p, "first-pass", -1, "rate-limited", neverBlocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
  });

  it("excludes reviewer families only through the caller's block predicate", () => {
    const reviewSeat = seat("rv1", "beta-9", { tool: "reviewer" });
    const p = SeatPlan.create({
      version: 1,
      "first-pass": [seat("A", "alpha-1"), seat("B", "beta-1")],
      fix: [seat("fx1", "alpha-1")],
      review: [reviewSeat],
    }).value!;
    const sameFamily = (a: string, b: string) => a.split("-")[0] === b.split("-")[0];
    const reviewerModels = p.getSeats("review").map((s) => s.model);
    const familyBlocked = (s: { model: string }) =>
      reviewerModels.some((model) => sameFamily(s.model, model));
    // B shares the beta family with the review seat and is skipped; the failed
    // seat A itself is never re-picked, so nothing is allowed.
    expect(pickNextSeat(p, "first-pass", 0, "rate-limited", familyBlocked)).toEqual({
      ok: false,
      reason: "no-seat-allowed",
    });
    expect(pickNextSeat(p, "first-pass", 1, "rate-limited", familyBlocked)).toMatchObject({
      ok: true,
      seatIndex: 0,
    });
  });

  it("maps stop reasons to outcomes and fails closed on none and unknown", () => {
    expect(seatOutcomeOfStopReason("rate-limited")).toBe("rate-limited");
    expect(seatOutcomeOfStopReason("timeout")).toBe("timeout");
    expect(seatOutcomeOfStopReason("payment")).toBe("provider-error");
    expect(seatOutcomeOfStopReason("no-route")).toBe("provider-error");
    expect(seatOutcomeOfStopReason("runner-refused")).toBe("provider-error");
    expect(seatOutcomeOfStopReason("none")).toBeNull();
    expect(seatOutcomeOfStopReason("unknown")).toBeNull();
  });
});
