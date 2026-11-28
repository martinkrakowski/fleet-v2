// Q5-1: POST /v1/questions/:id/answers derives answeredVia and sessionId
// exclusively from the presented token. A body that claims "web" or carries a
// sessionId is stripped, never trusted; the shared bearer is always "cli".
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, toNodeListener } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { configurePresentedTokenResolver } from "../presented-token.js";
import {
  configureOperatorComposition,
  getOperatorComposition,
} from "../operator/composition.js";
import answersPostHandler from "../../routes/v1/questions/[id]/answers.post.js";

const VALID_TOKEN = "a".repeat(32);

interface EnvelopeBody {
  operationId?: string;
  code?: string;
  result?: { outcome?: string; reason?: string } | null;
}

function answerBody() {
  return {
    questionRevision: 1,
    shape: "accept",
    // Both fields are spoofed on purpose: the route must strip and derive them.
    answeredVia: "web",
    sessionId: "spoofed-session",
  };
}

describe("answers route attribution", () => {
  let server: Server;
  let baseUrl: string;
  let execute: MockInstance;

  beforeEach(() => {
    configureOperatorComposition(null);
    execute = vi.spyOn(getOperatorComposition().answerOwnerQuestion, "execute");

    const app = createApp();
    const router = createRouter();
    router.post("/v1/questions/:id/answers", answersPostHandler);
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    return new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    }).then(() => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configurePresentedTokenResolver(null);
    configureOperatorComposition(null);
    vi.restoreAllMocks();
  });

  async function postAnswer(body: unknown, sessionId?: string): Promise<Response> {
    configurePresentedTokenResolver(() => ({
      tokenId: "shared-bearer",
      scopes: ["message"],
      ...(sessionId !== undefined ? { sessionId } : {}),
    }));
    return fetch(`${baseUrl}/v1/questions/q-1/answers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("ignores body answeredVia and sessionId when authenticated with shared bearer and records answeredVia cli", async () => {
    execute.mockResolvedValue({ outcome: "answered" });

    const res = await postAnswer(answerBody());

    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.code).toBe("OK");
    expect(execute).toHaveBeenCalledTimes(1);
    const arg = execute.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.questionId).toBe("q-1");
    expect(arg.answeredVia).toBe("cli");
    expect("sessionId" in arg).toBe(false);
  });

  it("derives answeredVia web and sessionId from presentedToken when authenticated with a session token", async () => {
    execute.mockResolvedValue({ outcome: "answered" });
    configurePresentedTokenResolver(() => ({
      tokenId: "tok-web-session",
      scopes: ["message"],
      sessionId: "sess-web-1",
    }));

    const res = await fetch(`${baseUrl}/v1/questions/q-1/answers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...answerBody(), sessionId: "another-spoofed-session" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.code).toBe("OK");
    const arg = execute.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.answeredVia).toBe("web");
    expect(arg.sessionId).toBe("sess-web-1");
  });

  it("falls back to answeredVia cli without sessionId when token sessionId is blank", async () => {
    execute.mockResolvedValue({ outcome: "answered" });

    const res = await postAnswer(answerBody(), "   ");

    expect(res.status).toBe(200);
    const arg = execute.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.answeredVia).toBe("cli");
    expect("sessionId" in arg).toBe(false);
  });

  it("returns 400 BAD_REQUEST when the request body is not a JSON object", async () => {
    const res = await postAnswer([1, 2, 3]);

    expect(res.status).toBe(400);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.result).toBeNull();
    expect(typeof body.operationId).toBe("string");
  });

  it("returns 422 REFUSED with the use case reason when answerOwnerQuestion refuses", async () => {
    execute.mockResolvedValue({
      outcome: "refused",
      reason: "one-way questions are answered only by a signed owner decision",
    });

    const res = await postAnswer(answerBody());

    expect(res.status).toBe(422);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.code).toBe("REFUSED");
    expect(body.result).toEqual({
      reason: "one-way questions are answered only by a signed owner decision",
    });
  });

  it("returns 501 NOT_IMPLEMENTED when answerOwnerQuestion throws Not implemented", async () => {
    execute.mockRejectedValue(new Error("Not implemented: AnswerOwnerQuestionUseCase"));

    const res = await postAnswer(answerBody());

    expect(res.status).toBe(501);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.code).toBe("NOT_IMPLEMENTED");
    expect(body.result).toBeNull();
  });
});
