import { describe, expect, it } from "vitest";

import type { AttemptRecord } from "../execution-records.js";
import {
  classifyRunnerRefusal,
  historyEntryOf,
  selectSeat,
  type SeatHistoryEntry,
  type SeatSelectionResult,
} from "../seat-selection.js";
import { SeatPlan } from "../value-objects/SeatPlan.vo.js";
import {
  MODEL_REFUSAL_CLASSES,
  parseStopReason,
  SEAT_TRIGGER_CLASSES,
  STOP_REASONS,
} from "../value-objects/StopReason.vo.js";

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

describe("no-route stop class (SR1a, D9)", () => {
  it("is declared as the last stop reason and a model refusal", () => {
    expect(STOP_REASONS[STOP_REASONS.length - 1]).toBe("no-route");
    expect(STOP_REASONS.indexOf("runner-refused")).toBe(10);
    expect(MODEL_REFUSAL_CLASSES).toEqual([
      "rate-limited",
      "payment",
      "timeout",
      "model-missing",
      "no-route",
    ]);
    expect(SEAT_TRIGGER_CLASSES).toContain("no-route");
    expect(parseStopReason("no-route")).toBe("no-route");
    expect(parseStopReason("No-Route")).toBe("unknown");
    expect(parseStopReason("no_route")).toBe("unknown");
  });

  it.each([
    "404 No endpoints found for example-provider/example-model.",
    "No endpoints found matching your data policy",
    "no endpoint available for the requested model",
    "No allowed providers are available for the selected model",
    "No providers available for example-model",
    "provider error: no route for model example-model",
  ])("classifies %j as no-route", (input) => {
    expect(classifyRunnerRefusal(input)).toBe("no-route");
  });

  it.each([
    ["connect EHOSTUNREACH - no route to host", "runner-refused"],
    ["HTTP 429 Too Many Requests: no endpoints available right now", "rate-limited"],
    ["ProviderModelNotFoundError: model example-model not found; no endpoints found", "model-missing"],
    ["402 Payment Required: no allowed providers", "payment"],
    ["request timed out; no route", "timeout"],
    ["Runner refused the start (exit 2, usage error)", "runner-refused"],
  ])("classifies %j as %s, not no-route", (input, expected) => {
    expect(classifyRunnerRefusal(input)).toBe(expected);
  });

  it("skips the refused model for the rest of the lane", () => {
    const p = plan([seat("A", "alpha-1"), seat("B", "beta-1")]);
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0, model: "alpha-1", stopReason: "no-route" })],
      }),
      1,
    );
    expectRefused(
      selectSeat({
        plan: p,
        role: "fix",
        history: [
          h({ seatIndex: 0, model: "alpha-1", stopReason: "no-route" }),
          h({ seatIndex: 1, model: "beta-1", stopReason: "no-route" }),
        ],
      }),
      ["model refused earlier in this lane (no-route)"],
    );
  });

  it("lets a fallback seat wait for no-route", () => {
    const created = SeatPlan.create({
      version: 1,
      "first-pass": [seat("fp1", "alpha-1")],
      fix: [seat("A", "alpha-1"), seat("C", "gamma-1", { on: ["no-route"] })],
      review: [],
    });
    expect(created.success).toBe(true);
    const p = plan([seat("A", "alpha-1"), seat("C", "gamma-1", { on: ["no-route"] })]);
    expectSelected(selectSeat({ plan: p, role: "fix", history: [] }), 0);
    expectSelected(
      selectSeat({
        plan: p,
        role: "fix",
        history: [h({ seatIndex: 0, model: "alpha-1", stopReason: "no-route" })],
      }),
      1,
    );
  });

  it("reads stored records as before", () => {
    expect(historyEntryOf(attemptRecord()).stopReason).toBe("unknown");
    expect(historyEntryOf(attemptRecord({ stopReason: "runner-refused" })).stopReason).toBe("runner-refused");
    expect(historyEntryOf(attemptRecord({ stopReason: "no-route" })).stopReason).toBe("no-route");
    expect(historyEntryOf(attemptRecord({ stopReason: "no-route-v2" as never })).stopReason).toBe("unknown");
  });
});
