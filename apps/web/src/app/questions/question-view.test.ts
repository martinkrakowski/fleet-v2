import { describe, expect, it } from "vitest";
import type { QuestionView } from "./map-question";
import {
  STATE_FILTERS,
  answerCommands,
  blocksText,
  filterQuestions,
  isPastExpiry,
  matchesState,
  newestFirst,
  parseStateFilter,
  relativeTimeEitherWay,
  stateCounts,
  stateTone,
  summaryText,
} from "./question-view";

function question(overrides: Partial<QuestionView> = {}): QuestionView {
  return {
    questionId: "q_live_1",
    revision: 1,
    askedBy: "orchestrator-1",
    title: "Title",
    body: "Body",
    options: [{ id: "a", label: "A", consequence: "Consequence" }],
    recommendation: { optionId: "a", because: "Because" },
    doorKind: "two-way",
    linkedRequestId: null,
    blocks: [{ kind: "lane", ref: "lane-a" }],
    state: "open",
    askedAt: "2026-10-27T10:00:00.000Z",
    expiresAt: null,
    answer: null,
    acknowledgement: null,
    ...overrides,
  };
}

describe("STATE_FILTERS and parseStateFilter", () => {
  it("lists the filters in order with all last", () => {
    expect(STATE_FILTERS).toEqual([
      "open",
      "answered",
      "rejected",
      "expired",
      "all",
    ]);
  });

  it("defaults unknown and null values to open", () => {
    expect(parseStateFilter(null)).toBe("open");
    expect(parseStateFilter("bogus")).toBe("open");
    expect(parseStateFilter("acknowledged")).toBe("open");
  });

  it("keeps valid filter words", () => {
    expect(parseStateFilter("open")).toBe("open");
    expect(parseStateFilter("answered")).toBe("answered");
    expect(parseStateFilter("rejected")).toBe("rejected");
    expect(parseStateFilter("expired")).toBe("expired");
    expect(parseStateFilter("all")).toBe("all");
  });
});

describe("matchesState", () => {
  const open = question();
  const answered = question({ state: "answered" });
  const acknowledged = question({ state: "acknowledged" });
  const rejected = question({ state: "rejected" });
  const expired = question({ state: "expired" });

  it("matches all questions for the all filter", () => {
    for (const q of [open, answered, acknowledged, rejected, expired]) {
      expect(matchesState(q, "all")).toBe(true);
    }
  });

  it("matches answered and acknowledged for the answered filter", () => {
    expect(matchesState(answered, "answered")).toBe(true);
    expect(matchesState(acknowledged, "answered")).toBe(true);
    expect(matchesState(open, "answered")).toBe(false);
  });

  it("matches the exact word for the other filters", () => {
    expect(matchesState(open, "open")).toBe(true);
    expect(matchesState(rejected, "rejected")).toBe(true);
    expect(matchesState(expired, "expired")).toBe(true);
    expect(matchesState(answered, "open")).toBe(false);
    expect(matchesState(open, "rejected")).toBe(false);
    expect(matchesState(open, "expired")).toBe(false);
  });
});

describe("filterQuestions", () => {
  const q1 = question({ questionId: "q_live_1", blocks: [] });
  const q2 = question({
    questionId: "q_live_2",
    doorKind: "one-way",
    linkedRequestId: "req_live_1",
    blocks: [{ kind: "pr", ref: "pr-244" }],
  });
  const q3 = question({ questionId: "q_live_3", state: "answered" });
  const all = [q1, q2, q3];

  it("filters by state only by default", () => {
    expect(
      filterQuestions(all, { state: "open", blockingOnly: false, oneWayOnly: false }),
    ).toEqual([q1, q2]);
    expect(
      filterQuestions(all, { state: "answered", blockingOnly: false, oneWayOnly: false }),
    ).toEqual([q3]);
  });

  it("applies the blocking-only switch", () => {
    expect(
      filterQuestions(all, { state: "open", blockingOnly: true, oneWayOnly: false }),
    ).toEqual([q2]);
  });

  it("applies the one-way-only switch", () => {
    expect(
      filterQuestions(all, { state: "open", blockingOnly: false, oneWayOnly: true }),
    ).toEqual([q2]);
  });

  it("combines both switches", () => {
    expect(
      filterQuestions(all, { state: "open", blockingOnly: true, oneWayOnly: true }),
    ).toEqual([q2]);
  });
});

describe("stateCounts", () => {
  it("counts each state, acknowledged under answered, and all", () => {
    const qs = [
      question({ state: "open" }),
      question({ state: "acknowledged" }),
      question({ state: "rejected" }),
      question({ state: "expired" }),
      question({ state: "open" }),
    ];
    expect(stateCounts(qs)).toEqual({
      open: 2,
      answered: 1,
      rejected: 1,
      expired: 1,
      all: 5,
    });
  });
});

