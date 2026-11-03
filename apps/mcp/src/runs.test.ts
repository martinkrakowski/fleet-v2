// Registry tests for the two /v1/runs read tools (MX5a): each calls exactly
// GET /v1/runs, returns its projection, never leaks host, package or qualifier
// markers, refuses non-empty input and maps client failures to isError.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import { buildRegistry, type FleetRegistry } from "./registry.js";

const MARK_HOST = "host-marker";
const MARK_PKG = "pkg-marker";
const MARK_QUAL = "qual-marker";
const MARK_EXTRA = "extra-marker";

const RUNS_RESULT = {
  outcome: "listed",
  observedAtIso: "2026-11-02T00:00:00Z",
  schedule: {
    observedAtIso: "2026-11-02T00:00:00Z",
    halt: "clear",
    driverLeaseLapsed: false,
    rows: [
      {
        runId: "run-1",
        baseBranch: "main",
        workOrderId: "wo-1",
        tier: "fix",
        state: "running",
        round: 2,
        placement: "running",
        pendingStep: { step: "verify", reconciliation: "unread" },
        park: null,
        leaseLapsed: false,
        packageKeys: [MARK_PKG],
        workOrderUnreadable: false,
        overlapsWith: [],
        slot: { hostName: MARK_HOST, slotIndex: 1 },
        admissionWait: null,
        extraField: MARK_EXTRA,
      },
      {
        runId: "run-2",
        baseBranch: "main",
        workOrderId: "wo-2",
        tier: "fix",
        state: "parked",
        round: 1,
        placement: "parked",
        pendingStep: null,
        park: { reason: "conflict", qualifier: MARK_QUAL },
        leaseLapsed: null,
        packageKeys: null,
        workOrderUnreadable: true,
        overlapsWith: ["run-1"],
        slot: null,
        admissionWait: "cap",
      },
    ],
    queues: [{ baseBranch: "main", runIds: ["run-1", "run-2"] }],
    hosts: [{ hostName: MARK_HOST, slots: [] }],
    admission: { active: 1, inFlight: 0, maxActiveRuns: 4 },
    caps: {
      maxActiveRuns: 4,
      passConcurrency: 2,
      dispatchStaggerMs: 500,
      recordedAtIso: "2026-11-01T00:00:00Z",
    },
    trace: "none",
  },
  truncated: false,
};

const OK_ENVELOPE: ApiClientResult = {
  operationId: "op-1",
  code: "OK",
  result: RUNS_RESULT,
};

const FAILURE: ApiClientResult = {
  ok: false,
  code: "NOT_IMPLEMENTED",
  message: "Not implemented: listLaneRuns.",
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

const TOOL_NAMES = ["fleet_lane_run_list", "fleet_conductor_status"] as const;

describe("the /v1/runs read tools", () => {
  for (const name of TOOL_NAMES) {
    describe(name, () => {
      it("is a read tool with a read scope and the read-only hint", () => {
        const tool = toolNamed(buildRegistry(fakeClient({})), name);
        expect(tool.kind).toBe("read");
        expect(tool.scope).toBe("read");
        expect(tool.annotations.readOnlyHint).toBe(true);
      });

      it("calls exactly GET /v1/runs once with empty input", async () => {
        const client = fakeClient({ "/v1/runs": OK_ENVELOPE });
        const registry = buildRegistry(client);
        const result = await toolNamed(registry, name).handler({});
        expect(client.calls).toEqual([{ method: "GET", path: "/v1/runs" }]);
        expect(result.isError).toBeUndefined();
      });

      it("never leaks a host, package-key, qualifier or extra marker", async () => {
        const client = fakeClient({ "/v1/runs": OK_ENVELOPE });
        const registry = buildRegistry(client);
        const result = await toolNamed(registry, name).handler({});
        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).not.toContain(MARK_HOST);
        expect(text).not.toContain(MARK_PKG);
        expect(text).not.toContain(MARK_QUAL);
        expect(text).not.toContain(MARK_EXTRA);
      });

      it("refuses non-empty input with zero client calls", async () => {
        const client = fakeClient({ "/v1/runs": OK_ENVELOPE });
        const registry = buildRegistry(client);
        const tool = toolNamed(registry, name);
        const result = await tool.handler({ projectId: "p" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
          code: "invalid-input",
          message: "Input does not match the tool schema.",
        });
        expect(client.calls).toEqual([]);
        expect(tool.inputSchema.safeParse({ path: "/v1/x" }).success).toBe(
          false,
        );
      });

      it("maps a client failure to isError with the code kept", async () => {
        const client = fakeClient({ "/v1/runs": FAILURE });
        const registry = buildRegistry(client);
        const result = await toolNamed(registry, name).handler({});
        expect(client.calls).toEqual([{ method: "GET", path: "/v1/runs" }]);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
          code: "NOT_IMPLEMENTED",
        });
      });
    });
  }

  it("fleet_lane_run_list keeps placement, park.reason, slot.slotIndex and queues", async () => {
    const client = fakeClient({ "/v1/runs": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_lane_run_list").handler({});
    const projected = JSON.parse(result.content[0]?.text ?? "");
    expect(projected.result.rows[0].placement).toBe("running");
    expect(projected.result.rows[1].park).toEqual({ reason: "conflict" });
    expect(projected.result.rows[0].slot).toEqual({ slotIndex: 1 });
    expect(projected.result.queues).toEqual([
      { baseBranch: "main", runIds: ["run-1", "run-2"] },
    ]);
  });

  it("fleet_conductor_status counts the sample and carries halt and admission", async () => {
    const client = fakeClient({ "/v1/runs": OK_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_conductor_status").handler(
      {},
    );
    const projected = JSON.parse(result.content[0]?.text ?? "");
    expect(projected.result.liveRuns).toBe(2);
    expect(projected.result.halt).toBe("clear");
    expect(projected.result.admission).toEqual({
      active: 1,
      inFlight: 0,
      maxActiveRuns: 4,
    });
    expect(projected.result.byState).toEqual({ running: 1, parked: 1 });
    expect(projected.result.byPlacement).toEqual({ running: 1, parked: 1 });
    expect(projected.result.byPark).toEqual({ conflict: 1 });
    expect(projected.result.byAdmissionWait).toEqual({ cap: 1 });
  });

  it.each(TOOL_NAMES)(
    "%s passes a non-listed outcome through alone",
    async (name) => {
      const client = fakeClient({
        "/v1/runs": { operationId: "op-1", code: "OK", result: { outcome: "rejected" } },
      });
      const registry = buildRegistry(client);
      const result = await toolNamed(registry, name).handler({});
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        operationId: "op-1",
        code: "OK",
        result: { outcome: "rejected" },
      });
    },
  );
});
