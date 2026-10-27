import { describe, expect, it } from "vitest";
import { loadQuestions } from "./live";
import type { LiveEndpointResult } from "../../lib/api-client";

const QUESTIONS_ENVELOPE = {
  operationId: "op-q1",
  code: "OK",
  result: {
    questions: [
      {
        questionId: "q_live_1",
        revision: 1,
        askedBy: "orchestrator-1",
        title: "Approve the merge",
        body: "Body",
        options: [{ id: "merge", label: "Merge", consequence: "Merges." }],
        recommendation: { optionId: "merge", because: "Checks pass." },
        doorKind: "two-way",
        linkedRequestId: null,
        blocks: [],
        state: "open",
        askedAt: "2026-10-27T10:00:00.000Z",
        expiresAt: null,
        answer: null,
        acknowledgement: null,
      },
    ],
  },
};

type Reply =
  | { source: "api"; data: unknown }
  | { source: "fixture-fallback"; fallbackReason: string | null };

type QuestionQuery = {
  readonly state?: "open" | "answered" | "rejected" | "expired" | "acknowledged";
};

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

describe("loadQuestions", () => {
  const now = () => new Date("2026-10-27T12:00:00Z");

  it("sends an empty query and lists the parsed questions", async () => {
    const client = fakeClient({ source: "api", data: QUESTIONS_ENVELOPE });
    const data = await loadQuestions(client, now);

    expect(client.queries).toEqual([{}]);
    expect(data.view).toBe("listed");
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.observedAtIso).toBe("2026-10-27T12:00:00.000Z");
    if (data.view === "listed") {
      expect(data.questions).toHaveLength(1);
      expect(data.questions[0].questionId).toBe("q_live_1");
    }
  });

  it("reports not-configured when the boundary is unconfigured", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      fallbackReason: "api boundary is not configured",
    });
    const data = await loadQuestions(client, now);

    expect(data.view).toBe("not-configured");
    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe("api boundary is not configured");
    expect(data.observedAtIso).toBe("2026-10-27T12:00:00.000Z");
  });

  it("keeps a 501 fallback reason verbatim", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      fallbackReason: "api boundary returned 501 NOT_IMPLEMENTED for /v1/questions",
    });
    const data = await loadQuestions(client, now);

    expect(data.view).toBe("error");
    expect(data.source).toBe("fixture-fallback");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary returned 501 NOT_IMPLEMENTED for /v1/questions",
      );
    }
  });

  it("reports the envelope code when the payload has a non-OK string code", async () => {
    const client = fakeClient({ source: "api", data: { code: "REFUSED" } });
    const data = await loadQuestions(client, now);

    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe("api boundary answered REFUSED for /v1/questions");
    }
  });

  it("reports an unexpected questions shape", async () => {
    const client = fakeClient({
      source: "api",
      data: { code: "OK", result: { questions: "not-an-array" } },
    });
    const data = await loadQuestions(client, now);

    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary returned an unexpected questions shape for /v1/questions",
      );
    }
  });

  it("uses the injected clock for observedAtIso", async () => {
    const client = fakeClient({ source: "api", data: QUESTIONS_ENVELOPE });
    const data = await loadQuestions(
      client,
      () => new Date("2026-10-27T13:00:00Z"),
    );

    expect(data.observedAtIso).toBe("2026-10-27T13:00:00.000Z");
  });
});
