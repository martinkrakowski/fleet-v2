import { describe, expect, it } from "vitest";
import {
  parseAttemptListEnvelope,
  toAttemptSummary,
  toWorkOrderSummary,
  type ListedAttemptWire,
} from "./map-attempt";

function wireRow(
  overrides: Partial<ListedAttemptWire> = {},
): ListedAttemptWire {
  return {
    attempt: {
      id: "att_live_1",
      workOrderId: "wo-live-1",
      kind: "initial",
      fixNumber: 1,
      priorAttemptId: null,
      state: "running",
      outcome: null,
      sessionId: "ses_live_1",
      createdAtIso: "2026-10-24T10:00:00Z",
      updatedAtIso: "2026-10-24T10:05:00Z",
    },
    workOrder: {
      id: "wo-live-1",
      projectId: "fleet-v2",
      taskId: "Task one",
      laneId: "lane-a",
    },
    reservation: {
      hostId: "host-a",
      hostName: "execution host A",
      slotIndex: 0,
    },
    ...overrides,
  };
}

describe("toAttemptSummary", () => {
  it("maps a running initial attempt with a reservation to held, slot 1, first", () => {
    const summary = toAttemptSummary(wireRow());

    expect(summary.kind).toBe("first");
    expect(summary.number).toBe(1);
    expect(summary.capacity).toBe("held");
    expect(summary.slot).toBe(1);
    expect(summary.port).toBeNull();
    expect(summary.basis).toBe("recorded");
    expect(summary.recordedState).toBe("running");
    expect(summary.facts).toEqual({
      reachable: "unknown",
      prepared: "unknown",
      active: "unknown",
      ended: "unknown",
      collected: "unknown",
    });
    expect(summary.startedAt).toBe("2026-10-24T10:00:00Z");
    expect(summary.queuedAt).toBeNull();
    expect(summary.queueBound).toBeNull();
    expect(summary.observedAt).toBe("2026-10-24T10:05:00Z");
    expect(summary.observedFrom).toBe(
      'recorded state "running" · GET /v1/attempts · not a runner observation',
    );
    expect(summary.lastKnown).toBeNull();
    expect(summary.stale).toBe(false);
    expect(summary.receipts).toEqual({
      completion: null,
      verification: null,
      acceptance: null,
      decision: null,
    });
    expect(summary.mergeHead).toBeNull();
    expect(summary.pullRequest).toBeNull();
    expect(summary.cost).toBeNull();
    expect(summary.legal).toEqual([]);
    expect(summary.notOffered).toEqual([
      {
        op: "act",
        reason: "the live list is read-only; act through the fleet-v2 CLI",
      },
    ]);
  });

  it("maps an intent-recorded attempt without a reservation to pending", () => {
    const row = wireRow({
      attempt: {
        ...wireRow().attempt,
        state: "intent-recorded",
        sessionId: null,
      },
      reservation: null,
    });
    const summary = toAttemptSummary(row);

    expect(summary.capacity).toBe("pending");
    expect(summary.queuedAt).toBe("2026-10-24T10:00:00Z");
    expect(summary.startedAt).toBeNull();
    expect(summary.slot).toBeNull();
    expect(summary.port).toBeNull();
  });

  it("maps a collected fix attempt with fixNumber 2", () => {
    const row = wireRow({
      attempt: {
        ...wireRow().attempt,
        id: "att_live_2",
        kind: "fix",
        fixNumber: 2,
        priorAttemptId: "att_live_1",
        state: "collected",
      },
      reservation: null,
    });
    const summary = toAttemptSummary(row);

    expect(summary.kind).toBe("fix");
    expect(summary.number).toBe(2);
    expect(summary.fixOf).toBe("att_live_1");
    expect(summary.capacity).toBe("released");
    expect(summary.facts.ended).toBe("yes");
    expect(summary.facts.collected).toBe("yes");
    expect(summary.recordedState).toBe("collected");
  });
});

describe("toWorkOrderSummary", () => {
  it("maps a null work order to the record-missing placeholder", () => {
    expect(toWorkOrderSummary(wireRow({ workOrder: null }))).toEqual({
      project: "(unknown)",
      task: "work order wo-live-1 (record missing)",
      lane: "",
    });
  });

  it("maps a present work order from its project, task and lane", () => {
    expect(toWorkOrderSummary(wireRow())).toEqual({
      project: "fleet-v2",
      task: "Task one",
      lane: "lane-a",
    });
  });
});

describe("parseAttemptListEnvelope", () => {
  it("returns null when code is not OK", () => {
    expect(
      parseAttemptListEnvelope({
        operationId: "op-1",
        code: "NOT_IMPLEMENTED",
        result: null,
      }),
    ).toBeNull();
  });

  it("returns null when attempts is missing", () => {
    expect(
      parseAttemptListEnvelope({
        code: "OK",
        result: { outcome: "listed", total: 0, truncated: false },
      }),
    ).toBeNull();
  });

  it("returns null when a row has a numeric id", () => {
    const badRow = {
      attempt: { ...wireRow().attempt, id: 7 },
      workOrder: wireRow().workOrder,
      reservation: wireRow().reservation,
    };
    expect(
      parseAttemptListEnvelope({
        code: "OK",
        result: {
          outcome: "listed",
          total: 1,
          truncated: false,
          attempts: [badRow],
        },
      }),
    ).toBeNull();
  });

  it("parses a valid two-row envelope", () => {
    const secondRow = wireRow({
      attempt: {
        ...wireRow().attempt,
        id: "att_live_2",
        workOrderId: "wo-live-2",
        kind: "fix",
        fixNumber: 2,
        state: "ended",
        sessionId: null,
      },
      workOrder: null,
      reservation: null,
    });
    const parsed = parseAttemptListEnvelope({
      operationId: "op-7",
      code: "OK",
      result: {
        outcome: "listed",
        total: 2,
        truncated: false,
        attempts: [wireRow(), secondRow],
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.total).toBe(2);
    expect(parsed?.truncated).toBe(false);
    expect(parsed?.rows[0].attempt.id).toBe("att_live_1");
    expect(parsed?.rows[1].attempt.id).toBe("att_live_2");
    expect(parsed?.rows[1].workOrder).toBeNull();
    expect(parsed?.rows[1].reservation).toBeNull();
  });
});
