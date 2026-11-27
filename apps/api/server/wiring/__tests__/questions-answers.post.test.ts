import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createApp, createRouter, toNodeListener } from "h3";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// The handler is imported from the routes tree but the test lives here: Nitro
// and the route-scope walkers treat anything under server/routes as a route.
vi.mock("../operator/composition.js", () => ({
  getOperatorComposition: vi.fn(),
}));

import { getOperatorComposition } from "../operator/composition.js";
import { configurePresentedTokenResolver } from "../presented-token.js";
import answersPostHandler from "../../routes/v1/questions/[id]/answers.post.js";

interface ExecuteRequest {
  questionId?: string;
  answeredVia?: string;
  sessionId?: string;
  [key: string]: unknown;
}

describe("POST /v1/questions/:id/answers attribution", () => {
  let server: Server;
  let baseUrl: string;
  let execute: Mock;

  beforeAll(async () => {
    await import("./nitro-globals.js");
  });

  beforeEach(async () => {
    execute = vi.fn().mockResolvedValue({
      outcome: "answered",
      question: { questionId: "q-1", state: "answered" },
    });
    vi.mocked(getOperatorComposition).mockReturnValue({
      answerOwnerQuestion: { execute },
    } as never);

    const app = createApp();
    const router = createRouter();
    router.post("/v1/questions/:id/answers", answersPostHandler);
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configurePresentedTokenResolver(null);
    vi.restoreAllMocks();
    vi.mocked(getOperatorComposition).mockReset();
  });

  function post(body: string, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/v1/questions/q-1/answers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  function answerBody(): Record<string, unknown> {
    return {
      questionRevision: 1,
      shape: "answer",
      text: "Proceed.",
      // Spoofed attribution that must never reach the use case.
      answeredVia: "web",
      sessionId: "spoofed-session",
    };
  }

  async function firstExecuteRequest(): Promise<ExecuteRequest> {
    return execute.mock.calls[0][0] as ExecuteRequest;
  }

  it("ignores body answeredVia and sessionId when authenticated with shared bearer and records answeredVia cli", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "shared-bearer",
      scopes: ["orchestrate"],
    }));

    const res = await post(JSON.stringify(answerBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("OK");

    const received = await firstExecuteRequest();
    expect(received.answeredVia).toBe("cli");
    expect("sessionId" in received && received.sessionId !== undefined).toBe(false);
    expect(received.questionId).toBe("q-1");
    expect(received.shape).toBe("answer");
  });

  it("derives answeredVia web and sessionId from presentedToken when authenticated with a session token", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "token-1",
      scopes: ["orchestrate"],
      actor: "owner",
      sessionId: "ses-1",
    }));

    const res = await post(JSON.stringify(answerBody()));
    expect(res.status).toBe(200);
    await res.json();

    const received = await firstExecuteRequest();
    expect(received.answeredVia).toBe("web");
    expect(received.sessionId).toBe("ses-1");
  });

  it("falls back to answeredVia cli without sessionId when token sessionId is blank", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "token-1",
      scopes: ["orchestrate"],
      sessionId: "   ",
    }));

    const res = await post(JSON.stringify(answerBody()));
    expect(res.status).toBe(200);
    await res.json();

    const received = await firstExecuteRequest();
    expect(received.answeredVia).toBe("cli");
    expect("sessionId" in received && received.sessionId !== undefined).toBe(false);
  });

  it("returns 400 BAD_REQUEST when the request body is not a JSON object", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "shared-bearer",
      scopes: ["orchestrate"],
    }));

    const res = await post(JSON.stringify(["not", "an", "object"]));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.operationId).toBe("string");
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.result).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns 422 REFUSED with the use case reason when answerOwnerQuestion refuses", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "shared-bearer",
      scopes: ["orchestrate"],
    }));
    execute.mockResolvedValue({
      outcome: "refused",
      reason: "one-way questions are answered only by a signed owner decision",
    });

    const res = await post(JSON.stringify(answerBody()));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(typeof body.operationId).toBe("string");
    expect(body.code).toBe("REFUSED");
    expect(body.result).toEqual({
      reason: "one-way questions are answered only by a signed owner decision",
    });
  });

  it("returns 501 NOT_IMPLEMENTED when answerOwnerQuestion throws Not implemented", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "shared-bearer",
      scopes: ["orchestrate"],
    }));
    execute.mockRejectedValue(new Error("Not implemented: AnswerOwnerQuestionUseCase"));

    const res = await post(JSON.stringify(answerBody()));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(typeof body.operationId).toBe("string");
    expect(body.code).toBe("NOT_IMPLEMENTED");
    expect(body.result).toBeNull();
  });
});
