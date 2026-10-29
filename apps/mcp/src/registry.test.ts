// Registry tests with a fake /v1 client (work order item 5): every tool and
// resource calls exactly its route, errors map to isError payloads, no tool
// accepts a path or URL input, and the registry contains only these names.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import {
  buildRegistry,
  FLEET_RESOURCE_NAMES,
  FLEET_RESOURCE_URIS,
  FLEET_TOOL_NAMES,
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
