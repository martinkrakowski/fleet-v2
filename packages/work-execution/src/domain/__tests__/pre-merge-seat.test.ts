import { describe, expect, it } from "vitest";

import type { AttemptRecord } from "../execution-records.js";
import { implementerModelsOf, selectPreMergeSeat, type SeatUnavailability } from "../seat-selection.js";
import type { SeatPlanSeat } from "../value-objects/SeatPlan.vo.js";

const HEAD = "4".repeat(40);

// Family is the model's own name before the version: glm, grok, claude.
const sameFamily = (a: string, b: string) => familyOf(a) === familyOf(b);

function familyOf(model: string): string {
  return (model.split("/")[1] ?? model).split("-")[0];
}

function seat(id: string, model: string, extra: Partial<SeatPlanSeat> = {}): SeatPlanSeat {
  return { id, model, ...extra };
}

function attempt(
  id: string,
  overrides: {
    readonly ranModel?: string;
    readonly boundModel?: string;
    readonly kind?: "initial" | "fix";
    readonly fixNumber?: number;
  } = {},
): AttemptRecord {
  return {
    id,
    workOrderId: "wo-example-1",
    kind: overrides.kind ?? "initial",
    fixNumber: overrides.fixNumber ?? 0,
    priorAttemptId: null,
    worktreePath: "/lanes/" + id,
    baseCommit: HEAD,
    state: "collected",
    outcome: "done",
    briefDigest: "digest-1",
    briefPackagePath: ".lane/brief.md",
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner:
      overrides.ranModel === undefined
        ? null
        : {
            kind: "opencode",
            remotePort: null,
            host: null,
            agent: null,
            model: overrides.ranModel,
            variant: null,
          },
    seatSelection:
      overrides.boundModel === undefined
        ? null
        : {
            role: "fix",
            seatIndex: 0,
            seatId: "fp-a",
            model: overrides.boundModel,
            tool: null,
            variant: null,
            agent: null,
          },
    createdAtIso: "2026-10-15T08:00:00.000Z",
    updatedAtIso: "2026-10-15T08:00:00.000Z",
  };
}

function expectSelected(result: ReturnType<typeof selectPreMergeSeat>, seatId: string): void {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.seat.id).toBe(seatId);
  }
}

describe("implementerModelsOf", () => {
  it("uses the ran model, else the bound model, and keeps first-seen order without duplicates", () => {
    const result = implementerModelsOf([
      attempt("attempt-example-1", { ranModel: "example-provider/glm-5.3" }),
      attempt("attempt-example-2", { ranModel: "example-provider/glm-5.3" }),
      attempt("attempt-example-3", { boundModel: "example-provider/grok-4.7" }),
      attempt("attempt-example-4", { ranModel: "  example-provider/grok-4.7  " }),
    ]);
    expect(result).toEqual({
      ok: true,
      models: ["example-provider/glm-5.3", "example-provider/grok-4.7"],
    });
  });

  it("fails closed on an attempt with neither a ran nor a bound model", () => {
    const result = implementerModelsOf([
      attempt("attempt-example-1", { ranModel: "example-provider/glm-5.3" }),
      attempt("attempt-example-2"),
    ]);
    expect(result).toEqual({ ok: false, attemptId: "attempt-example-2" });
  });
});

describe("selectPreMergeSeat", () => {
  it("skips every implementer family, including a runner-null fix round bound to another family", () => {
    const result = selectPreMergeSeat({
      seats: [
        seat("fp-a", "example-provider/glm-5.3"),
        seat("fp-b", "example-provider/grok-4.7"),
        seat("rv-a", "example-provider/claude-4.6"),
      ],
      attempts: [
        attempt("attempt-example-1", { ranModel: "example-provider/glm-5.3" }),
        attempt("attempt-example-2", { boundModel: "example-provider/grok-4.7", kind: "fix", fixNumber: 1 }),
      ],
      sameFamily,
    });
    expectSelected(result, "rv-a");
  });

  it("refuses when an attempt has no model, naming the attempt id", () => {
    const result = selectPreMergeSeat({
      seats: [seat("rv-a", "example-provider/claude-4.6")],
      attempts: [attempt("attempt-example-7")],
      sameFamily,
    });
    expect(result).toEqual({
      ok: false,
      reason: "Implementer model unknown for attempt attempt-example-7",
    });
  });

  it("skips unhealthy, busy and fallback seats with their reasons, and reports every block in chain order", () => {
    const unavailable = new Map<string, SeatUnavailability>([["fp-b", { reason: "busy" }]]);
    const result = selectPreMergeSeat({
      seats: [
        seat("fp-a", "example-provider/claude-4.6"),
        seat("fp-b", "example-provider/claude-4.7"),
        seat("fp-c", "example-provider/claude-4.8", { on: ["timeout"] }),
        seat("rv-a", "example-provider/glm-5.3"),
      ],
      attempts: [attempt("attempt-example-1", { ranModel: "example-provider/glm-5.3" })],
      sameFamily,
      unhealthySeatIds: ["fp-a"],
      unavailable,
    });
    expect(result).toEqual({
      ok: false,
      reason:
        "Pre-merge seats exhausted: " +
        [
          "fp-a: unhealthy",
          "fp-b: busy",
          "fp-c: fallback seats are not used for pre-merge",
          "rv-a: shares a model family with implementer model example-provider/glm-5.3",
        ].join("; "),
    });
  });

  it("rotates over the eligible seats with a valid rotationStart, and falls back to the first otherwise", () => {
    const input = {
      seats: [
        seat("fp-a", "example-provider/claude-4.6"),
        seat("fp-b", "example-provider/claude-4.7"),
        seat("rv-a", "example-provider/claude-4.8"),
      ],
      attempts: [attempt("attempt-example-1", { ranModel: "example-provider/glm-5.3" })],
      sameFamily,
    };
    expectSelected(selectPreMergeSeat({ ...input, rotationStart: 0 }), "fp-a");
    expectSelected(selectPreMergeSeat({ ...input, rotationStart: 1 }), "fp-b");
    expectSelected(selectPreMergeSeat({ ...input, rotationStart: 2 }), "rv-a");
    expectSelected(selectPreMergeSeat({ ...input, rotationStart: -1 }), "fp-a");
    expectSelected(selectPreMergeSeat({ ...input, rotationStart: 2.5 }), "fp-a");
  });

  it("refuses an empty chain", () => {
    const result = selectPreMergeSeat({
      seats: [],
      attempts: [attempt("attempt-example-1", { ranModel: "example-provider/glm-5.3" })],
      sameFamily,
    });
    expect(result).toEqual({ ok: false, reason: "No pre-merge seats" });
  });
});
