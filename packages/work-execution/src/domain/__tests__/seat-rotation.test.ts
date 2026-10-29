import { describe, expect, it } from "vitest";

import type { AttemptRecord, AttemptSeatSelectionRecord, SeatObservationRecord } from "../execution-records.js";
import {
  coolingSeatIds,
  selectReviewSeat,
  selectSeat,
  type SeatHistoryEntry,
  type SeatSelectionResult,
  type SeatUnavailability,
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
    "first-pass": [seat("fp-a", "alpha-1")],
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
    id: "attempt-example-1",
    workOrderId: "wo-example-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/lanes/attempt-example-1",
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

function seatSelection(seatId: string): AttemptSeatSelectionRecord {
  return {
    role: "first-pass",
    seatIndex: 0,
    seatId,
    model: "example-provider/glm-5.3",
    tool: "opencode",
    variant: null,
    agent: null,
  };
}

function observation(overrides: Partial<SeatObservationRecord> = {}): SeatObservationRecord {
  return {
    version: 1,
    observationId: "obs-example-1",
    seatId: "fp-a",
    outcome: "rate-limited",
    observedAtIso: "2026-10-15T08:00:00.000Z",
    subject: { attemptId: "attempt-example-1" },
    via: "cli",
    ...overrides,
  };
}

describe("omitted inputs reproduce today's behaviour", () => {
  it("keeps cursor advance unchanged", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const history = [h({ seatIndex: 0 })];
    const base = selectSeat({ plan: p, role: "fix", history });
    expect(selectSeat({ plan: p, role: "fix", history, unavailable: new Map(), rotationStart: -1 })).toEqual(base);
    expect(selectSeat({ plan: p, role: "fix", history, rotationStart: 1.5 })).toEqual(base);
  });

  it("keeps a refused model skipped unchanged", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    const history = [h({ role: "first-pass", seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" })];
    const base = selectSeat({ plan: p, role: "fix", history });
    expect(selectSeat({ plan: p, role: "fix", history, unavailable: new Map(), rotationStart: -1 })).toEqual(base);
    expect(selectSeat({ plan: p, role: "fix", history, rotationStart: 1.5 })).toEqual(base);
  });

  it("keeps the on fallback joining after its trigger unchanged", () => {
    const p = plan([seat("A", "alpha-1"), seat("F", "fallback-1", { on: ["rate-limited"] })]);
    const history = [h({ seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" })];
    const base = selectSeat({ plan: p, role: "fix", history });
    expect(selectSeat({ plan: p, role: "fix", history, unavailable: new Map(), rotationStart: -1 })).toEqual(base);
    expect(selectSeat({ plan: p, role: "fix", history, rotationStart: 1.5 })).toEqual(base);
  });

  it("keeps exhaustion unchanged", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    const base = selectSeat({ plan: p, role: "fix", history: [], unhealthySeatIds: ["A", "B"] });
    expect(
      selectSeat({ plan: p, role: "fix", history: [], unhealthySeatIds: ["A", "B"], unavailable: new Map(), rotationStart: -1 }),
    ).toEqual(base);
    expect(selectSeat({ plan: p, role: "fix", history: [], unhealthySeatIds: ["A", "B"], rotationStart: 1.5 })).toEqual(base);
  });

  it("keeps the review round start unchanged", () => {
    const p = plan([seat("A", "alpha-1")], [seat("R1", "rho-1"), seat("R2", "sigma-1")]);
    const base = selectReviewSeat({ plan: p, round: 2, implementerModels: [], sameFamily });
    expect(selectReviewSeat({ plan: p, round: 2, implementerModels: [], sameFamily, unavailable: new Map(), rotationStart: -1 })).toEqual(base);
    expect(selectReviewSeat({ plan: p, round: 2, implementerModels: [], sameFamily, rotationStart: 1.5 })).toEqual(base);
  });

  it("keeps the review family skip unchanged", () => {
    const p = plan([seat("A", "alpha-1")], [seat("R1", "rho-1"), seat("R2", "sigma-1")]);
    const base = selectReviewSeat({ plan: p, round: 0, implementerModels: ["rho-9"], sameFamily });
    expect(selectReviewSeat({ plan: p, round: 0, implementerModels: ["rho-9"], sameFamily, unavailable: new Map(), rotationStart: -1 })).toEqual(base);
    expect(selectReviewSeat({ plan: p, round: 0, implementerModels: ["rho-9"], sameFamily, rotationStart: 1.5 })).toEqual(base);
  });
});

describe("rotationStart on a role with no history", () => {
  it("rotates through available seats", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 0 }), 0);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 1 }), 1);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 2 }), 2);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 3 }), 0);
  });

  it("consecutive tickets land on different available seats", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const unavailable = new Map<string, SeatUnavailability>([
      ["A", { reason: "cooling", until: "2026-10-15T09:00:00.000Z" }],
    ]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 0, unavailable }), 1);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 1, unavailable }), 2);
  });

  it("lands on the same seat when only one is available", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    const unavailable = new Map<string, SeatUnavailability>([
      ["A", { reason: "cooling", until: "2026-10-15T09:00:00.000Z" }],
    ]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 0, unavailable }), 1);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 1, unavailable }), 1);
  });

  it("is exhausted when every seat is unavailable and no fallback triggered", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const unavailable = new Map<string, SeatUnavailability>([
      ["A", { reason: "cooling", until: "2026-10-15T09:00:00.000Z" }],
      ["B", { reason: "busy" }],
      ["C", { reason: "cooling-observed", observationId: "obs-example-1" }],
    ]);
    const result = selectSeat({ plan: p, role: "fix", history: [], rotationStart: 0, unavailable });
    expectRefused(result, ["A: cooling", "B: busy", "C: cooling-observed"]);
  });

  it("is ignored when the role has history", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [h({ seatIndex: 0 })], rotationStart: 1 }), 1);
  });
});

