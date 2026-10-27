import { describe, expect, it } from "vitest";
import {
  announcementFor,
  cliCommand,
  cliHints,
  completionRows,
  decisionRefsText,
  relativeTime,
  runnerRows,
  shellQuote,
  usageSummary,
} from "./live-view";
import type { AttemptDetail } from "./map-inspect";
import type { AttemptPageData } from "./live";

const LONG_ID = "a".repeat(40);

const BASE_ATTEMPT: AttemptDetail = {
  id: "att_live_1",
  workOrderId: "wo-live-1",
  kind: "initial",
  fixNumber: 0,
  priorAttemptId: null,
  state: "running",
  outcome: null,
  sessionId: "ses_live_1",
  createdAtIso: "2026-10-27T11:00:00Z",
  updatedAtIso: "2026-10-27T11:59:00Z",
  runner: null,
  usage: null,
  artifacts: null,
  baseCommit: LONG_ID,
  briefDigest: null,
  stopReason: null,
  reviewerSeat: null,
  ownerDecisionReferences: null,
  completion: null,
};

type FoundPageData = Extract<AttemptPageData, { view: "found" }>;

function foundData(
  attempt: AttemptDetail = BASE_ATTEMPT,
  overrides: Partial<Omit<FoundPageData, "view" | "attempt">> = {},
): FoundPageData {
  return {
    view: "found",
    attemptId: attempt.id,
    source: "api",
    fallbackReason: null,
    observedAtIso: "2026-10-27T12:00:00Z",
    attempt,
    ...overrides,
  };
}

describe("shellQuote", () => {
  it("leaves safe ids unchanged", () => {
    expect(shellQuote("att_live_1")).toBe("att_live_1");
  });

  it("wraps values containing spaces in single quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
  });

  it("escapes single quotes the shell way", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("quotes shell metacharacters", () => {
    expect(shellQuote("$(x)")).toBe("'$(x)'");
  });
});

describe("cliCommand", () => {
  it("quotes ids needing shell quoting", () => {
    expect(cliCommand("reconcile", "a b")).toBe(
      "fleet-v2 attempt reconcile --attempt-id 'a b'",
    );
  });
});

describe("cliHints", () => {
  it("offers all four commands enabled for a found attempt", () => {
    const hints = cliHints(foundData());
    expect(hints.map((h) => h.op)).toEqual([
      "reconcile",
      "stop",
      "collect",
      "usage",
    ]);
    expect(hints.map((h) => h.command)).toEqual([
      "fleet-v2 attempt reconcile --attempt-id att_live_1",
      "fleet-v2 attempt stop --attempt-id att_live_1",
      "fleet-v2 attempt collect --attempt-id att_live_1",
      "fleet-v2 attempt usage --attempt-id att_live_1",
    ]);
    expect(hints.every((h) => h.disabledReason === null)).toBe(true);
  });

  it("disables every hint when the recorded host cannot be resolved", () => {
    const data: AttemptPageData = {
      view: "unknown",
      reason: "host-map key w1a",
      attemptId: "att_live_1",
      source: "api",
      fallbackReason: null,
      observedAtIso: "2026-10-27T12:00:00Z",
    };
    const hints = cliHints(data);
    expect(hints).toHaveLength(4);
    expect(
      hints.every(
        (h) =>
          h.disabledReason ===
          "The recorded host cannot be resolved: this attempt holds its slot, and no operation is offered until the host resolves.",
      ),
    ).toBe(true);
  });

  it("returns no hints for a not-found attempt", () => {
    const data: AttemptPageData = {
      view: "not-found",
      attemptId: "att_live_1",
      source: "api",
      fallbackReason: null,
      observedAtIso: "2026-10-27T12:00:00Z",
    };
    expect(cliHints(data)).toEqual([]);
  });
});

describe("runnerRows", () => {
  it("returns empty when no runner is recorded", () => {
    expect(runnerRows(null)).toEqual([]);
  });

  it("fills missing seat fields with not recorded", () => {
    expect(
      runnerRows({ kind: "opencode", agent: null, model: "example/model-a", variant: null }),
    ).toEqual([
      ["kind", "opencode"],
      ["agent", "not recorded"],
      ["model", "example/model-a"],
      ["variant", "not recorded"],
    ]);
  });
});

