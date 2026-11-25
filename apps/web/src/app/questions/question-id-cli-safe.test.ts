import { describe, expect, it } from "vitest";
import { answerCommands, questionIdIsCliSafe } from "./question-view";
import type { QuestionView } from "./map-question";

function makeQuestionView(overrides?: Partial<QuestionView>): QuestionView {
  return {
    questionId: "q-1",
    revision: 1,
    askedBy: "orchestrator-1",
    title: "Title",
    body: "Body",
    options: [{ id: "a", label: "A", consequence: "Consequence" }],
    recommendation: { optionId: "a", because: "Because" },
    doorKind: "two-way",
    linkedRequestId: null,
    blocks: [],
    state: "open",
    askedAt: "2026-10-27T10:00:00.000Z",
    expiresAt: null,
    answer: null,
    acknowledgement: null,
    ...overrides,
  };
}

describe("questionIdIsCliSafe", () => {
  it("returns false for question ids beginning with an ASCII hyphen-minus ('-x', '--revision', '-')", () => {
    // Cost bound: one startsWith check per id, O(1) time and space.
    for (const id of ["-x", "--revision", "-"]) {
      expect(questionIdIsCliSafe(makeQuestionView({ questionId: id }))).toBe(
        false,
      );
    }
  });

  it("returns true for safe question ids without a leading hyphen-minus ('q-1', 'abc', 'x-', 'a-b')", () => {
    for (const id of ["q-1", "abc", "x-", "a-b"]) {
      expect(questionIdIsCliSafe(makeQuestionView({ questionId: id }))).toBe(
        true,
      );
    }
  });

  it("observed behaviour: allows en dash '\u2013x' and leading space ' -x' because only leading ASCII '-' is checked", () => {
    expect(questionIdIsCliSafe(makeQuestionView({ questionId: "\u2013x" }))).toBe(
      true,
    );
    expect(questionIdIsCliSafe(makeQuestionView({ questionId: " -x" }))).toBe(
      true,
    );
  });

  it("observed behaviour: allows empty id '' because !''.startsWith('-') is true (reachable only if upstream validation allows empty ids)", () => {
    expect(questionIdIsCliSafe(makeQuestionView({ questionId: "" }))).toBe(true);
  });
});

describe("answerCommands", () => {
  it("answerCommands returns [] for open two-way question with id '-x' and non-empty commands containing 'q-1' for id 'q-1'", () => {
    expect(answerCommands(makeQuestionView({ questionId: "-x" }))).toEqual([]);

    const safe = answerCommands(makeQuestionView({ questionId: "q-1" }));
    expect(safe.length).toBe(3);
    for (const command of safe) {
      expect(command).toContain("q-1");
    }
  });
});
