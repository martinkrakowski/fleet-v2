// Registry tests with a fake /v1 client (work order item 5): every tool and
// resource calls exactly its route, errors map to isError payloads, no tool
// accepts a path or URL input, and the registry contains only these names.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import { previewDigest } from "./dry-run.js";
import {
  buildRegistry,
  FLEET_RESOURCE_NAMES,
  FLEET_RESOURCE_URIS,
  FLEET_TOOL_NAMES,
  toolAnnotationsFor,
  type FleetRegistry,
} from "./registry.js";

const OK_ENVELOPE: ApiClientResult = {
  operationId: "op-1",
  code: "OK",
  result: { outstanding: [{ id: "wo-1" }] },
};

const FAILURE: ApiClientResult = {
  ok: false,
  code: "NOT_IMPLEMENTED",
  message: "Not implemented: readProjectAttention.",
  operationId: "op-2",
};

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
}

function fakeClient(
  responses: Record<string, ApiClientResult>,
): FleetApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const respond = (path: string): ApiClientResult =>
    responses[path] ?? {
      ok: false,
      code: "unmocked-route",
      message: `no canned response for ${path}`,
    };
  return {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return respond(path);
    },
    post: async (path: string, _body: unknown) => {
      calls.push({ method: "POST", path });
      return respond(path);
    },
  };
}

function toolNamed(registry: FleetRegistry, name: string) {
  const tool = registry.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`registry is missing tool ${name}`);
  }
  return tool;
}

function resourceAt(registry: FleetRegistry, uri: string) {
  const resource = registry.resources.find((entry) => entry.uri === uri);
  if (!resource) {
    throw new Error(`registry is missing resource ${uri}`);
  }
  return resource;
}

const PATH_URL_INPUT = {
  path: "/v1/relays",
  url: "http://127.0.0.1:9/v1/relays",
};

