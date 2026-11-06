// Registry tests for the fleet_telemetry_status tool (MX8): it is a read tool
// with a read scope and the read-only hint, calls exactly GET
// /v1/telemetry/status, refuses non-empty input before any client call,
// projects only the allow-list fields (dropping endpoint, token, salt, project
// name, host names and any future field), nulls fingerprints that are not 8
// lowercase hex, drops non-finite counter entries and maps client failures to
// isError.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import { buildRegistry, type FleetRegistry } from "./registry.js";

const STATUS_ROUTE = "/v1/telemetry/status";

const MARK_ENDPOINT = "https://otel.example.invalid/v1/traces";
const MARK_TOKEN = "token-marker";
const MARK_SALT = "salt-marker";
const MARK_PROJECT = "project-marker";
const MARK_HOST = "host-marker";
const MARK_EXTRA = "extra-marker";

const STATUS_RESULT = {
  outcome: "status",
  enabled: true,
  saltFingerprint: "a1b2c3d4",
  recordedSaltFingerprint: null,
  fingerprintMatch: null,
  schemaVersion: 1,
  hashPrefix: "fleet-telemetry/v1",
  route: "collector",
  lastExportAtIso: null,
  spans: { pending: 0, "exported@collector": 2 },
  counters: { "queue-drops": 0, network: 1 },
  endpoint: MARK_ENDPOINT,
  token: MARK_TOKEN,
  salt: MARK_SALT,
  projectName: MARK_PROJECT,
  hostName: MARK_HOST,
  extraField: MARK_EXTRA,
};

const OK_ENVELOPE: ApiClientResult = {
  operationId: "op-telemetry-status",
  code: "OK",
  result: STATUS_RESULT,
};

const FAILURE: ApiClientResult = {
  ok: false,
  code: "NOT_IMPLEMENTED",
  message: "Not implemented: telemetry status.",
  operationId: "op-telemetry-fail",
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

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

describe("fleet_telemetry_status tool", () => {
  it("is a read tool with a read scope and the read-only hint", () => {
    const tool = toolNamed(
      buildRegistry(fakeClient({})),
      "fleet_telemetry_status",
    );
    expect(tool.kind).toBe("read");
    expect(tool.scope).toBe("read");
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("calls exactly GET /v1/telemetry/status once with empty input", async () => {
    const client = fakeClient({ [STATUS_ROUTE]: OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_telemetry_status").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: STATUS_ROUTE }]);
    expect(result.isError).toBeUndefined();
  });

  it("refuses non-empty input with zero client calls", async () => {
    const client = fakeClient({ [STATUS_ROUTE]: OK_ENVELOPE });
    const registry = buildRegistry(client);
    const tool = toolNamed(registry, "fleet_telemetry_status");
    const result = await tool.handler({ projectId: "p" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("drops everything outside the allow-list", async () => {
    const client = fakeClient({ [STATUS_ROUTE]: OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_telemetry_status").handler({});
    const text = textOf(result);
    for (const marker of [
      MARK_ENDPOINT,
      MARK_TOKEN,
      MARK_SALT,
      MARK_PROJECT,
      MARK_HOST,
      MARK_EXTRA,
    ]) {
      expect(text).not.toContain(marker);
    }
    const parsed = JSON.parse(text) as { result: unknown };
    expect(parsed.result).toEqual({
      outcome: "status",
      enabled: true,
      saltFingerprint: "a1b2c3d4",
      recordedSaltFingerprint: null,
      fingerprintMatch: null,
      schemaVersion: 1,
      hashPrefix: "fleet-telemetry/v1",
      route: "collector",
      lastExportAtIso: null,
      spans: { pending: 0, "exported@collector": 2 },
      counters: { "queue-drops": 0, network: 1 },
    });
  });

  it("nulls a fingerprint that is not 8 lowercase hex", async () => {
    const client = fakeClient({
      [STATUS_ROUTE]: {
        operationId: "op-1",
        code: "OK",
        result: {
          ...STATUS_RESULT,
          saltFingerprint: "ABC12345",
          recordedSaltFingerprint: "zz",
        },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_telemetry_status").handler({});
    const parsed = JSON.parse(textOf(result)) as {
      result: { saltFingerprint: string | null; recordedSaltFingerprint: string | null };
    };
    expect(parsed.result.saltFingerprint).toBeNull();
    expect(parsed.result.recordedSaltFingerprint).toBeNull();
  });

  it("drops non-finite counters and keeps numeric ones", async () => {
    const client = fakeClient({
      [STATUS_ROUTE]: {
        operationId: "op-1",
        code: "OK",
        result: {
          ...STATUS_RESULT,
          counters: { "queue-drops": 0, network: "nope", wrong: NaN },
        },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_telemetry_status").handler({});
    const parsed = JSON.parse(textOf(result)) as { result: { counters: Record<string, number> } };
    expect(parsed.result.counters).toEqual({ "queue-drops": 0 });
  });

  it("maps a client failure to isError with the code kept", async () => {
    const client = fakeClient({ [STATUS_ROUTE]: FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_telemetry_status").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: STATUS_ROUTE }]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: telemetry status.",
      operationId: "op-telemetry-fail",
    });
  });
});