describe("rotation and on fallbacks (SR1b Fable)", () => {
  it("never rotates onto an on fallback", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("F", "fallback-1", { on: ["rate-limited"] })]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 0 }), 0);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 1 }), 1);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [], rotationStart: 2 }), 0);
  });

  it("reaches a triggered on fallback through the scan when every rotation seat is unavailable", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("F", "fallback-1", { on: ["rate-limited"] })]);
    const history = [h({ role: "first-pass", seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" })];
    const unavailable = new Map([
      ["A", { reason: "busy" as const }],
      ["B", { reason: "busy" as const }],
    ]);
    expectSelected(selectSeat({ plan: p, role: "fix", history, rotationStart: 0, unavailable }), 2);
  });

  it("skips a model refused in another role's history when rotating", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    const history = [h({ role: "first-pass", seatIndex: 0, model: "alpha-1", stopReason: "rate-limited" })];
    expectSelected(selectSeat({ plan: p, role: "fix", history, rotationStart: 0 }), 1);
  });
});

describe("unavailable blocks", () => {
  it("skips busy and cooling-observed seats", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const unavailable = new Map<string, SeatUnavailability>([
      ["A", { reason: "busy" }],
      ["B", { reason: "cooling-observed", observationId: "obs-example-1" }],
    ]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [h({ seatIndex: 2 })], unavailable }), 2);
  });

  it("names each unavailable reason in the exhausted text", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1"), seat("C", "gamma-1")]);
    const unavailable = new Map<string, SeatUnavailability>([
      ["A", { reason: "busy" }],
      ["B", { reason: "cooling-observed", observationId: "obs-example-1" }],
      ["C", { reason: "cooling", until: "2026-10-15T09:00:00.000Z" }],
    ]);
    const result = selectSeat({ plan: p, role: "fix", history: [h({ seatIndex: 2 })], unavailable });
    expectRefused(result, ["A: busy", "B: cooling-observed", "C: cooling"]);
  });
});

describe("selectReviewSeat with rotationStart", () => {
  const p = plan([seat("A", "alpha-1")], [seat("R1", "rho-1"), seat("R2", "sigma-1"), seat("R3", "tau-1")]);
  const implementerModels = ["rho-9"];

  it("rotates over the eligible list and never chooses a family-sharing seat", () => {
    expectSelected(selectReviewSeat({ plan: p, round: 0, implementerModels, sameFamily, rotationStart: 0 }), 1);
    expectSelected(selectReviewSeat({ plan: p, round: 1, implementerModels, sameFamily, rotationStart: 0 }), 2);
    expectSelected(selectReviewSeat({ plan: p, round: 1, implementerModels, sameFamily, rotationStart: 1 }), 1);
    expectSelected(selectReviewSeat({ plan: p, round: 0, implementerModels, sameFamily, rotationStart: 1 }), 2);
    expectSelected(selectReviewSeat({ plan: p, round: 2, implementerModels, sameFamily, rotationStart: 1 }), 2);
  });

  it("skips an unavailable review seat", () => {
    const unavailable = new Map<string, SeatUnavailability>([["R2", { reason: "busy" }]]);
    expectSelected(selectReviewSeat({ plan: p, round: 0, implementerModels, sameFamily, rotationStart: 0, unavailable }), 2);
  });
});