describe("buildRegistry", () => {
  it("contains only the lane's tool and resource names", () => {
    const registry = buildRegistry(fakeClient({}));
    expect([...registry.tools.map((tool) => tool.name)]).toEqual([
      ...FLEET_TOOL_NAMES,
    ]);
    expect([...registry.tools.map((tool) => tool.name)]).toEqual([
      "fleet_coordination",
      "fleet_attempt",
      "fleet_attempt_list",
      "fleet_attempt_journal",
      "fleet_work_order",
      "fleet_head_evidence",
      "fleet_question_list",
      "fleet_question",
      "fleet_project_list",
      "fleet_lane_run_list",
      "fleet_conductor_status",
      "fleet_brief_preview",
      "fleet_telemetry_status",
      "fleet_owner_ask",
      "fleet_owner_answer_wait",
      "fleet_context_propose",
    ]);
    expect([...registry.resources.map((resource) => resource.name)]).toEqual([
      ...FLEET_RESOURCE_NAMES,
    ]);
    expect([...registry.resources.map((resource) => resource.uri)]).toEqual([
      ...FLEET_RESOURCE_URIS,
    ]);
    expect([...registry.resources.map((resource) => resource.uri)]).toEqual([
      "fleet://coordination",
      "fleet://capabilities",
      "fleet://attention",
    ]);
  });

  it("gives fleet://attention a description that answers unavailable until Waves is wired", () => {
    const registry = buildRegistry(fakeClient({}));
    const attention = resourceAt(registry, "fleet://attention");
    expect(attention.description).toContain("unavailable");
    expect(attention.description).toContain("Waves");
  });

  it("registers every resource as JSON", () => {
    const registry = buildRegistry(fakeClient({}));
    for (const resource of registry.resources) {
      expect(resource.uri).toMatch(/^fleet:\/\//);
    }
  });
});

describe("fleet_coordination tool", () => {
  it("calls exactly GET /v1/coordination and returns the envelope as pretty JSON", async () => {
    const client = fakeClient({ "/v1/coordination": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_coordination").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/coordination" }]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(OK_ENVELOPE, null, 2) },
    ]);
  });

  it("maps a client failure to isError with code, message and operationId", async () => {
    const client = fakeClient({ "/v1/coordination": FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_coordination").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/coordination" }]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readProjectAttention.",
      operationId: "op-2",
    });
  });

  it("omits operationId from the error payload when the client has none", async () => {
    const client = fakeClient({
      "/v1/coordination": {
        ok: false,
        code: "not-configured",
        message: "FLEET_API_URL is missing.",
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_coordination").handler({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "not-configured",
      message: "FLEET_API_URL is missing.",
    });
  });

  it("accepts no input: the schema rejects a path or URL", () => {
    const registry = buildRegistry(fakeClient({}));
    for (const tool of registry.tools) {
      expect(tool.inputSchema.safeParse(PATH_URL_INPUT).success).toBe(false);
    }
  });

  it("refuses path/URL input without calling the client", async () => {
    const client = fakeClient({ "/v1/coordination": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const handler = toolNamed(registry, "fleet_coordination").handler;
    const result = await handler(PATH_URL_INPUT);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });
});

describe("fleet resources", () => {
  it.each([
    ["fleet://coordination", "/v1/coordination"],
    ["fleet://capabilities", "/v1/capabilities"],
    ["fleet://attention", "/v1/attention"],
  ])("%s calls exactly GET %s", async (uri, route) => {
    const client = fakeClient({ [route]: OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await resourceAt(registry, uri).handler();
    expect(client.calls).toEqual([{ method: "GET", path: route }]);
    expect(result.contents).toEqual([
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(OK_ENVELOPE, null, 2),
      },
    ]);
  });

  it("returns the error payload as contents on a client failure", async () => {
    const client = fakeClient({ "/v1/attention": FAILURE });
    const registry = buildRegistry(client);
    const result = await resourceAt(registry, "fleet://attention").handler();
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/attention" }]);
    expect(result.contents[0]?.uri).toBe("fleet://attention");
    expect(result.contents[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readProjectAttention.",
      operationId: "op-2",
    });
  });
});

/** A valid fleet_owner_ask body, without the tool-refused `askedBy`. */
const OWNER_ASK_BODY = {
  questionId: "q-new",
  title: "Pick a lane model",
  body: "Which lane model should this work order use?",
  options: [
    { id: "o1", label: "Model A", consequence: "Faster, less thorough." },
    { id: "o2", label: "Model B", consequence: "Slower, more thorough." },
  ],
  recommendation: { optionId: "o1", because: "The change is small." },
  doorKind: "one-way" as const,
  idempotencyKey: "idem-owner-ask-1",
};

/** The exact request body the tool builds from OWNER_ASK_BODY. */
const OWNER_ASK_REQUEST_BODY = {
  ...OWNER_ASK_BODY,
  askedBy: "mcp",
};

/** A valid fleet_context_propose body. */
const CONTEXT_PROPOSE_BODY = {
  projectId: "proj-1",
  laneId: "lane-1",
  taskSummary: "Summarize the lane's task.",
};

/** A client that also records POST bodies. */
function recordingPostClient(
  responses: Record<string, ApiClientResult>,
): FleetApiClient & { calls: RecordedCall[]; bodies: unknown[] } {
  const inner = fakeClient(responses);
  const bodies: unknown[] = [];
  return {
    ...inner,
    bodies,
    post: async (path: string, body: unknown) => {
      bodies.push(body);
      return inner.post(path, body);
    },
  };
}

describe("fleet_owner_ask tool", () => {
  it("declares kind mutating, scope message and the mutating annotations", () => {
    const tool = toolNamed(buildRegistry(fakeClient({})), "fleet_owner_ask");
    expect(tool.kind).toBe("mutating");
    expect(tool.scope).toBe("message");
    expect(tool.annotations).toEqual(toolAnnotationsFor("mutating"));
  });

  it("defaults to a dry run: returns the digest of the exact request body without calling /v1", async () => {
    const client = fakeClient({ "/v1/questions": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler(
      OWNER_ASK_BODY,
    );
    expect(client.calls).toEqual([]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      dryRun: true,
      validated: "schema-only",
      previewDigest: previewDigest(OWNER_ASK_REQUEST_BODY),
      requestBody: OWNER_ASK_REQUEST_BODY,
    });
  });

  it("refuses an extra askedBy key without calling the client", async () => {
    const client = fakeClient({ "/v1/questions": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler({
      ...OWNER_ASK_BODY,
      askedBy: "owner",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses path and url keys without calling the client", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler({
      ...OWNER_ASK_BODY,
      path: "/v1/relays",
      url: "http://127.0.0.1:9/v1/relays",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses a write without preview_digest with digest-mismatch and no post", async () => {
    const client = fakeClient({ "/v1/questions": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler({
      ...OWNER_ASK_BODY,
      dry_run: false,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "digest-mismatch",
      message:
        "preview_digest is required and must equal the dry-run digest of the exact request body.",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses a write whose body no longer matches the echoed digest", async () => {
    const client = fakeClient({ "/v1/questions": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler({
      ...OWNER_ASK_BODY,
      title: "Mutated after the dry run",
      dry_run: false,
      preview_digest: previewDigest(OWNER_ASK_REQUEST_BODY),
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "digest-mismatch",
      message:
        "preview_digest is required and must equal the dry-run digest of the exact request body.",
    });
    expect(client.calls).toEqual([]);
  });

  it("posts the exact body once and projects the result when the digest matches", async () => {
    const client = recordingPostClient({
      "/v1/questions": {
        operationId: "op-ask",
        code: "OK",
        result: {
          outcome: "asked",
          question: { questionId: "q-new", state: "open", title: "T" },
        },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler({
      ...OWNER_ASK_BODY,
      dry_run: false,
      preview_digest: previewDigest(OWNER_ASK_REQUEST_BODY),
    });
    expect(client.calls).toEqual([{ method: "POST", path: "/v1/questions" }]);
    expect(client.bodies).toEqual([OWNER_ASK_REQUEST_BODY]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      operationId: "op-ask",
      code: "OK",
      result: {
        outcome: "asked",
        question: {
          questionId: "q-new",
          revision: null,
          state: "open",
          doorKind: null,
          askedBy: null,
          askedAt: null,
          expiresAt: null,
          linkedRequestId: null,
          blocks: [],
          recommendation: { optionId: null },
          answer: null,
          asked: {
            source: "owner-question",
            askedBy: null,
            title: "T",
            body: null,
            options: [],
            recommendationBecause: null,
          },
        },
      },
    });
  });

  it("returns a client failure unchanged after the one post", async () => {
    const client = fakeClient({ "/v1/questions": FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_owner_ask").handler({
      ...OWNER_ASK_BODY,
      dry_run: false,
      preview_digest: previewDigest(OWNER_ASK_REQUEST_BODY),
    });
    expect(client.calls).toEqual([{ method: "POST", path: "/v1/questions" }]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readProjectAttention.",
      operationId: "op-2",
    });
  });

  it("rate limits the 7th call within a minute", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const handler = toolNamed(registry, "fleet_owner_ask").handler;
    for (let i = 0; i < 6; i += 1) {
      const result = await handler(OWNER_ASK_BODY);
      expect(result.isError).toBeUndefined();
    }
    const refused = await handler(OWNER_ASK_BODY);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]?.text ?? "")).toEqual({
      code: "rate-limited",
      message: "Tool fleet_owner_ask is over its rate limit.",
    });
    expect(client.calls).toEqual([]);
  });
});

describe("fleet_context_propose tool", () => {
  it("declares kind mutating, scope message and the mutating annotations", () => {
    const tool = toolNamed(buildRegistry(fakeClient({})), "fleet_context_propose");
    expect(tool.kind).toBe("mutating");
    expect(tool.scope).toBe("message");
    expect(tool.annotations).toEqual(toolAnnotationsFor("mutating"));
  });

  it("defaults to a dry run: returns the digest of the exact request body without calling /v1", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_context_propose").handler(
      CONTEXT_PROPOSE_BODY,
    );
    expect(client.calls).toEqual([]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      dryRun: true,
      validated: "schema-only",
      previewDigest: previewDigest(CONTEXT_PROPOSE_BODY),
      requestBody: CONTEXT_PROPOSE_BODY,
    });
  });

  it("refuses an extra pathPrefixes key without calling the client", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_context_propose").handler({
      ...CONTEXT_PROPOSE_BODY,
      pathPrefixes: ["src/"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses a write without preview_digest and one with a mutated body", async () => {
    const client = fakeClient({ "/v1/knowledge/proposals": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const handler = toolNamed(registry, "fleet_context_propose").handler;
    const missing = await handler({
      ...CONTEXT_PROPOSE_BODY,
      dry_run: false,
    });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0]?.text ?? "")).toEqual({
      code: "digest-mismatch",
      message:
        "preview_digest is required and must equal the dry-run digest of the exact request body.",
    });
    const mutated = await handler({
      ...CONTEXT_PROPOSE_BODY,
      taskSummary: "Mutated after the dry run.",
      dry_run: false,
      preview_digest: previewDigest(CONTEXT_PROPOSE_BODY),
    });
    expect(mutated.isError).toBe(true);
    expect(JSON.parse(mutated.content[0]?.text ?? "")).toEqual({
      code: "digest-mismatch",
      message:
        "preview_digest is required and must equal the dry-run digest of the exact request body.",
    });
    expect(client.calls).toEqual([]);
  });

  it("posts the exact body once and projects the result when the digest matches", async () => {
    const client = recordingPostClient({
      "/v1/knowledge/proposals": {
        operationId: "op-propose",
        code: "OK",
        result: {
          outcome: "proposed",
          proposals: [
            {
              proposalId: "pr-1",
              knowledgeEntryId: "ke-1",
              version: "2",
              claimText: "Claim",
              proposedBecause: "Matched",
            },
          ],
          rankingContextRef: "rc-1",
        },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_context_propose").handler({
      ...CONTEXT_PROPOSE_BODY,
      dry_run: false,
      preview_digest: previewDigest(CONTEXT_PROPOSE_BODY),
    });
    expect(client.calls).toEqual([
      { method: "POST", path: "/v1/knowledge/proposals" },
    ]);
    expect(client.bodies).toEqual([CONTEXT_PROPOSE_BODY]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      operationId: "op-propose",
      code: "OK",
      result: {
        outcome: "proposed",
        proposals: [
          {
            proposalId: "pr-1",
            knowledgeEntryId: "ke-1",
            version: "2",
            claimText: "Claim",
            proposedBecause: "Matched",
          },
        ],
        rankingContextRef: "rc-1",
      },
    });
  });

  it("returns a client failure unchanged after the one post", async () => {
    const client = fakeClient({ "/v1/knowledge/proposals": FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_context_propose").handler({
      ...CONTEXT_PROPOSE_BODY,
      dry_run: false,
      preview_digest: previewDigest(CONTEXT_PROPOSE_BODY),
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readProjectAttention.",
      operationId: "op-2",
    });
  });

  it("rate limits the 7th call within a minute", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const handler = toolNamed(registry, "fleet_context_propose").handler;
    for (let i = 0; i < 6; i += 1) {
      const result = await handler(CONTEXT_PROPOSE_BODY);
      expect(result.isError).toBeUndefined();
    }
    const refused = await handler(CONTEXT_PROPOSE_BODY);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]?.text ?? "")).toEqual({
      code: "rate-limited",
      message: "Tool fleet_context_propose is over its rate limit.",
    });
    expect(client.calls).toEqual([]);
  });
});

describe("fleet_owner_answer_wait tool", () => {
  /**
   * A fake clock advanced only by `sleep`: `now` starts at 0 for each test,
   * so the wait budget is deterministic without real delays.
   */
  function waitOptions() {
    let clock = 0;
    return {
      waitPollIntervalMs: 10,
      waitMaxMs: 25,
      sleep: async () => {
        clock += 10;
      },
      now: () => clock,
    };
  }

  function queueClient(
    responses: ApiClientResult[],
  ): FleetApiClient & { gets: string[] } {
    const gets: string[] = [];
    let index = 0;
    return {
      gets,
      get: async (path: string) => {
        gets.push(path);
        const response = responses[index];
        index += 1;
        return (
          response ?? {
            ok: false,
            code: "queue-exhausted",
            message: "no queued response",
          }
        );
      },
      post: async () => ({
        ok: false,
        code: "unused",
        message: "the wait tool never posts",
      }),
    };
  }

  it("declares kind read, scope read and the read annotations", () => {
    const tool = toolNamed(
      buildRegistry(fakeClient({}), waitOptions()),
      "fleet_owner_answer_wait",
    );
    expect(tool.kind).toBe("read");
    expect(tool.scope).toBe("read");
    expect(tool.annotations).toEqual(toolAnnotationsFor("read"));
  });

  it("refuses an extra key without calling the client", async () => {
    const client = queueClient([]);
    const registry = buildRegistry(client, waitOptions());
    const result = await toolNamed(registry, "fleet_owner_answer_wait").handler({
      questionId: "q-1",
      path: "/v1/relays",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.gets).toEqual([]);
  });

  it("returns an answered question after exactly one GET, without sleeping", async () => {
    const client = queueClient([
      {
        operationId: "op-wait",
        code: "OK",
        result: {
          outcome: "found",
          question: { questionId: "q-1", state: "answered" },
        },
      },
    ]);
    const registry = buildRegistry(client, waitOptions());
    const result = await toolNamed(registry, "fleet_owner_answer_wait").handler({
      questionId: "q-1",
    });
    expect(client.gets).toEqual(["/v1/questions/q-1"]);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.result.outcome).toBe("found");
    expect(parsed.result.question.state).toBe("answered");
    expect(parsed.result.question.answer).toBeNull();
  });

  it("returns not-found immediately after one GET", async () => {
    const client = queueClient([
      { operationId: "op-wait", code: "OK", result: { outcome: "not-found" } },
    ]);
    const registry = buildRegistry(client, waitOptions());
    const result = await toolNamed(registry, "fleet_owner_answer_wait").handler({
      questionId: "q-missing",
    });
    expect(client.gets).toEqual(["/v1/questions/q-missing"]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      operationId: "op-wait",
      code: "OK",
      result: { outcome: "not-found", question: null },
    });
  });

  it("stops polling on the first client failure", async () => {
    const client = queueClient([
      {
        ok: false,
        code: "timeout",
        message: "API unreachable: request timed out.",
      },
      { operationId: "op-2", code: "OK", result: { outcome: "found" } },
    ]);
    const registry = buildRegistry(client, waitOptions());
    const result = await toolNamed(registry, "fleet_owner_answer_wait").handler({
      questionId: "q-1",
    });
    expect(client.gets).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "timeout",
      message: "API unreachable: request timed out.",
    });
  });

  it("returns still-open after bounded polls, never answered", async () => {
    const openResponse: ApiClientResult = {
      operationId: "op-wait",
      code: "OK",
      result: {
        outcome: "found",
        question: { questionId: "q-1", state: "open" },
      },
    };
    const client = queueClient([openResponse, openResponse, openResponse]);
    const registry = buildRegistry(client, waitOptions());
    const result = await toolNamed(registry, "fleet_owner_answer_wait").handler({
      questionId: "q-1",
    });
    expect(client.gets).toHaveLength(3);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      operationId: "op-wait",
      code: "OK",
      result: {
        outcome: "still-open",
        questionId: "q-1",
        question: {
          questionId: "q-1",
          revision: null,
          state: "open",
          doorKind: null,
          askedBy: null,
          askedAt: null,
          expiresAt: null,
          linkedRequestId: null,
          blocks: [],
          recommendation: { optionId: null },
          answer: null,
          asked: {
            source: "owner-question",
            askedBy: null,
            title: null,
            body: null,
            options: [],
            recommendationBecause: null,
          },
        },
      },
    });
  });

  it("charges slow polls against the budget and never polls once it is spent", async () => {
    const openResponse: ApiClientResult = {
      operationId: "op-wait",
      code: "OK",
      result: {
        outcome: "found",
        question: { questionId: "q-1", state: "open" },
      },
    };
    const answeredResponse: ApiClientResult = {
      operationId: "op-wait",
      code: "OK",
      result: {
        outcome: "found",
        question: { questionId: "q-1", state: "answered" },
      },
    };
    const client = queueClient([openResponse, answeredResponse]);
    let clock = 0;
    const slowGet = {
      ...client,
      get: async (path: string) => {
        clock += 60;
        return client.get(path);
      },
    };
    const registry = buildRegistry(slowGet, {
      waitPollIntervalMs: 15,
      waitMaxMs: 50,
      sleep: async () => undefined,
      now: () => clock,
    });
    const result = await toolNamed(registry, "fleet_owner_answer_wait").handler({
      questionId: "q-1",
    });
    // The first poll alone spends the budget: no second poll starts, so the
    // queued answered response is never fetched and `still-open` is returned.
    expect(client.gets).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.operationId).toBe("op-wait");
    expect(parsed.result.outcome).toBe("still-open");
    expect(parsed.result.question.state).toBe("open");
  });

  it("allows one wait at a time and releases the slot afterwards", async () => {
    let release: ((result: ApiClientResult) => void) | undefined;
    let immediate: ApiClientResult | undefined;
    const client: FleetApiClient & { gets: string[] } = {
      gets: [],
      get: (_path: string) => {
        client.gets.push("/v1/questions/q-1");
        if (immediate !== undefined) {
          const response = immediate;
          immediate = undefined;
          return Promise.resolve(response);
        }
        return new Promise<ApiClientResult>((resolve) => {
          release = resolve;
        });
      },
      post: async () => ({
        ok: false,
        code: "unused",
        message: "the wait tool never posts",
      }),
    };
    const registry = buildRegistry(client, waitOptions());
    const handler = toolNamed(registry, "fleet_owner_answer_wait").handler;
    const first = handler({ questionId: "q-1" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const second = await handler({ questionId: "q-1" });
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0]?.text ?? "")).toEqual({
      code: "rate-limited",
      message: "Tool fleet_owner_answer_wait is over its rate limit.",
    });
    release?.({
      operationId: "op-wait",
      code: "OK",
      result: {
        outcome: "found",
        question: { questionId: "q-1", state: "answered" },
      },
    });
    const firstResult = await first;
    expect(firstResult.isError).toBeUndefined();
    expect(JSON.parse(firstResult.content[0]?.text ?? "").result.outcome).toBe(
      "found",
    );
    immediate = {
      operationId: "op-wait-3",
      code: "OK",
      result: {
        outcome: "found",
        question: { questionId: "q-1", state: "answered" },
      },
    };
    const third = await handler({ questionId: "q-1" });
    expect(third.isError).toBeUndefined();
    expect(JSON.parse(third.content[0]?.text ?? "").result.outcome).toBe(
      "found",
    );
  });
});
