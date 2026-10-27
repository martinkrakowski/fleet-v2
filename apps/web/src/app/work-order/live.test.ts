import { describe, expect, it } from "vitest";
import { loadWorkOrderTimeline } from "./live";
import type { LiveEndpointResult } from "../../lib/api-client";
import type { RecordedArtifacts, RecordedAttemptWire } from "../../lib/attempt-wire";

type Reply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      status: number | null;
      fallbackReason: string | null;
    };

function fakeClient(
  workOrderReply: Reply,
  journalReply?: Reply | ((attemptId: string) => Reply),
  evidenceReply?: Reply | ((headSha: string) => Reply),
) {
  const viewed: string[] = [];
  const journalIds: string[] = [];
  const evidenceHeads: string[] = [];
  const unconfigured: Reply = {
    source: "fixture-fallback",
    status: null,
    fallbackReason: "api boundary is not configured",
  };
  const client = {
    viewed,
    journalIds,
    evidenceHeads,
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
      const reply =
        typeof journalReply === "function"
          ? journalReply(attemptId)
          : journalReply ?? workOrderReply;
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
    fetchHeadEvidenceView: async <T>(
      headSha: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      evidenceHeads.push(headSha);
      const reply =
        typeof evidenceReply === "function"
          ? evidenceReply(headSha)
          : evidenceReply ?? unconfigured;
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

const WORK_ORDER = {
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

function attemptWire(
  id: string,
  overrides: Partial<RecordedAttemptWire> = {},
): RecordedAttemptWire {
  return {
    id,
    workOrderId: "wo-live-1",
    kind: "initial",
    fixNumber: 1,
    priorAttemptId: null,
    state: "ended",
    outcome: "ok",
    sessionId: "ses_live_1",
    createdAtIso: "2026-10-24T10:00:00Z",
    updatedAtIso: "2026-10-24T10:05:00Z",
    runner: null,
    usage: null,
    artifacts: null,
    ...overrides,
  };
}

function foundEnvelope(attempts: readonly RecordedAttemptWire[]) {
  return {
    code: "OK",
    result: {
      outcome: "found",
      workOrder: WORK_ORDER,
      attempts,
      activeReservations: [],
    },
  };
}

const JOURNAL_ENVELOPE = {
  code: "OK",
  result: {
    outcome: "listed",
    attemptId: "att_live_1",
    entries: [
      {
        id: "jr_1",
        action: "dispatch",
        status: "completed",
        recordedAtIso: "2026-10-24T10:00:05Z",
        sessionId: "ses_live_1",
        detail: null,
      },
    ],
  },
};

describe("loadWorkOrderTimeline", () => {
  it("answers missing-id and reads nothing for an empty id", async () => {
    const client = fakeClient({ source: "api", data: null });
    const data = await loadWorkOrderTimeline("   ", client);
    expect(data.view).toBe("missing-id");
    expect(client.viewed).toEqual([]);
    expect(client.journalIds).toEqual([]);
  });

  it("answers not-configured when the API boundary is unconfigured", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      status: null,
      fallbackReason: "api boundary is not configured",
    });
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("not-configured");
    expect(data.workOrderId).toBe("wo-live-1");
  });

  it("keeps a fallback reason verbatim on an API failure", async () => {
    const client = fakeClient({
      source: "fixture-fallback",
      status: 500,
      fallbackReason: "upstream exploded",
    });
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe("upstream exploded");
    }
  });

  it("reports a non-OK code with the live wording", async () => {
    const client = fakeClient({
      source: "api",
      data: { code: "REFUSED", result: null },
    });
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary answered REFUSED for /v1/work-orders/wo-live-1",
      );
    }
  });

  it("answers not-found for a not-found envelope", async () => {
    const client = fakeClient({
      source: "api",
      data: {
        code: "OK",
        result: { outcome: "not-found", workOrderId: "wo-live-1" },
      },
    });
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("not-found");
  });

  it("lists attempts in chain order with the right notes and journals", async () => {
    const firstPass = attemptWire("att_live_1", {
      kind: "initial",
      fixNumber: 1,
      priorAttemptId: null,
    });
    const fix1 = attemptWire("att_live_2", {
      kind: "fix",
      fixNumber: 2,
      priorAttemptId: "att_live_1",
    });
    const fix2 = attemptWire("att_live_3", {
      kind: "fix",
      fixNumber: 3,
      priorAttemptId: "att_live_2",
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([fix2, firstPass, fix1]) },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts.map((entry) => entry.attempt.id)).toEqual([
      "att_live_1",
      "att_live_2",
      "att_live_3",
    ]);
    expect(data.attempts[0].chain).toEqual({ kind: "first-pass" });
    expect(data.attempts[1].chain).toEqual({
      kind: "fix-of",
      priorAttemptId: "att_live_1",
    });
    expect(data.attempts[2].chain).toEqual({
      kind: "fix-of",
      priorAttemptId: "att_live_2",
    });
    expect(client.journalIds).toEqual([
      "att_live_1",
      "att_live_2",
      "att_live_3",
    ]);
    expect(
      data.attempts.every((entry) => entry.journal.panel === "listed"),
    ).toBe(true);
    expect(data.journalsNotRead).toBe(0);
  });

  it("keeps a failing journal as error while the others list", async () => {
    const firstPass = attemptWire("att_live_1", {
      kind: "initial",
      fixNumber: 1,
      priorAttemptId: null,
    });
    const fix1 = attemptWire("att_live_2", {
      kind: "fix",
      fixNumber: 2,
      priorAttemptId: "att_live_1",
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([firstPass, fix1]) },
      (attemptId) =>
        attemptId === "att_live_2"
          ? {
              source: "fixture-fallback",
              status: 500,
              fallbackReason: "upstream exploded",
            }
          : { source: "api", data: JOURNAL_ENVELOPE },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].journal.panel).toBe("listed");
    expect(data.attempts[1].journal).toEqual({
      panel: "error",
      reason: "upstream exploded",
    });
  });

  it("reads only the newest 12 journals and reports the rest not read", async () => {
    const attempts = Array.from({ length: 14 }, (_, index) =>
      attemptWire(`att_live_${index + 1}`, {
        kind: "fix",
        fixNumber: index + 1,
        priorAttemptId:
          index === 0 ? null : `att_live_${index}`,
      }),
    );
    const client = fakeClient(
      { source: "api", data: foundEnvelope(attempts) },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(
      data.attempts.filter((entry) => entry.journal.panel === "listed"),
    ).toHaveLength(12);
    expect(
      data.attempts.filter((entry) => entry.journal.panel === "not-read"),
    ).toHaveLength(2);
    expect(client.journalIds).toHaveLength(12);
    expect(client.journalIds[0]).toBe("att_live_3");
    expect(data.journalsNotRead).toBe(2);
  });

  it("notes a fix whose prior is not on this work order as prior-missing", async () => {
    const fix = attemptWire("att_live_2", {
      kind: "fix",
      fixNumber: 2,
      priorAttemptId: "att_live_999",
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([fix]) },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].chain).toEqual({
      kind: "prior-missing",
      priorAttemptId: "att_live_999",
    });
  });

  it("reads evidence once for two read attempts sharing a head", async () => {
    const shared = "a".repeat(40);
    const firstPass = attemptWire("att_live_1", {
      artifacts: {
        headCommit: shared,
        commitsSinceBase: ["b".repeat(40)],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const fix1 = attemptWire("att_live_2", {
      artifacts: {
        headCommit: shared,
        commitsSinceBase: ["b".repeat(40)],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([firstPass, fix1]) },
      { source: "api", data: JOURNAL_ENVELOPE },
      {
        source: "api",
        data: { code: "OK", result: { outcome: "not-found", query: "h" } },
      },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(client.evidenceHeads).toEqual([shared]);
    expect(
      data.attempts.every((entry) => entry.evidence.panel === "not-recorded"),
    ).toBe(true);
  });

  it("answers no-head with no read for an attempt without artifacts", async () => {
    const firstPass = attemptWire("att_live_1");
    const client = fakeClient(
      { source: "api", data: foundEnvelope([firstPass]) },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(client.evidenceHeads).toEqual([]);
    expect(data.attempts[0].evidence).toEqual({ panel: "no-head" });
  });

  it("maps a not-found evidence envelope to not-recorded", async () => {
    const head = "b".repeat(40);
    const attempt = attemptWire("att_live_1", {
      artifacts: {
        headCommit: head,
        commitsSinceBase: ["b".repeat(40)],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([attempt]) },
      { source: "api", data: JOURNAL_ENVELOPE },
      {
        source: "api",
        data: { code: "OK", result: { outcome: "not-found", query: "h" } },
      },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].evidence).toEqual({
      panel: "not-recorded",
      headSha: head,
    });
  });

  it("keeps a failing evidence reason verbatim while the journals still list", async () => {
    const head = "b".repeat(40);
    const attempt = attemptWire("att_live_1", {
      artifacts: {
        headCommit: head,
        commitsSinceBase: ["b".repeat(40)],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([attempt]) },
      { source: "api", data: JOURNAL_ENVELOPE },
      {
        source: "fixture-fallback",
        status: 500,
        fallbackReason: "upstream exploded",
      },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].journal.panel).toBe("listed");
    expect(data.attempts[0].evidence).toEqual({
      panel: "error",
      headSha: head,
      reason: "upstream exploded",
    });
  });

  it("does not read evidence for the two oldest of fourteen attempts", async () => {
    const attempts = Array.from({ length: 14 }, (_, index) =>
      attemptWire(`att_live_${index + 1}`, {
        kind: "fix",
        fixNumber: index + 1,
        priorAttemptId: index === 0 ? null : `att_live_${index}`,
        artifacts: {
          headCommit: "a".repeat(39) + (index + 1).toString(16),
          commitsSinceBase: ["b".repeat(40)],
          notes: "present",
        } as unknown as RecordedArtifacts,
      }),
    );
    const client = fakeClient(
      { source: "api", data: foundEnvelope(attempts) },
      { source: "api", data: JOURNAL_ENVELOPE },
      {
        source: "api",
        data: { code: "OK", result: { outcome: "not-found", query: "h" } },
      },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].evidence).toEqual({ panel: "not-read" });
    expect(data.attempts[1].evidence).toEqual({ panel: "not-read" });
    expect(client.evidenceHeads).toHaveLength(12);
    expect(client.evidenceHeads).not.toContain("a".repeat(39) + "1");
    expect(client.evidenceHeads).not.toContain("a".repeat(39) + "2");
  });

  it("answers not-read for unconfigured evidence", async () => {
    const head = "b".repeat(40);
    const attempt = attemptWire("att_live_1", {
      artifacts: {
        headCommit: head,
        commitsSinceBase: ["b".repeat(40)],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([attempt]) },
      { source: "api", data: JOURNAL_ENVELOPE },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].evidence).toEqual({ panel: "not-read" });
    expect(client.evidenceHeads).toEqual([head]);
  });

  it("does not read evidence and answers head-unreadable when headCommit is not a sha", async () => {
    const attempt = attemptWire("att_live_1", {
      artifacts: {
        headCommit: "not a sha",
        commitsSinceBase: ["b".repeat(40)],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([attempt]) },
      { source: "api", data: JOURNAL_ENVELOPE },
      {
        source: "api",
        data: { code: "OK", result: { outcome: "not-found", query: "h" } },
      },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(client.evidenceHeads).toEqual([]);
    expect(data.attempts[0].evidence).toEqual({ panel: "head-unreadable" });
  });

  it("refuses an evidence response whose candidateHeadSha differs from the requested sha", async () => {
    const head = "b".repeat(40);
    const otherHead = "c".repeat(40);
    const attempt = attemptWire("att_live_1", {
      artifacts: {
        headCommit: head,
        commitsSinceBase: [head],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const client = fakeClient(
      { source: "api", data: foundEnvelope([attempt]) },
      { source: "api", data: JOURNAL_ENVELOPE },
      {
        source: "api",
        data: {
          code: "OK",
          result: {
            outcome: "found",
            assessment: {
              id: "ev_live_1",
              candidateHeadSha: otherHead,
              policyRevision: "policy-3",
              implementerModel: "model-impl",
              requiredChecks: [],
              state: "accepted",
              verificationReceipts: [],
              reviewReceipts: [],
              findingDispositions: [],
              acceptanceReceiptId: "acc_live_1",
              blockers: [],
              revision: 1,
              updatedAtIso: "2026-10-24T10:35:00Z",
            },
          },
        },
      },
    );
    const data = await loadWorkOrderTimeline("wo-live-1", client);
    expect(data.view).toBe("found");
    if (data.view !== "found") {
      return;
    }
    expect(data.attempts[0].evidence).toEqual({
      panel: "error",
      headSha: head,
      reason: `api boundary returned an unexpected evidence shape for /v1/heads/${head}/evidence`,
    });
  });

  it("starts journal and evidence reads concurrently before either resolves", async () => {
    const head = "b".repeat(40);
    const attempt = attemptWire("att_live_1", {
      artifacts: {
        headCommit: head,
        commitsSinceBase: [head],
        notes: "present",
      } as unknown as RecordedArtifacts,
    });
    const started: string[] = [];
    let releaseJournal!: () => void;
    let releaseEvidence!: () => void;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    const evidenceGate = new Promise<void>((resolve) => {
      releaseEvidence = resolve;
    });
    const client = {
      fetchWorkOrderView: async <T>(): Promise<LiveEndpointResult<T>> => ({
        source: "api",
        status: 200,
        data: foundEnvelope([attempt]) as T,
        fallbackReason: null,
      }),
      fetchAttemptJournal: async <T>(): Promise<LiveEndpointResult<T>> => {
        started.push("journal");
        await journalGate;
        return {
          source: "api",
          status: 200,
          data: JOURNAL_ENVELOPE as T,
          fallbackReason: null,
        };
      },
      fetchHeadEvidenceView: async <T>(): Promise<LiveEndpointResult<T>> => {
        started.push("evidence");
        await evidenceGate;
        return {
          source: "api",
          status: 200,
          data: {
            code: "OK",
            result: { outcome: "not-found", query: "h" },
          } as T,
          fallbackReason: null,
        };
      },
    };

    const pending = loadWorkOrderTimeline("wo-live-1", client);
    await Promise.resolve();
    const startedBeforeResolve = [...started];
    releaseJournal();
    releaseEvidence();
    const data = await pending;
    expect(startedBeforeResolve).toEqual(["journal", "evidence"]);
    expect(data.view).toBe("found");
  });
});
