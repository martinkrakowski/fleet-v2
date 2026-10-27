import { describe, expect, it } from "vitest";
import {
  chainLabel,
  chainOrder,
  heldSlotText,
  prerequisitesText,
  workOrderAnnouncement,
} from "./work-order-view";
import type { RecordedAttemptWire } from "../../lib/attempt-wire";
import type { WorkOrderPanel } from "./live-context";

const FIRST_PASS: RecordedAttemptWire = {
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
  runner: null,
  usage: null,
  artifacts: null,
};

const FIX_1: RecordedAttemptWire = {
  ...FIRST_PASS,
  id: "att_live_2",
  kind: "fix",
  priorAttemptId: "att_live_1",
  state: "verifying",
  outcome: null,
  createdAtIso: "2026-10-24T11:00:00Z",
};

const FIX_2: RecordedAttemptWire = {
  ...FIX_1,
  id: "att_live_3",
  fixNumber: 2,
  priorAttemptId: "att_live_2",
  state: "ready-to-merge",
  createdAtIso: "2026-10-24T12:00:00Z",
};

const SUMMARY = {
  id: "wo-live-1",
  projectId: "proj-live-1",
  taskId: "task-live-1",
  laneId: "lane-live-1",
  state: "approved",
  revision: 2,
  baseCommit: "a".repeat(40),
  prerequisiteWorkOrderIds: [],
  createdAtIso: "2026-10-24T10:00:00Z",
  updatedAtIso: "2026-10-24T10:05:00Z",
};

describe("chainOrder", () => {
  it("sorts by fix number then created then id, without mutating its input", () => {
    const input = [FIX_2, FIRST_PASS, FIX_1];
    const ordered = chainOrder(input);
    expect(ordered.map((attempt) => attempt.id)).toEqual([
      "att_live_1",
      "att_live_2",
      "att_live_3",
    ]);
    expect(input.map((attempt) => attempt.id)).toEqual([
      "att_live_3",
      "att_live_1",
      "att_live_2",
    ]);
  });
});

describe("chainLabel", () => {
  it("labels the first pass and fixes", () => {
    expect(chainLabel(FIRST_PASS)).toBe("first pass");
    expect(chainLabel(FIX_1)).toBe("fix 1");
  });
});

describe("prerequisitesText", () => {
  it("joins ids and says none recorded", () => {
    expect(prerequisitesText([])).toBe("none recorded");
    expect(prerequisitesText(["wo-a", "wo-b"])).toBe("wo-a, wo-b");
  });
});

describe("heldSlotText", () => {
  it("includes the seat tool when set", () => {
    expect(
      heldSlotText({
        attemptId: "att_live_1",
        slotIndex: 0,
        seatTool: "opencode",
        reservedAtIso: "2026-10-24T09:00:00Z",
      }),
    ).toBe("slot 0 held for att_live_1 · opencode");
  });

  it("omits the seat tool when absent", () => {
    expect(
      heldSlotText({
        attemptId: "att_live_1",
        slotIndex: 0,
        seatTool: null,
        reservedAtIso: "2026-10-24T09:00:00Z",
      }),
    ).toBe("slot 0 held for att_live_1");
  });
});

describe("workOrderAnnouncement", () => {
  it("announces the found panel", () => {
    const panel: WorkOrderPanel = {
      panel: "found",
      workOrder: SUMMARY,
      attempts: [],
      heldSlots: [],
    };
    expect(workOrderAnnouncement(panel)).toBe(
      "Work order wo-live-1: recorded state approved",
    );
  });

  it("announces the not-found panel", () => {
    const panel: WorkOrderPanel = {
      panel: "not-found",
      workOrderId: "wo-live-1",
    };
    expect(workOrderAnnouncement(panel)).toBe(
      "Work order wo-live-1 is not recorded on this station",
    );
  });

  it("announces the error panel", () => {
    const panel: WorkOrderPanel = {
      panel: "error",
      workOrderId: "wo-live-1",
      reason: "boom",
    };
    expect(workOrderAnnouncement(panel)).toBe(
      "The work order read did not answer as expected",
    );
  });

  it("announces the not-read panel", () => {
    const panel: WorkOrderPanel = { panel: "not-read" };
    expect(workOrderAnnouncement(panel)).toBe("Work order not read");
  });
});
