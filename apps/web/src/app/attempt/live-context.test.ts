import { describe, expect, it } from "vitest";
import { loadAttemptContext } from "./live-context";
import type { AttemptPageData } from "./live";
import type { LiveEndpointResult } from "../../lib/api-client";

const OBSERVED_AT = "2026-10-27T12:00:00Z";

function foundData(workOrderId: string): AttemptPageData {
  return {
    view: "found",
    attemptId: "att_live_1",
    attempt: { workOrderId },
    source: "api",
    fallbackReason: null,
    observedAtIso: OBSERVED_AT,
  } as unknown as AttemptPageData;
}

const SAMPLE_DATA: AttemptPageData = {
  view: "sample",
  attemptId: "att_live_1",
  source: "fixture-fallback",
  fallbackReason: "api boundary is not configured",
  observedAtIso: OBSERVED_AT,
};

const UNKNOWN_DATA: AttemptPageData = {
  view: "unknown",
  reason: "the recorded host cannot be resolved",
  attemptId: "att_live_1",
  source: "api",
  fallbackReason: null,
  observedAtIso: OBSERVED_AT,
};

const NOT_FOUND_DATA: AttemptPageData = {
  view: "not-found",
  attemptId: "att_live_1",
  source: "api",
  fallbackReason: null,
  observedAtIso: OBSERVED_AT,
};

const ERROR_DATA: AttemptPageData = {
  view: "error",
  reason: "api boundary answered REFUSED for /v1/attempts/att_live_1",
  attemptId: "att_live_1",
  source: "api",
  fallbackReason: null,
  observedAtIso: OBSERVED_AT,
};

const MISSING_ID_DATA: AttemptPageData = {
  view: "missing-id",
  newestAttemptId: null,
  attemptId: "",
  source: "api",
  fallbackReason: null,
  observedAtIso: OBSERVED_AT,
};

const FOUND_WORK_ORDER = {
  id: "wo-live-1",
  projectId: "proj-live-1",
  taskId: "task-live-1",
  laneId: "lane-live-1",
  baseCommit: "a".repeat(40),
  prerequisiteWorkOrderIds: [],
  state: "approved",
  revision: 2,
  createdAtIso: "2026-10-24T10:00:00Z",
  updatedAtIso: "2026-10-24T10:05:00Z",
};

const FOUND_ATTEMPT = {
  id: "att_live_1",
  workOrderId: "wo-live-1",
  kind: "initial",
  fixNumber: 1,
  priorAttemptId: null,
  state: "ended",
  outcome: "ok",
  sessionId: "ses_live_1",
  createdAtIso: "2026-10-24T10:00:00Z",
  updatedAtIso: "2026-10-24T10:05:00Z",
};

const FOUND_ENVELOPE = {
  code: "OK",
  result: {
    outcome: "found",
    workOrder: FOUND_WORK_ORDER,
    attempts: [FOUND_ATTEMPT],
    activeReservations: [],
  },
};

const JOURNAL_ENTRY_A = {
  id: "jr_1",
  action: "dispatch",
  status: "completed",
  recordedAtIso: "2026-10-24T10:00:05Z",
  sessionId: "ses_live_1",
  detail: null,
};

const JOURNAL_ENTRY_B = {
  id: "jr_2",
  action: "collect",
  status: "ambiguous",
  recordedAtIso: "2026-10-24T10:00:10Z",
  sessionId: null,
  detail: null,
};

const JOURNAL_ENVELOPE = {
  code: "OK",
  result: {
    outcome: "listed",
    attemptId: "att_live_1",
    entries: [JOURNAL_ENTRY_B, JOURNAL_ENTRY_A],
  },
};

type Reply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      status: number | null;
      fallbackReason: string | null;
    };

function fakeWorkOrderClient(workOrderReply: Reply, journalReply?: Reply) {
  const viewed: string[] = [];
  const journalIds: string[] = [];
  const client = {
    viewed,
    journalIds,
    fetchWorkOrderView: async <T>(
      workOrderId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      viewed.push(workOrderId);
      if (workOrderReply.source === "api") {
        return {
          source: "api",
          status: 200,
          data: workOrderReply.data as T,
          fallbackReason: null,
        };
      }
      return {
        source: "fixture-fallback",
        status: workOrderReply.status,
        data: fallback,
        fallbackReason: workOrderReply.fallbackReason,
      };
    },
    fetchAttemptJournal: async <T>(
      attemptId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      journalIds.push(attemptId);
      const reply = journalReply ?? workOrderReply;
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
        status: reply.status,
        data: fallback,
        fallbackReason: reply.fallbackReason,
      };
    },
  };
  return client;
}

