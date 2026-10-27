import { describe, expect, it } from "vitest";
import { loadQuestionSummary, openQuestionCount } from "./summary";
import type { LiveEndpointResult } from "../../lib/api-client";

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
    blocks: [],
    state: "open",
    askedAt: "2026-10-27T10:00:00.000Z",
    expiresAt: null,
    answer: null,
    acknowledgement: null,
  };
}

function envelope(questions: unknown[]): unknown {
  return { code: "OK", result: { questions } };
}

type QuestionQuery = {
  readonly state?: "open" | "answered" | "rejected" | "expired" | "acknowledged";
};

type Reply =
  | { source: "api"; data: unknown }
  | { source: "fixture-fallback"; fallbackReason: string | null };

function fakeClient(reply: Reply) {
  const queries: QuestionQuery[] = [];
  const client = {
    queries,
    fetchQuestionList: async <T>(
      query: QuestionQuery,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      queries.push(query);
      if (reply.source === "api") {
        return {
          source: "api",
          status: 200,
          data: reply.data as T,
          fallbackReason: null,
        };
      }
      return {
        source: "fixture-fallback",
        status: 501,
        data: fallback,
        fallbackReason: reply.fallbackReason,
      };
    },
  };
  return client;
}

describe("loadQuestionSummary", () => {
  const now = () => new Date("2026-10-27T12:00:00Z");

  it("queries open questions and counts two open questions, one one-way and blocking", async () => {
    const client = fakeClient({
      source: "api",
      data: envelope([
        {
          ...baseQuestion(),
          doorKind: "one-way",
          linkedRequestId: "req_live_1",
          blocks: [{ kind: "work-order", ref: "wo-live-1" }],
        },
        { ...baseQuestion(), questionId: "q_live_2" },
      ]),
    });
    const summary = await loadQuestionSummary(client, now);

    expect(client.queries).toEqual([{ state: "open" }]);
    expect(summary).toEqual({
      status: "read",
      open: 2,
      oneWay: 1,
      blocking: 1,
      observedAtIso: "2026-10-27T12:00:00.000Z",
    });
  });

  it("does not count answered or acknowledged records", async () => {
    const client = fakeClient({
      source: "api",
      data: envelope([
        { ...baseQuestion(), state: "answered" },
        { ...baseQuestion(), questionId: "q_live_2", state: "acknowledged" },
      ]),
    });
    const summary = await loadQuestionSummary(client, now);

    expect(summary).toEqual({
      status: "read",
      open: 0,
      oneWay: 0,
      blocking: 0,
      observedAtIso: "2026-10-27T12:00:00.000Z",
    });
  });

  it("reports not-read when the boundary is unconfigured", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      fallbackReason: "api boundary is not configured",
    });
    const summary = await loadQuestionSummary(client, now);

    expect(summary).toEqual({ status: "not-read" });
  });

  it("keeps a 500 fallback reason verbatim", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      fallbackReason:
        "api boundary returned 500 INTERNAL_SERVER_ERROR for /v1/questions",
    });
    const summary = await loadQuestionSummary(client, now);

    expect(summary).toEqual({
      status: "error",
      reason:
        "api boundary returned 500 INTERNAL_SERVER_ERROR for /v1/questions",
    });
  });

  it("uses the default fallback reason when the client gives null", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      fallbackReason: null,
    });
    const summary = await loadQuestionSummary(client, now);

    expect(summary).toEqual({
      status: "error",
      reason: "the api client gave no fallback reason",
    });
  });

  it("reports the envelope code when the payload has a non-OK string code", async () => {
    const client = fakeClient({ source: "api", data: { code: "REFUSED" } });
    const summary = await loadQuestionSummary(client, now);

    expect(summary).toEqual({
      status: "error",
      reason: "api boundary answered REFUSED for /v1/questions",
    });
  });

  it("reports an unexpected questions shape", async () => {
    const client = fakeClient({
      source: "api",
      data: { code: "OK", result: { questions: "not-an-array" } },
    });
    const summary = await loadQuestionSummary(client, now);

    expect(summary).toEqual({
      status: "error",
      reason:
        "api boundary returned an unexpected questions shape for /v1/questions",
    });
  });

  it("uses the injected clock for observedAtIso", async () => {
    const client = fakeClient({ source: "api", data: envelope([]) });
    const summary = await loadQuestionSummary(
      client,
      () => new Date("2026-10-27T13:00:00Z"),
    );

    expect(summary).toEqual({
      status: "read",
      open: 0,
      oneWay: 0,
      blocking: 0,
      observedAtIso: "2026-10-27T13:00:00.000Z",
    });
  });
});

describe("openQuestionCount", () => {
  it("returns the open count for a read summary", () => {
    expect(
      openQuestionCount({
        status: "read",
        open: 3,
        oneWay: 1,
        blocking: 0,
        observedAtIso: "2026-10-27T12:00:00.000Z",
      }),
    ).toBe(3);
  });

  it("returns null for an error summary", () => {
    expect(openQuestionCount({ status: "error", reason: "boom" })).toBeNull();
  });

  it("returns null for a not-read summary", () => {
    expect(openQuestionCount({ status: "not-read" })).toBeNull();
  });

  it("never throws: a client that rejects becomes an error summary", async () => {
    const failing = {
      fetchQuestionList: async () => {
        throw new Error("boom http://api.example.internal");
      },
    };
    const summary = await loadQuestionSummary(failing as never);
    expect(summary.status).toBe("error");
    expect(JSON.stringify(summary)).not.toContain("example.internal");
  });
});
