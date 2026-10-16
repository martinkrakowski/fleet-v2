import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as h3 from "h3";
import {
  createApp,
  createRouter,
  toNodeListener,
  type EventHandler,
} from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerQuestionRepositoryAdapter } from "@fleet/operator-coordination";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import { getOperatorComposition } from "../operator/composition.js";

// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so stub them globally before loading route modules.
for (const [key, value] of Object.entries(h3)) {
  if (typeof value === "function") {
    vi.stubGlobal(key, value);
  }
}

const VALID_TOKEN = "a".repeat(32);

function twoWayQuestionBody() {
  return {
    questionId: "q-route-two-way",
    askedBy: "lane-q3",
    title: "Choose a rollout door",
    body: "The plan is paused until this is decided.",
    options: [
      { id: "rollout-now", label: "Roll out now", consequence: "The lane proceeds." },
      { id: "hold", label: "Hold", consequence: "The lane waits." },
    ],
    recommendation: { optionId: "rollout-now", because: "The checks are green." },
    doorKind: "two-way",
  };
}

function oneWayQuestionRecord(nowIso: string) {
  return {
    questionId: "q-route-one-way",
    revision: 1,
    askedBy: "lane-q3",
    title: "Signed decision pending",
    body: "Waiting on a signed owner decision.",
    options: [
      { id: "approve", label: "Approve", consequence: "The lane proceeds." },
      { id: "decline", label: "Decline", consequence: "The lane stops." },
    ],
    recommendation: { optionId: "approve", because: "Default recommendation." },
    doorKind: "one-way" as const,
    linkedRequestId: "req-route-1",
    blocks: [],
    state: "open" as const,
    askedAt: nowIso,
    expiresAt: null,
    answer: null,
    acknowledgement: null,
  };
}

describe("owner question routes", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  let questionsGetHandler: EventHandler;
  let questionGetHandler: EventHandler;
  let questionsPostHandler: EventHandler;
  let answersPostHandler: EventHandler;
  let acknowledgementPostHandler: EventHandler;
  let syncPostHandler: EventHandler;
  let expirePostHandler: EventHandler;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(h3)) {
      if (typeof value === "function") {
        vi.stubGlobal(key, value);
      }
    }
    questionsGetHandler = (await import("../../routes/v1/questions/index.get.js"))
      .default;
    questionGetHandler = (await import("../../routes/v1/questions/[id].get.js"))
      .default;
    questionsPostHandler = (await import("../../routes/v1/questions/index.post.js"))
      .default;
    answersPostHandler = (
      await import("../../routes/v1/questions/[id]/answers.post.js")
    ).default;
    acknowledgementPostHandler = (
      await import("../../routes/v1/questions/[id]/acknowledgement.post.js")
    ).default;
    syncPostHandler = (await import("../../routes/v1/questions/sync.post.js")).default;
    expirePostHandler = (await import("../../routes/v1/questions/expire.post.js"))
      .default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-owner-questions-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.get("/v1/questions", questionsGetHandler);
    router.get("/v1/questions/:id", questionGetHandler);
    router.post("/v1/questions", questionsPostHandler);
    router.post("/v1/questions/:id/answers", answersPostHandler);
    router.post("/v1/questions/:id/acknowledgement", acknowledgementPostHandler);
    router.post("/v1/questions/sync", syncPostHandler);
    router.post("/v1/questions/expire", expirePostHandler);
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
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    vi.restoreAllMocks();
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}` };
  }

  async function seedQuestion(record: ReturnType<typeof oneWayQuestionRecord>): Promise<void> {
    // The same store the composition owns: the adapter persists to
    // `<stateDir>/owner-questions.json` and every read reloads from disk.
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(record, 0);
  }

  it("refuses requests without a bearer token with 401", async () => {
    const res = await fetch(`${baseUrl}/v1/questions`);
    expect(res.status).toBe(401);
  });

  it("asks a two-way question; the clock alone supplies askedAt", async () => {
    const res = await fetch(`${baseUrl}/v1/questions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...twoWayQuestionBody(), nowIso: "2001-01-01T00:00:00Z" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("OK");
    expect(body.result.outcome).toBe("asked");
    expect(body.result.question.state).toBe("open");
    expect(body.result.question.askedAt).not.toBe("2001-01-01T00:00:00Z");
  });

  it("lists questions and reads one by id; unknown id is a 404 envelope", async () => {
    await fetch(`${baseUrl}/v1/questions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(twoWayQuestionBody()),
    });

    const list = await fetch(`${baseUrl}/v1/questions?state=open`, {
      headers: authHeaders(),
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.result.questions).toHaveLength(1);

    const read = await fetch(`${baseUrl}/v1/questions/q-route-two-way`, {
      headers: authHeaders(),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.result.outcome).toBe("found");

    const missing = await fetch(`${baseUrl}/v1/questions/q-unknown`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody.code).toBe("NOT_FOUND");
    expect(missingBody.result).toBeNull();
  });

  it("answers a two-way question with answeredVia forced to cli, and refuses a one-way question", async () => {
    await fetch(`${baseUrl}/v1/questions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(twoWayQuestionBody()),
    });

    const answered = await fetch(`${baseUrl}/v1/questions/q-route-two-way/answers`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        questionRevision: 1,
        shape: "accept",
        answeredVia: "signed-decision",
      }),
    });
    expect(answered.status).toBe(200);
    const answeredBody = await answered.json();
    expect(answeredBody.result.outcome).toBe("answered");
    expect(answeredBody.result.replayed).toBe(false);
    expect(answeredBody.result.question.answer.answeredVia).toBe("cli");

    await seedQuestion(oneWayQuestionRecord(new Date().toISOString()));
    const refused = await fetch(`${baseUrl}/v1/questions/q-route-one-way/answers`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ questionRevision: 1, shape: "accept", answeredVia: "cli" }),
    });
    expect(refused.status).toBe(422);
    const refusedBody = await refused.json();
    expect(refusedBody.code).toBe("REFUSED");
    expect(refusedBody.result.reason).toContain("one-way");
  });

  it("acknowledges an answered question", async () => {
    await fetch(`${baseUrl}/v1/questions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(twoWayQuestionBody()),
    });
    await fetch(`${baseUrl}/v1/questions/q-route-two-way/answers`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ questionRevision: 1, shape: "accept" }),
    });

    const res = await fetch(`${baseUrl}/v1/questions/q-route-two-way/acknowledgement`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ by: "lane-q3" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.outcome).toBe("acknowledged");
    expect(body.result.question.state).toBe("acknowledged");
  });

  it("syncs and expires without writing any coordination request", async () => {
    const saveRequest = vi.spyOn(
      getOperatorComposition().coordinationRequestRepository,
      "saveRequest",
    );

    const sync = await fetch(`${baseUrl}/v1/questions/sync`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sync.status).toBe(200);
    const syncBody = await sync.json();
    expect(syncBody.result.outcome).toBe("synced");
    expect(syncBody.result.answered).toEqual([]);

    const expire = await fetch(`${baseUrl}/v1/questions/expire`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(expire.status).toBe(200);
    const expireBody = await expire.json();
    expect(expireBody.result.outcome).toBe("expired");
    expect(expireBody.result.expired).toEqual([]);

    expect(saveRequest).not.toHaveBeenCalled();
  });
});
