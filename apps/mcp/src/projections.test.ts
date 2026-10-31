// Allow-list projection tests: projectQuestion, projectQuestionList,
// projectQuestionResult and projectProjectList drop every field not listed,
// turn wrong-typed values into null (never coerce), omit malformed list
// entries and never throw.
import { describe, expect, it } from "vitest";
import { projectProjectList, projectQuestion, projectQuestionResult } from "./projections.js";

const FULL_QUESTION = {
  questionId: "q-1",
  revision: 3,
  state: "open",
  doorKind: "dispatch",
  askedBy: "agent-1",
  askedAt: "2026-10-31T00:00:00Z",
  expiresAt: "2026-11-01T00:00:00Z",
  linkedRequestId: "req-1",
  blocks: [{ kind: "dispatch", ref: "wo-1" }],
  recommendation: { optionId: "o1", because: "because" },
  answer: {
    shape: "option",
    optionId: "o1",
    answeredVia: "cli",
    answeredAt: "2026-10-31T01:00:00Z",
    text: "owner's words",
    reason: "owner's reason",
    sessionId: "ses-1",
  },
  title: "T",
  body: "B",
  options: [
    { id: "o1", label: "L", consequence: "C" },
    { id: "o2", label: "L2", consequence: "C2" },
  ],
  extraField: "dropped",
};

const FULL_QUESTION_PROJECTION = {
  questionId: "q-1",
  revision: 3,
  state: "open",
  doorKind: "dispatch",
  askedBy: "agent-1",
  askedAt: "2026-10-31T00:00:00Z",
  expiresAt: "2026-11-01T00:00:00Z",
  linkedRequestId: "req-1",
  blocks: [{ kind: "dispatch", ref: "wo-1" }],
  recommendation: { optionId: "o1" },
  answer: {
    shape: "option",
    optionId: "o1",
    answeredVia: "cli",
    answeredAt: "2026-10-31T01:00:00Z",
  },
  asked: {
    source: "owner-question",
    askedBy: "agent-1",
    title: "T",
    body: "B",
    options: [
      { id: "o1", label: "L", consequence: "C" },
      { id: "o2", label: "L2", consequence: "C2" },
    ],
    recommendationBecause: "because",
  },
};

describe("projectQuestion", () => {
  it("projects a full record and drops the answer's text, reason and sessionId", () => {
    expect(projectQuestion(FULL_QUESTION)).toEqual(FULL_QUESTION_PROJECTION);
  });

  it("turns wrong-typed scalars into null without coercing", () => {
    const projected = projectQuestion({ ...FULL_QUESTION, revision: "3", questionId: 7 });
    expect(projected.revision).toBeNull();
    expect(projected.questionId).toBeNull();
  });

  it("omits malformed block entries", () => {
    const projected = projectQuestion({
      ...FULL_QUESTION,
      blocks: [null, "x", { kind: "k", ref: "r" }],
    });
    expect(projected.blocks).toEqual([{ kind: "k", ref: "r" }]);
  });

  it("omits malformed option entries and drops extra option fields", () => {
    const projected = projectQuestion({
      ...FULL_QUESTION,
      options: [42, { id: "o1", label: "L", consequence: "C", extra: 1 }],
    });
    expect(projected.asked.options).toEqual([{ id: "o1", label: "L", consequence: "C" }]);
  });

  it("does not throw on null, array or string input", () => {
    for (const value of [null, [], "x"]) {
      const projected = projectQuestion(value);
      expect(projected.questionId).toBeNull();
      expect(projected.revision).toBeNull();
      expect(projected.state).toBeNull();
      expect(projected.doorKind).toBeNull();
      expect(projected.askedBy).toBeNull();
      expect(projected.askedAt).toBeNull();
      expect(projected.expiresAt).toBeNull();
      expect(projected.linkedRequestId).toBeNull();
      expect(projected.blocks).toEqual([]);
      expect(projected.recommendation).toEqual({ optionId: null });
      expect(projected.answer).toBeNull();
      expect(projected.asked).toEqual({
        source: "owner-question",
        askedBy: null,
        title: null,
        body: null,
        options: [],
        recommendationBecause: null,
      });
    }
  });
});

describe("projectQuestionResult", () => {
  it("carries no question for non-found outcomes", () => {
    expect(projectQuestionResult({ outcome: "not-found", question: { questionId: "q" } })).toEqual({
      outcome: "not-found",
      question: null,
    });
  });

  it("gives outcome 'unknown' when the outcome is missing", () => {
    expect(projectQuestionResult({})).toEqual({ outcome: "unknown", question: null });
  });
});

describe("projectProjectList", () => {
  it("drops repository, designatedDispatcherHost, clones and gateProcedures", () => {
    const projected = projectProjectList({
      outcome: "OK",
      profiles: [
        {
          projectId: "p-1",
          displayName: "D",
          status: "active",
          defaultBranch: "main",
          policyRevision: "r1",
          maxConcurrentLanes: 4,
          revision: 2,
          updatedAtIso: "2026-10-31T00:00:00Z",
          repository: "/repo",
          designatedDispatcherHost: "host",
          clones: [{ path: "/c" }],
          gateProcedures: [{ name: "g" }],
        },
      ],
    });
    expect(projected.outcome).toBe("OK");
    expect(projected.profiles).toHaveLength(1);
    const profile = projected.profiles[0];
    expect(profile).not.toHaveProperty("repository");
    expect(profile).not.toHaveProperty("designatedDispatcherHost");
    expect(profile).not.toHaveProperty("clones");
    expect(profile).not.toHaveProperty("gateProcedures");
    expect(profile).toEqual({
      projectId: "p-1",
      displayName: "D",
      status: "active",
      defaultBranch: "main",
      policyRevision: "r1",
      maxConcurrentLanes: 4,
      revision: 2,
      updatedAtIso: "2026-10-31T00:00:00Z",
    });
  });

  it("omits non-record profile entries", () => {
    const projected = projectProjectList({
      outcome: "OK",
      profiles: [null, "x", 3, { projectId: "p-1" }],
    });
    expect(projected.profiles).toEqual([
      {
        projectId: "p-1",
        displayName: null,
        status: null,
        defaultBranch: null,
        policyRevision: null,
        maxConcurrentLanes: null,
        revision: null,
        updatedAtIso: null,
      },
    ]);
  });

  it("does not coerce a string maxConcurrentLanes", () => {
    const projected = projectProjectList({
      outcome: "OK",
      profiles: [{ projectId: "p-1", maxConcurrentLanes: "4" }],
    });
    expect(projected.profiles[0]?.maxConcurrentLanes).toBeNull();
  });
});
