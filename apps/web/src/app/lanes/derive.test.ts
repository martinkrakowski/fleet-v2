import { describe, expect, it } from "vitest";
import { attempts, workOrders } from "./fixture";
import type { AttemptSummary } from "./fixture";
import {
  attemptHref,
  isLive,
  kpiScopeNote,
  laneIdLine,
  liveViewHref,
  observedLine,
  summary,
  unknownAttention,
  woOf,
} from "./derive";

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
    expect(
      summary({ ...recorded("intent-recorded"), capacity: "pending" }),
    ).toEqual(["queued", "intent recorded · waiting for a slot"]);
    expect(
      summary({ ...recorded("intent-recorded"), capacity: "held" }),
    ).toEqual([
      "queued",
      "intent recorded · slot reserved · not yet dispatching",
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

  it("renders recorded no-session rows by capacity and terminal state", () => {
    const runningHeld: AttemptSummary = {
      ...recorded("running"),
      session: null,
      capacity: "held",
      slot: 1,
    };
    expect(laneIdLine(runningHeld)).toContain("no session recorded · slot 1");
    expect(laneIdLine(runningHeld)).not.toContain("released");

    const runningUnrecorded: AttemptSummary = {
      ...recorded("running"),
      session: null,
      capacity: "unrecorded",
    };
    expect(laneIdLine(runningUnrecorded)).toContain(
      "no session recorded · no slot recorded",
    );

    const collectedNoSession: AttemptSummary = {
      ...recorded("collected"),
      session: null,
      capacity: "released",
    };
    expect(laneIdLine(collectedNoSession)).toContain("ended · no slot held");

    expect(laneIdLine({ ...attempts[4], session: null })).toContain(
      "ended · slot released",
    );
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

  it("returns the placeholder for wo constructor on an empty map", () => {
    expect(woOf({ ...attempts[0], wo: "constructor" }, {})).toEqual({
      project: "(unknown)",
      task: "work order constructor (record missing)",
      lane: "",
    });
  });

  it("returns the fixture map entry when present", () => {
    expect(woOf(attempts[0])).toBe(workOrders["wo-0142"]);
  });
});

describe("attemptHref", () => {
  it("URL-encodes an id containing & and #", () => {
    expect(attemptHref({ ...attempts[0], id: "att_1&2#3" })).toBe(
      "/attempt?id=att_1%262%233",
    );
  });
});

describe("liveViewHref", () => {
  it("is null for a recorded row and /attempt?id=<encoded id> for a fixture row", () => {
    expect(liveViewHref(recorded("running"))).toBeNull();
    expect(liveViewHref({ ...attempts[0], id: "att_1&2#3" })).toBe(
      "/attempt?id=att_1%262%233",
    );
  });
});

describe("observedLine", () => {
  it("starts with recorded for a recorded row and observed for a fixture row", () => {
    const rec = recorded("running");
    const recLine = observedLine(rec, summary(rec)[1]);
    expect(recLine.startsWith("recorded ")).toBe(true);
    expect(recLine).toBe(
      "recorded 2026-10-24T10:05:00Z · recorded state · running · recorded, not observed",
    );

    const fix = attempts[0];
    const fixLine = observedLine(fix, summary(fix)[1]);
    expect(fixLine.startsWith("observed ")).toBe(true);
    expect(fixLine).toBe(
      `observed ${fix.observedAt} · ${fix.observedFrom} · running · 21 lane min`,
    );
  });
});

describe("unknownAttention", () => {
  it("reports state not established for recorded rows and runner did not answer for fixture rows", () => {
    const paused = recorded("paused");
    const pausedAttn = unknownAttention(paused, summary(paused)[1]);
    expect(pausedAttn.title).toBe("state not established");
    expect(pausedAttn.detail).toContain("unrecognised recorded state paused");
    expect(pausedAttn.detail).toContain("no slot recorded");
    expect(pausedAttn.detail).toContain("reconcile asks the runner");

    const reconciling: AttemptSummary = { ...recorded("reconciling"), slot: 2 };
    const recAttn = unknownAttention(reconciling, summary(reconciling)[1]);
    expect(recAttn.title).toBe("state not established");
    expect(recAttn.detail).toContain(
      "reconciling · no runner answer recorded yet",
    );
    expect(recAttn.detail).toContain("slot 2 recorded as held");
    expect(recAttn.detail).toContain("reconcile asks the runner");

    const fix = attempts.find((a) => summary(a)[0] === "unknown") ?? attempts[0];
    const fixAttn = unknownAttention(fix, summary(fix)[1]);
    expect(fixAttn.title).toBe("runner did not answer");
    expect(fixAttn.detail).toContain("reconcile returns 409, not a guess");
  });
});

describe("kpiScopeNote", () => {
  it("returns null when not truncated and the scope note when truncated", () => {
    expect(kpiScopeNote(12, 12, false)).toBeNull();
    expect(kpiScopeNote(250, 100, true)).toBe(
      "counted over the newest 100 of 250",
    );
  });
});
