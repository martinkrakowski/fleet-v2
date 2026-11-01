import { describe, expect, it } from "vitest";
import { parseScheduleEnvelope } from "./map-schedule";

const VALID = {
  operationId: "op-1",
  code: "OK",
  result: {
    outcome: "listed",
    truncated: false,
    sessionStarts: [
      {
        runId: "run-2",
        step: "brief-check",
        recordedAtIso: "2026-10-20T09:05:00.000Z",
        gapMs: 1000,
        underStagger: false,
      },
      {
        runId: "run-1",
        step: "dispatch",
        recordedAtIso: "2026-10-20T09:00:00.000Z",
        gapMs: null,
        underStagger: null,
      },
    ],
    schedule: {
      observedAtIso: "2026-10-20T09:05:00.000Z",
      halt: "clear",
      driverLeaseLapsed: null,
      rows: [
        {
          runId: "run-1",
          workOrderId: "wo-1",
          tier: 2,
          state: "running",
          round: 0,
          placement: "running",
          pendingStep: { step: "dispatch", reconciliation: "unread" },
          park: null,
          leaseLapsed: false,
          packageKeys: ["packages/a"],
          workOrderUnreadable: false,
          overlapsWith: [],
          slot: { hostName: "sol", slotIndex: 0 },
          admissionWait: null,
        },
        {
          runId: "run-2",
          workOrderId: "wo-2",
          tier: 2,
          state: "ready",
          round: 1,
          placement: "parked",
          pendingStep: null,
          park: { reason: "blocked", qualifier: "upstream" },
          leaseLapsed: null,
          packageKeys: null,
          workOrderUnreadable: true,
          overlapsWith: ["run-1"],
          slot: null,
          admissionWait: "cap",
        },
      ],
      hosts: [
        {
          hostName: "sol",
          slots: [{ slotIndex: 0, runId: "run-1" }],
        },
      ],
      admission: { active: 1, inFlight: 0, maxActiveRuns: null },
      caps: null,
      trace: "none",
    },
  },
};

describe("parseScheduleEnvelope", () => {
  it("maps a valid envelope into fresh objects keeping array order", () => {
    const parsed = parseScheduleEnvelope(VALID);
    expect(parsed).not.toBeNull();
    expect(parsed?.rows.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
    expect(parsed?.sessionStarts.map((s) => s.runId)).toEqual([
      "run-2",
      "run-1",
    ]);
    expect(parsed?.hosts[0].slots[0].runId).toBe("run-1");
    expect(parsed?.truncated).toBe(false);
    expect(parsed?.halt).toBe("clear");
    expect(parsed?.trace).toBe("none");
    expect(parsed?.caps).toBeNull();
    expect(parsed).not.toBe(VALID.result.schedule);
  });

  it("rejects a non-OK code", () => {
    const value = structuredClone(VALID);
    (value as { code: string }).code = "NOT_IMPLEMENTED";
    expect(parseScheduleEnvelope(value)).toBeNull();
  });

  it("rejects a row with an unknown placement", () => {
    const value = structuredClone(VALID) as {
      result: { schedule: { rows: { placement: string }[] } };
    };
    value.result.schedule.rows[0].placement = "sleeping";
    expect(parseScheduleEnvelope(value)).toBeNull();
  });

  it("rejects a row missing slot", () => {
    const value = structuredClone(VALID) as {
      result: { schedule: { rows: Record<string, unknown>[] } };
    };
    delete value.result.schedule.rows[0].slot;
    expect(parseScheduleEnvelope(value)).toBeNull();
  });

  it("ignores unknown extra fields", () => {
    const value = structuredClone(VALID) as Record<string, unknown>;
    value.extra = "ignored";
    (
      value as {
        result: { schedule: { rows: Record<string, unknown>[] } };
      }
    ).result.schedule.rows[0].futureField = true;
    expect(parseScheduleEnvelope(value)).not.toBeNull();
  });
});