describe("newestFirst", () => {
  it("returns a new array sorted by askedAt descending, then questionId", () => {
    const input = [
      question({ questionId: "q_a", askedAt: "2026-10-27T10:00:00.000Z" }),
      question({ questionId: "q_b", askedAt: "2026-10-27T11:00:00.000Z" }),
      question({ questionId: "q_c", askedAt: "2026-10-27T10:00:00.000Z" }),
    ];
    const sorted = newestFirst(input);
    expect(sorted).not.toBe(input);
    expect(sorted.map((q) => q.questionId)).toEqual(["q_b", "q_a", "q_c"]);
  });
});

describe("stateTone", () => {
  it("maps open, answered, acknowledged, rejected and expired", () => {
    expect(stateTone("open")).toBe("queued");
    expect(stateTone("answered")).toBe("accepted");
    expect(stateTone("acknowledged")).toBe("accepted");
    expect(stateTone("rejected")).toBe("failed");
    expect(stateTone("expired")).toBe("ended");
  });
});

describe("blocksText", () => {
  it("names the empty case", () => {
    expect(blocksText([])).toBe("blocks nothing recorded");
  });

  it("joins kind and ref with a comma", () => {
    expect(
      blocksText([
        { kind: "pr", ref: "pr-244" },
        { kind: "work-order", ref: "wo-live-1" },
      ]),
    ).toBe("pr pr-244, work-order wo-live-1");
  });
});

describe("answerCommands", () => {
  it("returns nothing for a non-open or one-way question", () => {
    expect(answerCommands(question({ state: "answered" }))).toEqual([]);
    expect(
      answerCommands(
        question({ doorKind: "one-way", linkedRequestId: "req_live_1" }),
      ),
    ).toEqual([]);
  });

  it("builds accept, reject and option commands for an open two-way question", () => {
    expect(
      answerCommands(question({ revision: 3, recommendation: { optionId: "merge", because: "Because" } })),
    ).toEqual([
      "fleet-v2 questions answer q_live_1 --revision 3 --accept",
      "fleet-v2 questions answer q_live_1 --revision 3 --reject",
      "fleet-v2 questions answer q_live_1 --revision 3 --option=merge",
    ]);
  });

  it("offers no command for a question id that starts with a dash, and passes a dashed option as --option=", () => {
    expect(answerCommands(question({ questionId: "--force" }))).toEqual([]);
    const commands = answerCommands(
      question({ revision: 2, recommendation: { optionId: "--x", because: "Because" } }),
    );
    expect(commands[2]).toBe("fleet-v2 questions answer q_live_1 --revision 2 --option=--x");
  });

  it("shell-quotes an id with a quote", () => {
    const commands = answerCommands(question({ questionId: "q'1" }));
    expect(commands[0]).toBe(
      "fleet-v2 questions answer 'q'\\''1' --revision 1 --accept",
    );
  });

  it("shell-quotes an option id with spaces", () => {
    const commands = answerCommands(
      question({ recommendation: { optionId: "my option", because: "Because" } }),
    );
    expect(commands[2]).toBe(
      "fleet-v2 questions answer q_live_1 --revision 1 --option='my option'",
    );
  });
});

describe("isPastExpiry", () => {
  const observed = "2026-10-27T12:00:00.000Z";

  it("is true only for an open question with a recorded expiry before observed", () => {
    expect(
      isPastExpiry(question({ expiresAt: "2026-10-27T10:00:00.000Z" }), observed),
    ).toBe(true);
  });

  it("is false when the expiry is not yet past", () => {
    expect(
      isPastExpiry(question({ expiresAt: "2026-10-28T10:00:00.000Z" }), observed),
    ).toBe(false);
  });

  it("is false with no recorded expiry", () => {
    expect(isPastExpiry(question({ expiresAt: null }), observed)).toBe(false);
  });

  it("is false for a non-open question", () => {
    expect(
      isPastExpiry(
        question({ state: "answered", expiresAt: "2026-10-27T10:00:00.000Z" }),
        observed,
      ),
    ).toBe(false);
  });

  it("is false when the expiry cannot be parsed", () => {
    expect(isPastExpiry(question({ expiresAt: "not-a-date" }), observed)).toBe(false);
  });
});

describe("summaryText", () => {
  it("says no open questions when there are none", () => {
    expect(summaryText([])).toBe("no open questions");
    expect(summaryText([question({ state: "answered" })])).toBe("no open questions");
  });

  it("counts open questions and one-way among them", () => {
    const qs = [
      question({ doorKind: "one-way", linkedRequestId: "req_live_1" }),
      question({ questionId: "q_live_2" }),
      question({ questionId: "q_live_3" }),
      question({ state: "answered", questionId: "q_live_4" }),
    ];
    expect(summaryText(qs)).toBe("3 open questions · 1 one-way");
  });

  it("singularises one open question", () => {
    expect(summaryText([question()])).toBe("1 open question · 0 one-way");
  });

  it("relativeTimeEitherWay reads future and past times", () => {
    expect(relativeTimeEitherWay("2026-10-27T10:25:00.000Z", "2026-10-27T10:00:00.000Z")).toBe("in 25 min");
    expect(relativeTimeEitherWay("2026-10-27T07:00:00.000Z", "2026-10-27T10:00:00.000Z")).toBe("3 h ago");
    expect(relativeTimeEitherWay("not a time", "2026-10-27T10:00:00.000Z")).toBe("");
  });
});
