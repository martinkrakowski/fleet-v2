import { describe, expect, it } from "vitest";
import type { AttemptSummary } from "./fixture";
import { attemptIdHref, attemptHref, laneIdLine, queuePos, liveViewHref } from "./derive";

function attempt(overrides: Partial<AttemptSummary>): AttemptSummary {
  return {
    id: "att_q_1",
    wo: "wo-q-1",
    kind: "first",
    number: 1,
    fixOf: null,
    session: null,
    port: null,
    slot: null,
    capacity: "pending",
    startedAt: null,
    queuedAt: "2026-11-23T10:00:00Z",
    queueBound: null,
    observedAt: "2026-11-23T10:05:00Z",
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
    recordedState: "intent-recorded",
    ...overrides,
  };
}

describe("queuePos", () => {
  it("returns 1-based positions ordered by ascending queuedAt across pending attempts", () => {
    const first = attempt({ id: "att-q-first", queuedAt: "2026-11-23T09:00:00Z" });
    const second = attempt({ id: "att-q-second", queuedAt: "2026-11-23T10:00:00Z" });
    const third = attempt({ id: "att-q-third", queuedAt: "2026-11-23T11:00:00Z" });
    const held = attempt({
      id: "att-q-held",
      capacity: "held",
      session: "ses-q-held",
    });
    const list = [second, held, third, first];
    expect(queuePos(first, list)).toBe(1);
    expect(queuePos(second, list)).toBe(2);
    expect(queuePos(third, list)).toBe(3);
    expect(list.map((a) => a.id)).toEqual([
      "att-q-second",
      "att-q-held",
      "att-q-third",
      "att-q-first",
    ]);
  });

  it("sorts a null queuedAt first before timestamped pending attempts", () => {
    const undated = attempt({ id: "att-q-undated", queuedAt: null });
    const early = attempt({ id: "att-q-early", queuedAt: "2026-11-23T09:00:00Z" });
    const late = attempt({ id: "att-q-late", queuedAt: "2026-11-23T10:00:00Z" });
    const list = [early, late, undated];
    expect(queuePos(undated, list)).toBe(1);
    expect(queuePos(early, list)).toBe(2);
    expect(queuePos(late, list)).toBe(3);
  });

  it("returns 0 for a non-pending attempt or an attempt absent from the list", () => {
    const pending = attempt({ id: "att-q-pending" });
    const held = attempt({
      id: "att-q-held",
      capacity: "held",
      session: "ses-q-held",
    });
    expect(queuePos(held, [pending, held])).toBe(0);
    expect(queuePos(attempt({ id: "att-q-elsewhere" }), [pending])).toBe(0);
  });
});

describe("laneIdLine", () => {
  it("prints queued #1, #2, #3 in queuedAt order for pending attempts", () => {
    const first = attempt({ id: "att-q-first", queuedAt: "2026-11-23T09:00:00Z" });
    const second = attempt({ id: "att-q-second", queuedAt: "2026-11-23T10:00:00Z" });
    const third = attempt({ id: "att-q-third", queuedAt: "2026-11-23T11:00:00Z" });
    const list = [third, second, first];
    expect(laneIdLine(first, list)).toContain("queued #1");
    expect(laneIdLine(second, list)).toContain("queued #2");
    expect(laneIdLine(third, list)).toContain("queued #3");
  });

  it("includes <n> bound only when queueBound is non-null", () => {
    const bound = attempt({ id: "att-q-tied", queueBound: "3" });
    expect(laneIdLine(bound, [bound])).toContain("3 bound · no session");

    const unbound = attempt({ id: "att-q-free", queueBound: null });
    const line = laneIdLine(unbound, [unbound]);
    expect(line).not.toContain("bound");
    expect(line).toContain("queued #1 · no session");
  });
});

describe("attemptIdHref", () => {
  it("percent-encodes reserved and whitespace characters", () => {
    expect(attemptIdHref("a b/c?d")).toBe("/attempt?id=a%20b%2Fc%3Fd");
  });
});

describe("attemptHref", () => {
  it("delegates to attemptIdHref for the attempt id", () => {
    expect(attemptHref(attempt({ id: "a b/c?d" }))).toBe(
      "/attempt?id=a%20b%2Fc%3Fd",
    );
  });
});

describe("liveViewHref", () => {
  it("returns null for empty or whitespace-only ids and the encoded href otherwise", () => {
    expect(liveViewHref(attempt({ id: "" }))).toBeNull();
    expect(liveViewHref(attempt({ id: "   \t\n" }))).toBeNull();
    expect(liveViewHref(attempt({ id: "a b/c?d" }))).toBe(
      "/attempt?id=a%20b%2Fc%3Fd",
    );
  });
});