describe("usageSummary", () => {
  it("reports no usage when none is recorded", () => {
    expect(usageSummary(null)).toEqual({
      status: "not-measured",
      note: "Not measured: no usage is recorded on this attempt.",
      rows: [],
    });
  });

  it("reads an unavailable usage read", () => {
    expect(
      usageSummary({
        source: "unavailable",
        readAtIso: "2026-10-27T12:00:00Z",
        steps: null,
        wallSeconds: null,
        tokensInput: null,
        tokensOutput: null,
        costUsd: null,
        model: null,
        reason: "usage db missing",
      }),
    ).toEqual({
      status: "unavailable",
      note: "Not measured: usage db missing",
      rows: [["read at", "2026-10-27T12:00:00Z"]],
    });
  });

  it("renders a measured usage row set", () => {
    expect(
      usageSummary({
        source: "opencode-db",
        readAtIso: "2026-10-27T12:00:00Z",
        steps: 12,
        wallSeconds: 300,
        tokensInput: 1000,
        tokensOutput: 2000,
        costUsd: 0.05,
        model: "example/model-a",
        reason: null,
      }),
    ).toEqual({
      status: "measured",
      note: "Cost as opencode recorded it: a free seat records $0.00; a plan-billed seat's figure is an estimate, not spend.",
      rows: [
        ["steps", "12"],
        ["lane minutes", "5"],
        ["tokens in", "1000"],
        ["tokens out", "2000"],
        ["cost", "$0.05"],
        ["model", "example/model-a"],
        ["read at", "2026-10-27T12:00:00Z"],
      ],
    });
  });

  it("reads a null cost as unreadable", () => {
    const s = usageSummary({
      source: "opencode-db",
      readAtIso: "2026-10-27T12:00:00Z",
      steps: null,
      wallSeconds: null,
      tokensInput: null,
      tokensOutput: null,
      costUsd: null,
      model: null,
      reason: null,
    });
    expect(s.rows.find(([term]) => term === "cost")?.[1]).toBe(
      "unreadable (not 0)",
    );
  });

  it("formats a zero cost as $0.00", () => {
    const s = usageSummary({
      source: "opencode-db",
      readAtIso: "2026-10-27T12:00:00Z",
      steps: null,
      wallSeconds: null,
      tokensInput: null,
      tokensOutput: null,
      costUsd: 0,
      model: null,
      reason: null,
    });
    expect(s.rows.find(([term]) => term === "cost")?.[1]).toBe("$0.00");
  });
});

describe("completionRows", () => {
  it("notes a missing completion receipt", () => {
    expect(completionRows(null)).toEqual([
      ["completion", "no completion receipt recorded"],
    ]);
  });
});

describe("decisionRefsText", () => {
  it("reads null as unknown and blocking acceptance", () => {
    expect(decisionRefsText(null)).toBe(
      "unknown: not recorded on this attempt, which blocks acceptance",
    );
  });

  it("reads an empty list as none recorded", () => {
    expect(decisionRefsText([])).toBe("none recorded");
  });

  it("joins recorded references", () => {
    expect(decisionRefsText(["d-1", "d-2"])).toBe("d-1, d-2");
  });
});

describe("relativeTime", () => {
  const now = "2026-10-27T12:00:00Z";

  it("uses whole units", () => {
    expect(relativeTime("2026-10-27T11:59:30Z", now)).toBe("30 s ago");
    expect(relativeTime("2026-10-27T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-10-27T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-25T12:00:00Z", now)).toBe("2 d ago");
  });

  it("returns empty for a future time", () => {
    expect(relativeTime("2026-10-27T13:00:00Z", now)).toBe("");
  });

  it("returns empty for an unparseable time", () => {
    expect(relativeTime("not-a-time", now)).toBe("");
  });
});

describe("announcementFor", () => {
  it("ignores observedAtIso so unchanged polls announce nothing", () => {
    const a = foundData(BASE_ATTEMPT, {
      observedAtIso: "2026-10-27T12:00:00Z",
    });
    const b = foundData(BASE_ATTEMPT, {
      observedAtIso: "2026-10-27T12:00:10Z",
    });
    expect(announcementFor(a)).toBe(announcementFor(b));
    expect(announcementFor(a)).toBe("Attempt att_live_1: recorded state running");
  });

  it("includes the outcome when set", () => {
    expect(announcementFor(foundData({ ...BASE_ATTEMPT, outcome: "ended" }))).toBe(
      "Attempt att_live_1: recorded state running, outcome ended",
    );
  });
});