describe("coolingSeatIds", () => {
  const now = "2026-10-15T09:00:00.000Z";

  function cool(input: {
    attempts?: readonly AttemptRecord[];
    observations?: readonly SeatObservationRecord[];
    nowIso?: string;
    cooldownMinutes?: number;
    observationCooldownMinutes?: number;
  }) {
    return coolingSeatIds({
      attempts: input.attempts ?? [],
      observations: input.observations ?? [],
      nowIso: input.nowIso ?? now,
      cooldownMinutes: input.cooldownMinutes ?? 60,
      observationCooldownMinutes: input.observationCooldownMinutes ?? 0,
    });
  }

  it("cools a future-stamped refusal only for the cooldown from now", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2099-01-01T00:00:00.000Z",
    });
    const until = cool({ attempts: [attempt] }).get("fp-a")?.until;
    expect(until).toBeDefined();
    expect(Date.parse(until!) - Date.parse(now)).toBe(60 * 60 * 1000);
  });

  it("never cools a seat with a 0-minute cooldown, even for a refusal stamped after now", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2099-01-01T00:00:00.000Z",
    });
    expect(cool({ attempts: [attempt], cooldownMinutes: 0 }).has("fp-a")).toBe(false);
  });

  it("cools a seat after a refusal 30 minutes ago", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2026-10-15T08:30:00.000Z",
    });
    expect(cool({ attempts: [attempt] }).get("fp-a")).toEqual({
      reason: "cooling",
      until: "2026-10-15T09:30:00.000Z",
    });
  });

  it("does not cool a seat after the cooldown has elapsed", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2026-10-15T07:59:00.000Z",
    });
    expect(cool({ attempts: [attempt] }).has("fp-a")).toBe(false);
  });

  it("cools nothing when the cooldown is 0", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2026-10-15T08:30:00.000Z",
    });
    expect(cool({ attempts: [attempt], cooldownMinutes: 0 }).size).toBe(0);
  });

  it("cools nothing for a non-refusal stop", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "gate-failed",
      updatedAtIso: "2026-10-15T08:30:00.000Z",
    });
    expect(cool({ attempts: [attempt] }).size).toBe(0);
  });

  it("cools nothing when observations are off", () => {
    const result = cool({ observations: [observation()], observationCooldownMinutes: 0 });
    expect(result.size).toBe(0);
  });

  it("uses the latest attempt until per seat", () => {
    const earlier = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2026-10-15T08:00:00.000Z",
    });
    const later = attemptRecord({
      id: "attempt-example-2",
      seatSelection: seatSelection("fp-a"),
      stopReason: "timeout",
      updatedAtIso: "2026-10-15T08:30:00.000Z",
    });
    expect(cool({ attempts: [earlier, later] }).get("fp-a")).toEqual({
      reason: "cooling",
      until: "2026-10-15T09:30:00.000Z",
    });
  });

  it("opens one window for observations inside it and keeps the first id", () => {
    const first = observation();
    const second = observation({ observationId: "obs-example-2", observedAtIso: "2026-10-15T08:05:00.000Z" });
    const result = cool({
      observations: [first, second],
      observationCooldownMinutes: 60,
      nowIso: "2026-10-15T08:30:00.000Z",
    });
    expect(result.get("fp-a")).toEqual({
      reason: "cooling-observed",
      until: "2026-10-15T09:00:00.000Z",
      observationId: "obs-example-1",
    });
  });

  it("opens a new window for an observation after the previous window", () => {
    const first = observation();
    const second = observation({ observationId: "obs-example-2", observedAtIso: "2026-10-15T09:01:00.000Z" });
    const result = cool({
      observations: [first, second],
      observationCooldownMinutes: 60,
      nowIso: "2026-10-15T09:30:00.000Z",
    });
    expect(result.get("fp-a")).toEqual({
      reason: "cooling-observed",
      until: "2026-10-15T10:01:00.000Z",
      observationId: "obs-example-2",
    });
  });

  it("lets an attempt cooling win over an observation for the same seat", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "2026-10-15T08:30:00.000Z",
    });
    const result = cool({
      attempts: [attempt],
      observations: [observation()],
      observationCooldownMinutes: 60,
      nowIso: "2026-10-15T08:45:00.000Z",
    });
    expect(result.get("fp-a")).toEqual({
      reason: "cooling",
      until: "2026-10-15T09:30:00.000Z",
    });
  });

  it("returns an empty map when nowIso is unparseable", () => {
    const attempt = attemptRecord({ seatSelection: seatSelection("fp-a"), stopReason: "rate-limited" });
    expect(cool({ attempts: [attempt], nowIso: "not-a-time", observationCooldownMinutes: 60 }).size).toBe(0);
  });

  it("skips unparseable recorded times", () => {
    const attempt = attemptRecord({
      seatSelection: seatSelection("fp-a"),
      stopReason: "rate-limited",
      updatedAtIso: "not-a-time",
    });
    const badObs = observation({ observedAtIso: "not-a-time" });
    const goodObs = observation({ observationId: "obs-example-2", observedAtIso: "2026-10-15T08:00:00.000Z" });
    const result = cool({ attempts: [attempt], observations: [badObs, goodObs], observationCooldownMinutes: 60, nowIso: "2026-10-15T08:30:00.000Z" });
    expect(result.get("fp-a")).toEqual({
      reason: "cooling-observed",
      until: "2026-10-15T09:00:00.000Z",
      observationId: "obs-example-2",
    });
  });

  it("never throws on malformed input", () => {
    const malformedAttempt = { id: "attempt-example-1" } as unknown as AttemptRecord;
    const malformedObservation = { observationId: "obs-example-1" } as unknown as SeatObservationRecord;
    expect(() =>
      cool({
        attempts: [malformedAttempt],
        observations: [malformedObservation],
        cooldownMinutes: 60.5,
        observationCooldownMinutes: -1,
      }),
    ).not.toThrow();
  });
});
