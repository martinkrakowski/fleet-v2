import { describe, expect, it } from "vitest";
import { parseWorkOrderEnvelope } from "./map-work-order";

const ATTEMPT_INITIAL = {
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
};

const ATTEMPT_FIX = {
  id: "att_live_2",
  workOrderId: "wo-live-1",
  kind: "fix",
  fixNumber: 1,
  priorAttemptId: "att_live_1",
  state: "verifying",
  outcome: null,
  sessionId: "ses_live_2",
  createdAtIso: "2026-10-24T11:00:00Z",
  updatedAtIso: "2026-10-24T11:05:00Z",
};

const WORK_ORDER = {
  id: "wo-live-1",
  projectId: "proj-live-1",
  taskId: "task-live-1",
  laneId: "lane-live-1",
  repository: "example/repo",
  baseCommit: "a".repeat(40),
  ownedPaths: ["x"],
  policyRevision: 3,
  prerequisiteWorkOrderIds: [],
  state: "approved",
  revision: 2,
  createdAtIso: "2026-10-24T10:00:00Z",
  updatedAtIso: "2026-10-24T10:05:00Z",
};

const HELD_RESERVATION = {
  attemptId: "att_live_1",
  hostId: "h1",
  slotIndex: 0,
  held: true,
  seatTool: "opencode",
  hostName: "h",
  port: 1,
  worktreePath: "/w",
  reservedAtIso: "2026-10-24T09:00:00Z",
  releasedAtIso: null,
};

const RELEASED_RESERVATION = {
  attemptId: "att_live_2",
  hostId: "h2",
  slotIndex: 1,
  held: false,
  seatTool: null,
  reservedAtIso: "2026-10-24T09:30:00Z",
  releasedAtIso: "2026-10-24T10:00:00Z",
};

function foundEnvelope(
  overrides: Record<string, unknown> = {},
): { code: string; result: Record<string, unknown> } {
  return {
    code: "OK",
    result: {
      outcome: "found",
      workOrder: WORK_ORDER,
      attempts: [ATTEMPT_INITIAL, ATTEMPT_FIX],
      activeReservations: [HELD_RESERVATION, RELEASED_RESERVATION],
      ...overrides,
    },
  };
}

describe("parseWorkOrderEnvelope edges", () => {
  it("returns null for a non-integer revision", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({ workOrder: { ...WORK_ORDER, revision: 1.5 } }),
      ),
    ).toBeNull();
  });

  it("returns null for a negative revision", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({ workOrder: { ...WORK_ORDER, revision: -1 } }),
      ),
    ).toBeNull();
  });

  it("returns null for a string revision", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({ workOrder: { ...WORK_ORDER, revision: "2" } }),
      ),
    ).toBeNull();
  });

  it("accepts a zero revision", () => {
    const parsed = parseWorkOrderEnvelope(
      foundEnvelope({ workOrder: { ...WORK_ORDER, revision: 0 } }),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.outcome !== "found") {
      throw new Error("expected a found envelope");
    }
    expect(parsed.workOrder.revision).toBe(0);
  });

  it("returns null when a prerequisite id is not a string", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({
          workOrder: {
            ...WORK_ORDER,
            prerequisiteWorkOrderIds: ["wo-a", 7],
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when prerequisiteWorkOrderIds is not an array", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({
          workOrder: { ...WORK_ORDER, prerequisiteWorkOrderIds: "wo-a" },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a reservation has held: 'yes'", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({
          activeReservations: [{ ...HELD_RESERVATION, held: "yes" }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a reservation has a numeric seatTool", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({
          activeReservations: [{ ...HELD_RESERVATION, seatTool: 3 }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a reservation has no reservedAtIso", () => {
    const reservation: Record<string, unknown> = { ...HELD_RESERVATION };
    delete reservation.reservedAtIso;
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({ activeReservations: [reservation] }),
      ),
    ).toBeNull();
  });

  it("accepts a reservation with seatTool absent, mapping it to null", () => {
    const reservation: Record<string, unknown> = { ...HELD_RESERVATION };
    delete reservation.seatTool;
    const parsed = parseWorkOrderEnvelope(
      foundEnvelope({ activeReservations: [reservation] }),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.outcome !== "found") {
      throw new Error("expected a found envelope");
    }
    expect(parsed.heldSlots).toEqual([
      {
        attemptId: "att_live_1",
        slotIndex: 0,
        seatTool: null,
        reservedAtIso: "2026-10-24T09:00:00Z",
      },
    ]);
  });

  it("parses a held: false reservation but keeps it out of heldSlots", () => {
    const parsed = parseWorkOrderEnvelope(
      foundEnvelope({ activeReservations: [RELEASED_RESERVATION] }),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.outcome !== "found") {
      throw new Error("expected a found envelope");
    }
    expect(parsed.heldSlots).toEqual([]);
  });

  it("returns null when activeReservations is missing", () => {
    const result: Record<string, unknown> = { ...foundEnvelope().result };
    delete result.activeReservations;
    expect(parseWorkOrderEnvelope({ code: "OK", result })).toBeNull();
  });

  it("returns null when activeReservations is not an array", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({ activeReservations: "held" }),
      ),
    ).toBeNull();
  });

  it("returns null when attempts is not an array", () => {
    expect(
      parseWorkOrderEnvelope(foundEnvelope({ attempts: "all" })),
    ).toBeNull();
  });

  it("returns null for an unknown result outcome", () => {
    expect(
      parseWorkOrderEnvelope({
        code: "OK",
        result: { outcome: "pending" },
      }),
    ).toBeNull();
  });

  it("returns null for a not-found result with a numeric workOrderId", () => {
    expect(
      parseWorkOrderEnvelope({
        code: "OK",
        result: { outcome: "not-found", workOrderId: 7 },
      }),
    ).toBeNull();
  });

  it("returns null when result is null", () => {
    expect(parseWorkOrderEnvelope({ code: "OK", result: null })).toBeNull();
  });
});
