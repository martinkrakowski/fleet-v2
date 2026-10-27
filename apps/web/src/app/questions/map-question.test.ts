import { describe, expect, it } from "vitest";
import { parseQuestionListEnvelope } from "./map-question";

function baseQuestion(): Record<string, unknown> {
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
  };
}

function envelope(questions: unknown[]): unknown {
  return { operationId: "op-q1", code: "OK", result: { questions } };
}

const TWO_WAY_OPEN = {
  questionId: "q_live_1",
  revision: 3,
  askedBy: "orchestrator-1",
  title: "Approve the W1b-2 merge",
  body: "<img src=x onerror=alert(1)>",
  options: [
    {
      id: "merge",
      label: "Merge",
      consequence: "Merges the branch into main.",
    },
    {
      id: "revise",
      label: "Revise",
      consequence: "Asks the lane for changes.",
    },
  ],
  recommendation: { optionId: "merge", because: "All checks pass." },
  doorKind: "two-way",
  linkedRequestId: null,
  blocks: [{ kind: "pr", ref: "pr-244" }],
  state: "open",
  askedAt: "2026-10-27T10:00:00.000Z",
  expiresAt: "2026-10-29T10:00:00.000Z",
  answer: null,
  acknowledgement: null,
};

const ONE_WAY_ANSWERED = {
  questionId: "q_live_2",
  revision: 1,
  askedBy: "orchestrator-1",
  title: "Sign off the release",
  body: "Please decide.",
  options: [
    { id: "ship", label: "Ship", consequence: "Publishes the release." },
    { id: "hold", label: "Hold", consequence: "Keeps it unpublished." },
  ],
  recommendation: { optionId: "ship", because: "Everything is green." },
  doorKind: "one-way",
  linkedRequestId: "req_live_1",
  blocks: [{ kind: "work-order", ref: "wo-live-1" }],
  state: "answered",
  askedAt: "2026-10-26T10:00:00.000Z",
  expiresAt: null,
  answer: {
    shape: "answer",
    optionId: "ship",
    text: "Ship it.",
    reason: "Recorded by the owner.",
    questionRevision: 1,
    answeredVia: "signed-decision",
    answeredAt: "2026-10-27T09:00:00.000Z",
    sessionId: "ses_live_1",
  },
  acknowledgement: {
    by: "owner-1",
    at: "2026-10-27T09:05:00.000Z",
  },
};

describe("parseQuestionListEnvelope", () => {
  it("round-trips a valid two-question envelope in input order", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([TWO_WAY_OPEN, ONE_WAY_ANSWERED]),
    );

    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toEqual({
      questionId: "q_live_1",
      revision: 3,
      askedBy: "orchestrator-1",
      title: "Approve the W1b-2 merge",
      body: "<img src=x onerror=alert(1)>",
      options: [
        {
          id: "merge",
          label: "Merge",
          consequence: "Merges the branch into main.",
        },
        {
          id: "revise",
          label: "Revise",
          consequence: "Asks the lane for changes.",
        },
      ],
      recommendation: { optionId: "merge", because: "All checks pass." },
      doorKind: "two-way",
      linkedRequestId: null,
      blocks: [{ kind: "pr", ref: "pr-244" }],
      state: "open",
      askedAt: "2026-10-27T10:00:00.000Z",
      expiresAt: "2026-10-29T10:00:00.000Z",
      answer: null,
      acknowledgement: null,
    });
    expect(parsed?.[1]).toEqual({
      questionId: "q_live_2",
      revision: 1,
      askedBy: "orchestrator-1",
      title: "Sign off the release",
      body: "Please decide.",
      options: [
        { id: "ship", label: "Ship", consequence: "Publishes the release." },
        { id: "hold", label: "Hold", consequence: "Keeps it unpublished." },
      ],
      recommendation: { optionId: "ship", because: "Everything is green." },
      doorKind: "one-way",
      linkedRequestId: "req_live_1",
      blocks: [{ kind: "work-order", ref: "wo-live-1" }],
      state: "answered",
      askedAt: "2026-10-26T10:00:00.000Z",
      expiresAt: null,
      answer: {
        shape: "answer",
        optionId: "ship",
        text: "Ship it.",
        reason: "Recorded by the owner.",
        questionRevision: 1,
        answeredVia: "signed-decision",
        answeredAt: "2026-10-27T09:00:00.000Z",
      },
      acknowledgement: {
        by: "owner-1",
        at: "2026-10-27T09:05:00.000Z",
      },
    });
  });

  it("keeps untrusted body text byte-identical", () => {
    const xss = '<img src=x onerror=alert(1)>';
    const markdown = "**bold** [x](javascript:alert(1))";
    const parsed = parseQuestionListEnvelope(
      envelope([
        { ...baseQuestion(), body: xss },
        { ...baseQuestion(), questionId: "q_live_2", body: markdown },
      ]),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.[0].body).toBe(xss);
    expect(parsed?.[1].body).toBe(markdown);
  });

  it("refuses an unknown state", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([{ ...baseQuestion(), state: "pending" }]),
    );
    expect(parsed).toBeNull();
  });

  it("refuses a question with a missing doorKind", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([
        {
          questionId: "q_live_1",
          revision: 1,
          askedBy: "orchestrator-1",
          title: "Title",
          body: "Body",
          options: [{ id: "a", label: "A", consequence: "Consequence" }],
          recommendation: { optionId: "a", because: "Because" },
          linkedRequestId: null,
          blocks: [{ kind: "lane", ref: "lane-a" }],
          state: "open",
          askedAt: "2026-10-27T10:00:00.000Z",
          expiresAt: null,
          answer: null,
          acknowledgement: null,
        },
      ]),
    );
    expect(parsed).toBeNull();
  });

  it("refuses a one-way question without a linked request", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([
        { ...baseQuestion(), doorKind: "one-way", linkedRequestId: null },
      ]),
    );
    expect(parsed).toBeNull();
  });

  it("refuses a non-integer revision", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([{ ...baseQuestion(), revision: 1.5 }]),
    );
    expect(parsed).toBeNull();
  });

  it("refuses an answer with an unknown answeredVia", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([
        {
          ...baseQuestion(),
          answer: {
            shape: "accept",
            optionId: null,
            text: null,
            reason: null,
            questionRevision: 1,
            answeredVia: "email",
            answeredAt: "2026-10-27T09:00:00.000Z",
          },
        },
      ]),
    );
    expect(parsed).toBeNull();
  });

  it("refuses a non-OK code", () => {
    const parsed = parseQuestionListEnvelope({
      code: "NOT_IMPLEMENTED",
      result: { questions: [baseQuestion()] },
    });
    expect(parsed).toBeNull();
  });

  it("drops the answer sessionId", () => {
    const parsed = parseQuestionListEnvelope(
      envelope([{ ...baseQuestion(), answer: ONE_WAY_ANSWERED.answer }]),
    );
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("ses_live_1");
  });
});
