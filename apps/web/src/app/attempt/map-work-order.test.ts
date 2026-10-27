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

function omit(key: string, value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

describe("parseWorkOrderEnvelope", () => {
  it("parses a found envelope, keeping only held reservations", () => {
    const parsed = parseWorkOrderEnvelope(foundEnvelope());

    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.outcome !== "found") {
      throw new Error("expected a found envelope");
    }
    expect(parsed.workOrder.id).toBe("wo-live-1");
    expect(parsed.workOrder.projectId).toBe("proj-live-1");
    expect(parsed.workOrder.taskId).toBe("task-live-1");
    expect(parsed.workOrder.laneId).toBe("lane-live-1");
    expect(parsed.workOrder.state).toBe("approved");
    expect(parsed.workOrder.revision).toBe(2);
    expect(parsed.workOrder.baseCommit).toBe("a".repeat(40));
    expect(parsed.workOrder.prerequisiteWorkOrderIds).toEqual([]);
    expect(parsed.attempts.map((attempt) => attempt.id)).toEqual([
      "att_live_1",
      "att_live_2",
    ]);
    expect(parsed.heldSlots).toEqual([
      {
        attemptId: "att_live_1",
        slotIndex: 0,
        seatTool: "opencode",
        reservedAtIso: "2026-10-24T09:00:00Z",
      },
    ]);
  });

  it("parses a not-found envelope", () => {
    expect(
      parseWorkOrderEnvelope({
        code: "OK",
        result: { outcome: "not-found", workOrderId: "wo-live-1" },
      }),
    ).toEqual({ outcome: "not-found", workOrderId: "wo-live-1" });
  });

  it("returns null for a non-OK code", () => {
    expect(
      parseWorkOrderEnvelope({ code: "REFUSED", result: {} }),
    ).toBeNull();
  });

  it("returns null when the work order misses laneId", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({ workOrder: omit("laneId", WORK_ORDER) }),
      ),
    ).toBeNull();
  });

  it("returns null when an attempt fails parseRecordedAttempt", () => {
    const badAttempt = { ...ATTEMPT_INITIAL, kind: "bogus" };
    expect(
      parseWorkOrderEnvelope(foundEnvelope({ attempts: [badAttempt] })),
    ).toBeNull();
  });

  it("returns null when a reservation has a negative slotIndex", () => {
    expect(
      parseWorkOrderEnvelope(
        foundEnvelope({
          activeReservations: [{ ...HELD_RESERVATION, slotIndex: -1 }],
        }),
      ),
    ).toBeNull();
  });

  it("drops host, path and repository fields", () => {
    const parsed = parseWorkOrderEnvelope(foundEnvelope());
    const json = JSON.stringify(parsed);
    expect(json).not.toContain("repository");
    expect(json).not.toContain("ownedPaths");
    expect(json).not.toContain("hostName");
    expect(json).not.toContain('"port"');
    expect(json).not.toContain("worktreePath");
  });
});
