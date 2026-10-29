// Attempt and work-order read tool tests (MX2-1; plan §3.7): each tool calls
// exactly its /v1 route once with the id encoded, invalid input is refused
// before any client call, results are projections (dropped fields never appear),
// and client failures map to isError with code/message/operationId.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import {
  buildRegistry,
  FLEET_TOOL_NAMES,
  type FleetRegistry,
} from "./registry.js";

const ATTEMPT_ID = "attempt-example-1";
const WORK_ORDER_ID = "wo-example-1";
const PROJECT_ID = "project-example-1";
const MODEL = "example-provider/glm-5.3";
const HEAD_SHA = "1111222233334444555566667777888899990000";

const FAILURE: ApiClientResult = {
  ok: false,
  code: "NOT_IMPLEMENTED",
  message: "Not implemented: readAttempt.",
  operationId: "op-attempt-fail",
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

/** A full attempt record carrying a marker in every dropped field. */
const MARKER_ATTEMPT = {
  id: ATTEMPT_ID,
  workOrderId: WORK_ORDER_ID,
  kind: "initial",
  fixNumber: 1,
  priorAttemptId: null,
  worktreePath: "/MARKER-PATH",
  baseCommit: HEAD_SHA,
  state: "running",
  revision: 3,
  dispatchRevision: 1,
  outcome: null,
  briefDigest: "MARKER-DIGEST",
  briefPackagePath: "MARKER-BRIEF",
  sessionId: "MARKER-SESSION",
  completionReceipt: { status: "MARKER-RECEIPT" },
  artifacts: { marker: "MARKER-ARTIFACTS" },
  runner: {
    kind: "opencode",
    remotePort: 4999,
    host: "MARKER-HOST",
    hostName: "MARKER-HOSTNAME",
    agent: "agent-example",
    model: MODEL,
    variant: "v1",
  },
  seatOverride: {
    model: "MARKER-SEAT-MODEL",
    agent: "MARKER-SEAT-AGENT",
    variant: null,
    reason: "MARKER-SEAT-REASON",
    setBy: "MARKER-SEAT-SETBY",
    expiresAtIso: "2026-10-02T00:00:00.000Z",
  },
  usage: {
    source: "opencode-db",
    readAtIso: "2026-10-01T00:10:00.000Z",
    sessionId: "MARKER-USAGE-SESSION",
    steps: 5,
    wallSeconds: 12,
    tokensInput: 100,
    tokensOutput: 200,
    tokensReasoning: 50,
    tokensCacheRead: 10,
    tokensCacheWrite: 20,
    costUsd: 0.01,
    model: MODEL,
    agent: "MARKER-USAGE-AGENT",
    reason: "MARKER-REASON",
  },
  stopReason: "completed",
  seatPlan: { name: "MARKER-PLAN" },
  seatSelection: {
    role: "primary",
    seatIndex: 0,
    seatId: "seat-1",
    model: MODEL,
    tool: "opencode",
    variant: null,
    agent: null,
  },
  reviewerSeat: "MARKER-REVIEWER",
  ownerDecisionReferences: ["MARKER-DECISION"],
  createdAtIso: "2026-10-01T00:00:00.000Z",
  updatedAtIso: "2026-10-01T00:00:00.000Z",
};

const ATTEMPT_ENVELOPE: ApiClientResult = {
  operationId: "op-attempt",
  code: "OK",
  result: { outcome: "found", attempt: MARKER_ATTEMPT },
};

const LIST_ENVELOPE: ApiClientResult = {
  operationId: "op-list",
  code: "OK",
  result: {
    outcome: "listed",
    attempts: [
      {
        attempt: MARKER_ATTEMPT,
        workOrder: {
          id: WORK_ORDER_ID,
          projectId: PROJECT_ID,
          taskId: "task-example-1",
          laneId: "lane-example-1",
          repository: "MARKER-REPO",
          ownedPaths: ["MARKER-OWNED"],
        },
        reservation: {
          hostId: "MARKER-HOSTID",
          hostName: "MARKER-HOSTNAME",
          slotIndex: 2,
        },
      },
    ],
    total: 1,
    truncated: false,
  },
};

const JOURNAL_ENVELOPE: ApiClientResult = {
  operationId: "op-journal",
  code: "OK",
  result: {
    outcome: "listed",
    attemptId: ATTEMPT_ID,
    entries: [
      {
        id: "journal-example-1",
        attemptId: ATTEMPT_ID,
        workOrderId: WORK_ORDER_ID,
        action: "dispatch",
        baseCommit: "MARKER-BASECOMMIT",
        recordedAtIso: "2026-10-01T00:05:00.000Z",
        status: "completed",
        sessionId: "MARKER-JOURNAL-SESSION",
        detail: "MARKER-DETAIL",
        stopReason: "completed",
        observedSessionIds: ["MARKER-OBSERVED"],
        authorizedBy: "policy:autoMerge@rev1",
      },
    ],
  },
};

const WORK_ORDER_ENVELOPE: ApiClientResult = {
  operationId: "op-work-order",
  code: "OK",
  result: {
    outcome: "found",
    workOrder: {
      id: WORK_ORDER_ID,
      projectId: PROJECT_ID,
      taskId: "task-example-1",
      laneId: "lane-example-1",
      repository: "MARKER-REPO",
      baseCommit: HEAD_SHA,
      ownedPaths: ["MARKER-OWNED"],
      policyRevision: "0",
      risk: "high",
      state: "open",
      revision: 2,
      prerequisiteWorkOrderIds: ["wo-example-2"],
      createdAtIso: "2026-10-01T00:00:00.000Z",
      updatedAtIso: "2026-10-01T00:00:00.000Z",
      planRef: { revision: 1, note: "MARKER-PLANREF" },
    },
    attempts: [MARKER_ATTEMPT],
    activeReservations: [
      {
        id: "res-example-1",
        attemptId: ATTEMPT_ID,
        hostId: "MARKER-HOSTID",
        slotIndex: 0,
        held: true,
        seatTool: "opencode",
        hostName: "MARKER-HOSTNAME",
        hostKind: "opencode",
        transport: "ssh",
        sshAlias: "MARKER-SSH",
        port: 4999,
        worktreePath: "/MARKER-PATH",
        reservedAtIso: "2026-10-01T00:00:00.000Z",
        releasedAtIso: null,
      },
    ],
  },
};

describe("fleet_attempt", () => {
  it("calls exactly GET /v1/attempts/attempt-example-1 with the id encoded", async () => {
    const client = fakeClient({ "/v1/attempts/attempt-example-1": ATTEMPT_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt").handler({
      attemptId: ATTEMPT_ID,
    });
    expect(client.calls).toEqual([
      { method: "GET", path: "/v1/attempts/attempt-example-1" },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("returns a projection: marker fields and the runner port are dropped, kept fields are present", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1": ATTEMPT_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt").handler({
      attemptId: ATTEMPT_ID,
    });
    const parsed = JSON.parse(textOf(result));
    expect(textOf(result)).not.toContain("MARKER");
    expect(textOf(result)).not.toContain("4999");
    const attempt = parsed.result.attempt;
    expect(attempt.id).toBe(ATTEMPT_ID);
    expect(attempt.workOrderId).toBe(WORK_ORDER_ID);
    expect(attempt.kind).toBe("initial");
    expect(attempt.fixNumber).toBe(1);
    expect(attempt.state).toBe("running");
    expect(attempt.stopReason).toBe("completed");
    expect(attempt.baseCommit).toBe(HEAD_SHA);
    expect(attempt.worktreePath).toBeUndefined();
    expect(attempt.seat.seatId).toBe("seat-1");
    expect(attempt.seat.model).toBe(MODEL);
    expect(attempt.runner.kind).toBe("opencode");
    expect(attempt.runner.model).toBe(MODEL);
    expect(attempt.runner.host).toBeUndefined();
    expect(attempt.runner.hostName).toBeUndefined();
    expect(attempt.runner.remotePort).toBeUndefined();
    expect(attempt.usage.steps).toBe(5);
    expect(attempt.usage.model).toBe(MODEL);
    expect(attempt.usage.reason).toBeUndefined();
    expect(attempt.usage.sessionId).toBeUndefined();
  });

  it("passes a not-found outcome through as { outcome, attemptId } only", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1": {
        operationId: "op-attempt",
        code: "OK",
        result: { outcome: "not-found", attemptId: ATTEMPT_ID },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt").handler({
      attemptId: ATTEMPT_ID,
    });
    expect(JSON.parse(textOf(result)).result).toEqual({
      outcome: "not-found",
      attemptId: ATTEMPT_ID,
    });
  });

  it("drops the reason on an unknown outcome", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1": {
        operationId: "op-attempt",
        code: "OK",
        result: { outcome: "unknown", attemptId: ATTEMPT_ID, reason: "MARKER-REASON" },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt").handler({
      attemptId: ATTEMPT_ID,
    });
    expect(JSON.parse(textOf(result)).result).toEqual({
      outcome: "unknown",
      attemptId: ATTEMPT_ID,
    });
  });

  it.each([
    [{ attemptId: "/" }],
    [{ attemptId: ".." }],
    [{ attemptId: " " }],
    [{ attemptId: ATTEMPT_ID, path: "/v1/relays" }],
  ])("refuses invalid input without calling the client", async (input) => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt").handler(
      input as { attemptId: string },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError with code, message and operationId", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1": FAILURE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt").handler({
      attemptId: ATTEMPT_ID,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readAttempt.",
      operationId: "op-attempt-fail",
    });
  });
});

