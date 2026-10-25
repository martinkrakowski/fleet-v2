import { describe, expect, it } from "vitest";
import { loadLanesData } from "./live";
import {
  attempts as fixtureAttempts,
  capacity as fixtureCapacity,
  workOrders as fixtureWorkOrders,
} from "./fixture";
import type {
  FleetWebApiClient,
  LiveEndpointResult,
} from "../../lib/api-client";

const ENVELOPE = {
  operationId: "op-7",
  code: "OK",
  result: {
    outcome: "listed",
    total: 2,
    truncated: false,
    attempts: [
      {
        attempt: {
          id: "att_live_1",
          workOrderId: "wo-live-1",
          kind: "initial",
          fixNumber: 1,
          priorAttemptId: null,
          state: "running",
          outcome: null,
          sessionId: "ses_live_1",
          createdAtIso: "2026-10-24T10:00:00Z",
          updatedAtIso: "2026-10-24T10:05:00Z",
        },
        workOrder: {
          id: "wo-live-1",
          projectId: "fleet-v2",
          taskId: "Task one",
          laneId: "lane-a",
        },
        reservation: {
          hostId: "host-a",
          hostName: "execution host A",
          slotIndex: 0,
        },
      },
      {
        attempt: {
          id: "att_live_2",
          workOrderId: "wo-live-2",
          kind: "fix",
          fixNumber: 2,
          priorAttemptId: null,
          state: "collected",
          outcome: "ok",
          sessionId: null,
          createdAtIso: "2026-10-24T09:00:00Z",
          updatedAtIso: "2026-10-24T09:30:00Z",
        },
        workOrder: null,
        reservation: null,
      },
    ],
  },
};

type AttemptListReply =
  | { source: "api"; data: unknown }
  | { source: "fixture-fallback"; fallbackReason: string | null };

type AttemptListQuery = {
  readonly limit?: number;
  readonly projectId?: string;
};

