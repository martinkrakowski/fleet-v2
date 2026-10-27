import { describe, expect, it } from "vitest";
import { loadAttemptPage } from "./live";
import type {
  FleetWebApiClient,
  LiveEndpointResult,
} from "../../lib/api-client";

const ATTEMPT = {
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
  baseCommit: "a".repeat(40),
  briefDigest: "digest-1",
  stopReason: null,
  reviewerSeat: "gpt-6-luna",
  ownerDecisionReferences: [],
  completionReceipt: {
    endedAtIso: "2026-10-24T10:04:00Z",
    exitStatus: 0,
    authoritative: true,
    stoppedByRequest: false,
  },
  runner: {
    kind: "opencode",
    agent: "lane",
    model: "example/model-a",
    variant: null,
  },
  usage: {
    source: "opencode-db",
    readAtIso: "2026-10-24T10:05:00Z",
    steps: 40,
    wallSeconds: 1500,
    tokensInput: 1000,
    tokensOutput: 500,
    costUsd: 0.12,
    model: "example/model-a",
    reason: null,
  },
  artifacts: {
    headCommit: "a".repeat(40),
    commitsSinceBase: ["b".repeat(40)],
    collectedArtifactPaths: [],
    notes: "present",
  },
};

const FOUND_ENVELOPE = {
  code: "OK",
  result: { outcome: "found", attempt: ATTEMPT },
};

const NOT_FOUND_ENVELOPE = {
  code: "OK",
  result: { outcome: "not-found", attemptId: "att_live_1" },
};

const UNKNOWN_ENVELOPE = {
  code: "OK",
  result: {
    outcome: "unknown",
    attemptId: "att_live_1",
    reason: "the recorded host cannot be resolved",
  },
};

const LIST_ENVELOPE = {
  code: "OK",
  result: {
    outcome: "listed",
    total: 1,
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
        workOrder: null,
        reservation: null,
      },
    ],
  },
};

type Reply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      status: number | null;
      fallbackReason: string | null;
    };

type AttemptListQuery = {
  readonly limit?: number;
  readonly projectId?: string;
};

function fakeClient(
  reply: Reply,
): FleetWebApiClient & {
  readonly viewed: string[];
  readonly lists: AttemptListQuery[];
} {
  const viewed: string[] = [];
  const lists: AttemptListQuery[] = [];
  return {
    viewed,
    lists,
    fetchWorkOrderView: async () => {
      throw new Error("unused");
    },
    fetchAttemptView: async <T>(
      attemptId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      viewed.push(attemptId);
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
    fetchAttemptJournal: async () => {
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
      lists.push(query);
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
}

describe("loadAttemptPage", () => {
  const now = () => new Date("2026-10-24T12:00:00Z");

  it("returns sample when the API boundary is not configured", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      status: null,
      fallbackReason: "api boundary is not configured",
    });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data).toEqual({
      view: "sample",
      attemptId: "att_live_1",
      source: "fixture-fallback",
      fallbackReason: "api boundary is not configured",
      observedAtIso: "2026-10-24T12:00:00.000Z",
    });
  });

  it("returns error with the verbatim reason when a configured API fails, and no sample attempt", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      status: 500,
      fallbackReason: "api boundary returned 500 for /v1/attempts/att_live_1",
    });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data.view).toBe("error");
    expect(data.source).toBe("fixture-fallback");
    expect(data.attemptId).toBe("att_live_1");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary returned 500 for /v1/attempts/att_live_1",
      );
    }
    expect("attempt" in data).toBe(false);
  });

  it("maps a found envelope", async () => {
    const client = fakeClient({ source: "api", data: FOUND_ENVELOPE });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data.view).toBe("found");
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.observedAtIso).toBe("2026-10-24T12:00:00.000Z");
    if (data.view === "found") {
      expect(data.attempt.id).toBe("att_live_1");
      expect(data.attempt.usage?.costUsd).toBe(0.12);
    }
  });

  it("maps a not-found envelope", async () => {
    const client = fakeClient({ source: "api", data: NOT_FOUND_ENVELOPE });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data.view).toBe("not-found");
    expect(data.attemptId).toBe("att_live_1");
  });

  it("keeps the server reason verbatim on unknown", async () => {
    const client = fakeClient({ source: "api", data: UNKNOWN_ENVELOPE });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data.view).toBe("unknown");
    if (data.view === "unknown") {
      expect(data.reason).toBe("the recorded host cannot be resolved");
    }
  });

  it("reports an unexpected attempt shape from the api", async () => {
    const client = fakeClient({
      source: "api",
      data: { code: "OK", result: { outcome: "gone" } },
    });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary returned an unexpected attempt shape for /v1/attempts/att_live_1",
      );
    }
  });

  it("reports the envelope code when the payload has a non-OK string code", async () => {
    const client = fakeClient({ source: "api", data: { code: "REFUSED" } });
    const data = await loadAttemptPage("att_live_1", client, now);

    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary answered REFUSED for /v1/attempts/att_live_1",
      );
    }
  });

  it("treats whitespace ids as missing without calling fetchAttemptView", async () => {
    const client = fakeClient({ source: "api", data: LIST_ENVELOPE });
    const data = await loadAttemptPage("  ", client, now);

    expect(client.viewed).toEqual([]);
    expect(client.lists).toEqual([{ limit: 1 }]);
    expect(data.attemptId).toBe("");
    expect(data.view).toBe("missing-id");
    if (data.view === "missing-id") {
      expect(data.newestAttemptId).toBe("att_live_1");
    }
  });

  it("returns sample for an empty id when the API is unconfigured", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      status: null,
      fallbackReason: "api boundary is not configured",
    });
    const data = await loadAttemptPage("  ", client, now);

    expect(client.viewed).toEqual([]);
    expect(client.lists).toEqual([{ limit: 1 }]);
    expect(data.view).toBe("sample");
  });

  it("returns missing-id with null newestAttemptId when the empty-id list is a failed fallback", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      status: 500,
      fallbackReason: "api boundary returned 500 for /v1/attempts",
    });
    const data = await loadAttemptPage("  ", client, now);

    expect(data.view).toBe("missing-id");
    if (data.view === "missing-id") {
      expect(data.newestAttemptId).toBeNull();
    }
  });

  it("passes the untrimmed id to fetchAttemptView; the reader encodes it", async () => {
    const client = fakeClient({ source: "api", data: NOT_FOUND_ENVELOPE });
    const data = await loadAttemptPage("att 1/2", client, now);

    expect(client.viewed).toEqual(["att 1/2"]);
    expect(data.attemptId).toBe("att 1/2");
    expect(data.view).toBe("not-found");
  });
});