describe("loadAttemptContext", () => {
  it("does not read for the sample view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(SAMPLE_DATA, client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
    expect(client.viewed).toEqual([]);
  });

  it("does not read for the unknown view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(UNKNOWN_DATA, client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
    expect(client.viewed).toEqual([]);
  });

  it("does not read for the not-found view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(NOT_FOUND_DATA, client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
    expect(client.viewed).toEqual([]);
  });

  it("does not read for the error view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(ERROR_DATA, client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
    expect(client.viewed).toEqual([]);
  });

  it("does not read for the missing-id view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(MISSING_ID_DATA, client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
    expect(client.viewed).toEqual([]);
  });

  it("reads the work order for the found view", async () => {
    const client = fakeWorkOrderClient({
      source: "api",
      data: FOUND_ENVELOPE,
    });
    const context = await loadAttemptContext(foundData("wo-live-1"), client);

    expect(client.viewed).toEqual(["wo-live-1"]);
    expect(context.workOrder.panel).toBe("found");
    if (context.workOrder.panel === "found") {
      expect(context.workOrder.workOrder.id).toBe("wo-live-1");
      expect(context.workOrder.attempts.map((attempt) => attempt.id)).toEqual([
        "att_live_1",
      ]);
      expect(context.workOrder.heldSlots).toEqual([]);
    }
  });

  it("returns not-read when the API boundary is not configured", async () => {
    const client = fakeWorkOrderClient({
      source: "fixture-fallback",
      status: null,
      fallbackReason: "api boundary is not configured",
    });
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
  });

  it("keeps a fallback reason verbatim on an API failure", async () => {
    const client = fakeWorkOrderClient({
      source: "fixture-fallback",
      status: 500,
      fallbackReason: "upstream exploded",
    });
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.workOrder).toEqual({
      panel: "error",
      workOrderId: "wo-live-1",
      reason: "upstream exploded",
    });
  });

  it("reports a non-OK code with the live.ts wording", async () => {
    const client = fakeWorkOrderClient({
      source: "api",
      data: { code: "REFUSED", result: null },
    });
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.workOrder).toEqual({
      panel: "error",
      workOrderId: "wo-live-1",
      reason: "api boundary answered REFUSED for /v1/work-orders/wo-live-1",
    });
  });

  it("returns not-found for a not-found envelope", async () => {
    const client = fakeWorkOrderClient({
      source: "api",
      data: {
        code: "OK",
        result: { outcome: "not-found", workOrderId: "wo-live-1" },
      },
    });
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.workOrder).toEqual({
      panel: "not-found",
      workOrderId: "wo-live-1",
    });
  });

  it("errors without a read when the attempt names no work order", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(foundData("  "), client);
    expect(context.workOrder).toEqual({
      panel: "error",
      workOrderId: "",
      reason: "the attempt record names no work order",
    });
    expect(client.viewed).toEqual([]);
  });

  it("reads the journal for the found view", async () => {
    const client = fakeWorkOrderClient(
      { source: "api", data: FOUND_ENVELOPE },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(client.journalIds).toEqual(["att_live_1"]);
    expect(context.journal).toEqual({
      panel: "listed",
      entries: [
        {
          id: "jr_2",
          action: "collect",
          status: "ambiguous",
          recordedAtIso: "2026-10-24T10:00:10Z",
          sessionId: null,
          detail: null,
          stopReason: null,
        },
        {
          id: "jr_1",
          action: "dispatch",
          status: "completed",
          recordedAtIso: "2026-10-24T10:00:05Z",
          sessionId: "ses_live_1",
          detail: null,
          stopReason: null,
        },
      ],
    });
  });

  it("reads the journal for the unknown view", async () => {
    const client = fakeWorkOrderClient(
      { source: "api", data: null },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const context = await loadAttemptContext(UNKNOWN_DATA, client);
    expect(context.workOrder).toEqual({ panel: "not-read" });
    expect(client.journalIds).toEqual(["att_live_1"]);
    expect(context.journal.panel).toBe("listed");
  });

  it("does not read the journal for the sample view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(SAMPLE_DATA, client);
    expect(client.journalIds).toEqual([]);
    expect(context.journal).toEqual({ panel: "not-read" });
  });

  it("does not read the journal for the not-found view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(NOT_FOUND_DATA, client);
    expect(client.journalIds).toEqual([]);
    expect(context.journal).toEqual({ panel: "not-read" });
  });

  it("does not read the journal for the error view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(ERROR_DATA, client);
    expect(client.journalIds).toEqual([]);
    expect(context.journal).toEqual({ panel: "not-read" });
  });

  it("does not read the journal for the missing-id view", async () => {
    const client = fakeWorkOrderClient({ source: "api", data: null });
    const context = await loadAttemptContext(MISSING_ID_DATA, client);
    expect(client.journalIds).toEqual([]);
    expect(context.journal).toEqual({ panel: "not-read" });
  });

  it("returns not-found when the journal route answers 404", async () => {
    const client = fakeWorkOrderClient(
      { source: "api", data: FOUND_ENVELOPE },
      {
        source: "fixture-fallback",
        status: 404,
        fallbackReason:
          "api boundary returned 404 for /v1/attempts/att_live_1/journal",
      },
    );
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.journal).toEqual({ panel: "not-found" });
  });

  it("keeps a journal fallback reason verbatim", async () => {
    const client = fakeWorkOrderClient(
      { source: "api", data: FOUND_ENVELOPE },
      {
        source: "fixture-fallback",
        status: 500,
        fallbackReason: "upstream exploded",
      },
    );
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.journal).toEqual({
      panel: "error",
      reason: "upstream exploded",
    });
  });

  it("returns not-read when the journal boundary is not configured", async () => {
    const client = fakeWorkOrderClient(
      { source: "api", data: FOUND_ENVELOPE },
      {
        source: "fixture-fallback",
        status: null,
        fallbackReason: "api boundary is not configured",
      },
    );
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.journal).toEqual({ panel: "not-read" });
  });

  it("reports a non-OK journal code with the live.ts wording", async () => {
    const client = fakeWorkOrderClient(
      { source: "api", data: FOUND_ENVELOPE },
      { source: "api", data: { code: "REFUSED", result: null } },
    );
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.journal).toEqual({
      panel: "error",
      reason: "api boundary answered REFUSED for /v1/attempts/att_live_1/journal",
    });
  });

  it("brings a work-order error and a listed journal together", async () => {
    const client = fakeWorkOrderClient(
      {
        source: "fixture-fallback",
        status: 500,
        fallbackReason: "upstream exploded",
      },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const context = await loadAttemptContext(foundData("wo-live-1"), client);
    expect(context.workOrder).toEqual({
      panel: "error",
      workOrderId: "wo-live-1",
      reason: "upstream exploded",
    });
    expect(context.journal.panel).toBe("listed");
  });
});