function fakeClient(
  reply: AttemptListReply,
): FleetWebApiClient & { readonly queries: AttemptListQuery[] } {
  const queries: AttemptListQuery[] = [];
  return {
    queries,
    fetchWorkOrderView: async () => {
      throw new Error("unused");
    },
    fetchAttemptView: async () => {
      throw new Error("unused");
    },
    fetchHeadEvidenceView: async () => {
      throw new Error("unused");
    },
    fetchCoordinationView: async () => {
      throw new Error("unused");
    },
    fetchAttentionView: async () => {
      throw new Error("unused");
    },
    fetchProjectList: async () => {
      throw new Error("unused");
    },
    fetchProjectView: async () => {
      throw new Error("unused");
    },
    fetchAttemptList: async <T>(
      query: AttemptListQuery,
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
}

describe("loadLanesData", () => {
  const now = () => new Date("2026-10-24T12:00:00Z");

  it("maps a valid API envelope with source api and no capacity budget", async () => {
    const client = fakeClient({ source: "api", data: ENVELOPE });
    const data = await loadLanesData(client, now);

    expect(client.queries).toEqual([{ limit: 200 }]);
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.observedAtIso).toBe("2026-10-24T12:00:00.000Z");
    expect(data.capacity).toBeNull();
    expect(data.total).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.attempts).toHaveLength(2);
    expect(data.attempts[0].basis).toBe("recorded");
    expect(data.attempts[0].id).toBe("att_live_1");
    expect(data.attempts[1].kind).toBe("fix");
    expect(data.attempts[1].recordedState).toBe("collected");
    expect(data.workOrders["wo-live-1"]).toEqual({
      project: "fleet-v2",
      task: "Task one",
      lane: "lane-a",
    });
    expect(data.workOrders["wo-live-2"]).toEqual({
      project: "(unknown)",
      task: "work order wo-live-2 (record missing)",
      lane: "",
    });
  });

  it("keeps a real workOrder summary when another row for the same workOrderId has null workOrder", async () => {
    const withWorkOrder = {
      ...ENVELOPE.result.attempts[0],
      attempt: {
        ...ENVELOPE.result.attempts[0].attempt,
        id: "att_wo_1",
        workOrderId: "wo-1",
      },
      workOrder: {
        id: "wo-1",
        projectId: "fleet-v2",
        taskId: "Task one",
        laneId: "lane-a",
      },
    };
    const withoutWorkOrder = {
      ...ENVELOPE.result.attempts[1],
      attempt: {
        ...ENVELOPE.result.attempts[1].attempt,
        id: "att_wo_2",
        workOrderId: "wo-1",
      },
      workOrder: null,
    };

    const forward = await loadLanesData(
      fakeClient({
        source: "api",
        data: {
          ...ENVELOPE,
          result: {
            ...ENVELOPE.result,
            attempts: [withWorkOrder, withoutWorkOrder],
          },
        },
      }),
      now,
    );
    expect(forward.workOrders["wo-1"].project).toBe("fleet-v2");

    const reverse = await loadLanesData(
      fakeClient({
        source: "api",
        data: {
          ...ENVELOPE,
          result: {
            ...ENVELOPE.result,
            attempts: [withoutWorkOrder, withWorkOrder],
          },
        },
      }),
      now,
    );
    expect(reverse.workOrders["wo-1"].project).toBe("fleet-v2");
  });

  it("writes own workOrders properties for prototype keys like constructor and __proto__", async () => {
    const constructorRow = {
      ...ENVELOPE.result.attempts[0],
      attempt: {
        ...ENVELOPE.result.attempts[0].attempt,
        id: "att_proto_1",
        workOrderId: "constructor",
      },
      workOrder: null,
    };
    const protoRow = {
      ...ENVELOPE.result.attempts[0],
      attempt: {
        ...ENVELOPE.result.attempts[0].attempt,
        id: "att_proto_2",
        workOrderId: "__proto__",
      },
      workOrder: {
        id: "__proto__",
        projectId: "fleet-v2",
        taskId: "Proto task",
        laneId: "lane-proto",
      },
    };

    const data = await loadLanesData(
      fakeClient({
        source: "api",
        data: {
          ...ENVELOPE,
          result: {
            ...ENVELOPE.result,
            attempts: [constructorRow, protoRow],
          },
        },
      }),
      now,
    );

    expect(Object.hasOwn(data.workOrders, "constructor")).toBe(true);
    expect(Object.hasOwn(data.workOrders, "__proto__")).toBe(true);
    expect(data.workOrders["constructor"].task).toBe(
      "work order constructor (record missing)",
    );
  });

  it("falls back to the fixture with the client's reason", async () => {
    const data = await loadLanesData(
      fakeClient({
        source: "fixture-fallback",
        fallbackReason:
          "api boundary returned 501 NOT_IMPLEMENTED for /v1/attempts",
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned 501 NOT_IMPLEMENTED for /v1/attempts",
    );
    expect(data.attempts).toBe(fixtureAttempts);
    expect(data.workOrders).toBe(fixtureWorkOrders);
    expect(data.capacity).toBe(fixtureCapacity);
    expect(data.total).toBe(fixtureAttempts.length);
    expect(data.truncated).toBe(false);
    expect(data.observedAtIso).toBe("2026-10-24T12:00:00.000Z");
  });

  it("uses the default fallback reason when the client gives null", async () => {
    const data = await loadLanesData(
      fakeClient({
        source: "fixture-fallback",
        fallbackReason: null,
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe("the api client gave no fallback reason");
  });

  it("falls back to the fixture when the API shape is unexpected", async () => {
    const data = await loadLanesData(
      fakeClient({
        source: "api",
        data: {
          code: "OK",
          result: { outcome: "listed", total: 0, truncated: false },
        },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned an unexpected attempt list shape",
    );
    expect(data.attempts).toBe(fixtureAttempts);
    expect(data.total).toBe(fixtureAttempts.length);
  });

  it("reports the envelope code when the payload has a non-OK string code", async () => {
    const data = await loadLanesData(
      fakeClient({
        source: "api",
        data: { code: "REFUSED" },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary answered REFUSED for /v1/attempts",
    );
    expect(data.attempts).toBe(fixtureAttempts);
  });

  it("uses the injected clock for observedAtIso", async () => {
    const data = await loadLanesData(
      fakeClient({ source: "api", data: ENVELOPE }),
      () => new Date("2026-10-24T13:00:00Z"),
    );

    expect(data.observedAtIso).toBe("2026-10-24T13:00:00.000Z");
  });
});