describe("fleet_attempt_list", () => {
  it("calls exactly GET /v1/attempts with no input", async () => {
    const client = fakeClient({ "/v1/attempts": LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_list").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/attempts" }]);
    expect(result.isError).toBeUndefined();
  });

  it("calls GET /v1/attempts?projectId=project-example-1&limit=5 with both fields", async () => {
    const client = fakeClient({
      "/v1/attempts?projectId=project-example-1&limit=5": LIST_ENVELOPE,
    });
    const registry = buildRegistry(client);
    await toolNamed(registry, "fleet_attempt_list").handler({
      projectId: PROJECT_ID,
      limit: 5,
    });
    expect(client.calls).toEqual([
      {
        method: "GET",
        path: "/v1/attempts?projectId=project-example-1&limit=5",
      },
    ]);
  });

  it("returns a projection: marker fields are dropped, kept fields are present", async () => {
    const client = fakeClient({ "/v1/attempts": LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_list").handler({});
    const text = textOf(result);
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain("4999");
    const parsed = JSON.parse(text);
    const item = parsed.result.attempts[0];
    expect(item.attempt.id).toBe(ATTEMPT_ID);
    expect(item.attempt.state).toBe("running");
    expect(item.workOrder.projectId).toBe(PROJECT_ID);
    expect(item.workOrder.taskId).toBe("task-example-1");
    expect(item.workOrder.laneId).toBe("lane-example-1");
    expect(item.workOrder.repository).toBeUndefined();
    expect(item.workOrder.ownedPaths).toBeUndefined();
    expect(item.reservation).toEqual({ slotIndex: 2, held: true });
    expect(parsed.result.total).toBe(1);
    expect(parsed.result.truncated).toBe(false);
  });

  it("passes a rejected outcome through as { outcome } only, dropping reason", async () => {
    const client = fakeClient({
      "/v1/attempts": {
        operationId: "op-list",
        code: "OK",
        result: { outcome: "rejected", reason: "MARKER-REASON" },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_list").handler({});
    expect(JSON.parse(textOf(result)).result).toEqual({ outcome: "rejected" });
  });

  it.each([
    [{ limit: 0 }],
    [{ limit: 201 }],
    [{ projectId: ".." }],
    [{ projectId: PROJECT_ID, path: "/v1/relays" }],
  ])("refuses invalid input without calling the client", async (input) => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_list").handler(
      input as { projectId?: string; limit?: number },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError with code, message and operationId", async () => {
    const client = fakeClient({ "/v1/attempts": FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_list").handler({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readAttempt.",
      operationId: "op-attempt-fail",
    });
  });
});

describe("fleet_attempt_journal", () => {
  it("calls exactly GET /v1/attempts/attempt-example-1/journal with the id encoded", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1/journal": JOURNAL_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_journal").handler({
      attemptId: ATTEMPT_ID,
    });
    expect(client.calls).toEqual([
      { method: "GET", path: "/v1/attempts/attempt-example-1/journal" },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("returns a projection: marker fields are dropped, kept fields are present", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1/journal": JOURNAL_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_journal").handler({
      attemptId: ATTEMPT_ID,
    });
    const text = textOf(result);
    expect(text).not.toContain("MARKER");
    const parsed = JSON.parse(text);
    expect(parsed.result.attemptId).toBe(ATTEMPT_ID);
    expect(parsed.result.entries[0]).toEqual({
      id: "journal-example-1",
      action: "dispatch",
      status: "completed",
      recordedAtIso: "2026-10-01T00:05:00.000Z",
      stopReason: "completed",
      authorizedBy: "policy:autoMerge@rev1",
    });
  });

  it("refuses invalid input without calling the client", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_journal").handler({
      attemptId: "bad id",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError with code, message and operationId", async () => {
    const client = fakeClient({
      "/v1/attempts/attempt-example-1/journal": FAILURE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_attempt_journal").handler({
      attemptId: ATTEMPT_ID,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readAttempt.",
      operationId: "op-attempt-fail",
    });
  });
});

describe("fleet_work_order", () => {
  it("calls exactly GET /v1/work-orders/wo-example-1 with the id encoded", async () => {
    const client = fakeClient({
      "/v1/work-orders/wo-example-1": WORK_ORDER_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_work_order").handler({
      workOrderId: WORK_ORDER_ID,
    });
    expect(client.calls).toEqual([
      { method: "GET", path: "/v1/work-orders/wo-example-1" },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("returns a projection: marker fields are dropped, kept fields are present", async () => {
    const client = fakeClient({
      "/v1/work-orders/wo-example-1": WORK_ORDER_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_work_order").handler({
      workOrderId: WORK_ORDER_ID,
    });
    const text = textOf(result);
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain("4999");
    const parsed = JSON.parse(text);
    const workOrder = parsed.result.workOrder;
    expect(workOrder.id).toBe(WORK_ORDER_ID);
    expect(workOrder.projectId).toBe(PROJECT_ID);
    expect(workOrder.taskId).toBe("task-example-1");
    expect(workOrder.laneId).toBe("lane-example-1");
    expect(workOrder.baseCommit).toBe(HEAD_SHA);
    expect(workOrder.policyRevision).toBe("0");
    expect(workOrder.risk).toBe("high");
    expect(workOrder.state).toBe("open");
    expect(workOrder.revision).toBe(2);
    expect(workOrder.prerequisiteWorkOrderIds).toEqual(["wo-example-2"]);
    expect(workOrder.repository).toBeUndefined();
    expect(workOrder.ownedPaths).toBeUndefined();
    expect(workOrder.planRef).toBeUndefined();
    expect(parsed.result.attempts[0].id).toBe(ATTEMPT_ID);
    expect(parsed.result.activeReservations[0]).toEqual({
      id: "res-example-1",
      attemptId: ATTEMPT_ID,
      slotIndex: 0,
      held: true,
      seatTool: "opencode",
      reservedAtIso: "2026-10-01T00:00:00.000Z",
    });
  });

  it("passes a not-found outcome through as { outcome, workOrderId } only", async () => {
    const client = fakeClient({
      "/v1/work-orders/wo-example-1": {
        operationId: "op-work-order",
        code: "OK",
        result: { outcome: "not-found", workOrderId: WORK_ORDER_ID },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_work_order").handler({
      workOrderId: WORK_ORDER_ID,
    });
    expect(JSON.parse(textOf(result)).result).toEqual({
      outcome: "not-found",
      workOrderId: WORK_ORDER_ID,
    });
  });

  it("refuses invalid input without calling the client", async () => {
    const client = fakeClient({});
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_work_order").handler({
      workOrderId: "/etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError with code, message and operationId", async () => {
    const client = fakeClient({
      "/v1/work-orders/wo-example-1": FAILURE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_work_order").handler({
      workOrderId: WORK_ORDER_ID,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: readAttempt.",
      operationId: "op-attempt-fail",
    });
  });
});

describe("new read tool names", () => {
  it("are present in FLEET_TOOL_NAMES in order", () => {
    expect([...FLEET_TOOL_NAMES]).toEqual([
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
  });
});
