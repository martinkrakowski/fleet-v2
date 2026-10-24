import { describe, expect, it } from "vitest";
import { attempts, workOrders } from "./fixture";
import type { AttemptSummary } from "./fixture";
import { isLive, laneIdLine, summary, woOf } from "./derive";

function recorded(state: string): AttemptSummary {
  return {
    id: "att_r_1",
    wo: "wo-r-1",
    kind: "first",
    number: 1,
    fixOf: null,
    session: "ses_r_1",
    port: null,
    slot: null,
    capacity: "held",
    startedAt: "2026-10-24T10:00:00Z",
    queuedAt: null,
    queueBound: null,
    observedAt: "2026-10-24T10:05:00Z",
    observedFrom: "recorded state",
    facts: {
      reachable: "unknown",
      prepared: "unknown",
      active: "unknown",
      ended: "unknown",
      collected: "unknown",
    },
    lastKnown: null,
    stale: false,
    receipts: {
      completion: null,
      verification: null,
      acceptance: null,
      decision: null,
    },
    mergeHead: null,
    pullRequest: null,
    cost: null,
    legal: [],
    notOffered: [],
    basis: "recorded",
    recordedState: state,
  };
}

describe("summary", () => {
  it("applies the recorded state table", () => {
    expect(summary(recorded("intent-recorded"))).toEqual([
      "queued",
      "intent recorded · waiting for a slot",
    ]);
    expect(summary(recorded("dispatching"))).toEqual([
      "active",
      "dispatching · recorded, not observed",
    ]);
    expect(summary(recorded("running"))).toEqual([
      "active",
      "running · recorded, not observed",
    ]);
    expect(summary(recorded("reconciling"))).toEqual([
      "unknown",
      "reconciling · no runner answer recorded yet",
    ]);
    expect(summary(recorded("blocked"))).toEqual([
      "blocked",
      "blocked · recorded",
    ]);
    expect(summary(recorded("ended"))).toEqual([
      "ended",
      "ended · artifacts not collected",
    ]);
    expect(summary(recorded("collected"))).toEqual([
      "ended",
      "ended · collected",
    ]);
    expect(summary(recorded("cancelled"))).toEqual(["ended", "cancelled"]);
    expect(summary(recorded("weird"))).toEqual([
      "unknown",
      "unrecognised recorded state weird",
    ]);
  });

  it("leaves fixture rows unchanged", () => {
    expect(summary(attempts[0])).toEqual(["active", "running · 21 lane min"]);
  });
});

describe("isLive", () => {
  it("is false for a recorded running row", () => {
    expect(isLive(recorded("running"))).toBe(false);
  });

  it("stays true for an observed running fixture row", () => {
    expect(isLive(attempts[0])).toBe(true);
  });
});

describe("laneIdLine", () => {
  it("drops null port and null bound text", () => {
    const line = laneIdLine(recorded("running"));
    expect(line).not.toContain("port null");

    const pending: AttemptSummary = {
      ...recorded("intent-recorded"),
      capacity: "pending",
    };
    expect(laneIdLine(pending)).not.toContain("null bound");
    expect(laneIdLine(pending)).toContain("no session");
  });
});

describe("woOf", () => {
  it("returns the placeholder when the work order record is missing", () => {
    expect(woOf({ ...attempts[0], wo: "wo-missing" })).toEqual({
      project: "(unknown)",
      task: "work order wo-missing (record missing)",
      lane: "",
    });
  });

  it("returns the fixture map entry when present", () => {
    expect(woOf(attempts[0])).toBe(workOrders["wo-0142"]);
  });
});
