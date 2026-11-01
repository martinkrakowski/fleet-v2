import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConductor } from "./live";
import type { LiveEndpointResult } from "../../lib/api-client";

const FIXTURE_PATH = join(
  import.meta.dirname,
  "../../../../api/server/wiring/__tests__/fixtures/v1-runs.recorded.json",
);
const RECORDED: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const PASSES_FIXTURE_PATH = join(
  import.meta.dirname,
  "../../../../api/test/fixtures/v1-runs-passes.json",
);
const PASSES_RECORDED: unknown = JSON.parse(
  readFileSync(PASSES_FIXTURE_PATH, "utf8"),
);

const EMPTY_PASSES = {
  code: "OK",
  result: {
    outcome: "listed",
    store: "readable",
    passes: [],
    total: 0,
    truncated: false,
  },
};

type Reply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      fallbackReason: string | null;
      status: number | null;
    };

type PassReply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      fallbackReason: string | null;
      status: number | null;
    };

function apiReply(data: unknown): Reply {
  return { source: "api", data };
}

function fallbackReply(fallbackReason: string, status: number | null): Reply {
  return { source: "fixture-fallback", fallbackReason, status };
}

function fakeClient(reply: Reply, passReply?: PassReply) {
  const passes = passReply ?? apiReply(EMPTY_PASSES);
  return {
    fetchRunSchedule: async <T>(fallback: T): Promise<LiveEndpointResult<T>> => {
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
    fetchConductorPasses: async <T>(
      _query: { readonly limit?: number },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      if (passes.source === "api") {
        return {
          source: "api",
          status: 200,
          data: passes.data as T,
          fallbackReason: null,
        };
      }
      return {
        source: "fixture-fallback",
        status: passes.status,
        data: fallback,
        fallbackReason: passes.fallbackReason,
      };
    },
  };
}

describe("loadConductor", () => {
  const now = () => new Date("2026-10-31T12:00:00Z");

  it("reports not-configured for an empty-base-url fallback", async () => {
    const data = await loadConductor(
      fakeClient(
        fallbackReply("api boundary is not configured", null),
        fallbackReply("api boundary is not configured", null),
      ),
      now,
    );
    expect(data.view).toBe("not-configured");
    expect(data.fallbackReason).toBe("api boundary is not configured");
  });

  it("reports not-configured for a 501 fallback so refresh stops", async () => {
    const data = await loadConductor(
      fakeClient(
        fallbackReply(
          "api boundary returned 501 NOT_IMPLEMENTED for /v1/runs",
          501,
        ),
        fallbackReply(
          "api boundary returned 501 NOT_IMPLEMENTED for /v1/runs/passes",
          501,
        ),
      ),
      now,
    );
    expect(data.view).toBe("not-configured");
    expect(data.fallbackReason).toBe("api boundary is not configured");
  });

  it("reports not-configured when the passes reader is absent", async () => {
    const onlySchedule = {
      fetchRunSchedule: async <T>(
        _fallback: T,
      ): Promise<LiveEndpointResult<T>> => ({
        source: "api",
        status: 200,
        data: RECORDED as T,
        fallbackReason: null,
      }),
    };
    const data = await loadConductor(onlySchedule, now);
    expect(data.view).toBe("not-configured");
  });

  it("reports an error with the reason for a 500 fallback", async () => {
    const data = await loadConductor(
      fakeClient(fallbackReply("api boundary returned 500 for /v1/runs", 500)),
      now,
    );
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe("api boundary returned 500 for /v1/runs");
    }
  });

  it("reports the envelope code for a non-OK api answer", async () => {
    const data = await loadConductor(
      fakeClient(apiReply({ code: "NOT_FOUND" })),
      now,
    );
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe("api boundary answered NOT_FOUND for /v1/runs");
    }
  });

  it("reports an unexpected shape for an unreadable OK answer", async () => {
    const data = await loadConductor(
      fakeClient(apiReply({ code: "OK", result: {} })),
      now,
    );
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe(
        "api boundary returned an unexpected schedule shape for /v1/runs",
      );
    }
  });

  it("lists the recorded fixture envelope", async () => {
    const data = await loadConductor(
      fakeClient(apiReply(RECORDED), apiReply(PASSES_RECORDED)),
      now,
    );
    expect(data.view).toBe("listed");
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.observedAtIso).toBe("2026-10-31T12:00:00.000Z");
    if (data.view === "listed") {
      expect(data.schedule.rows.length).toBe(2);
      expect(data.passes.total).toBe(2);
      expect(data.passes.passes.map((pass) => pass.passId)).toEqual([
        "pass-0002",
        "pass-0001",
      ]);
    }
  });

  it("reports unreadable passes when the passes read is a 500 fallback", async () => {
    const data = await loadConductor(
      fakeClient(
        apiReply(RECORDED),
        fallbackReply("api boundary returned 500 for /v1/runs/passes", 500),
      ),
      now,
    );
    expect(data.view).toBe("listed");
    if (data.view === "listed") {
      expect(data.passes).toEqual({
        store: "unreadable",
        passes: [],
        total: 0,
        truncated: false,
      });
    }
  });

  it("reports unreadable passes when the parser refuses the envelope", async () => {
    const data = await loadConductor(
      fakeClient(
        apiReply(RECORDED),
        apiReply({ code: "OK", result: { outcome: "listed", store: "nope" } }),
      ),
      now,
    );
    expect(data.view).toBe("listed");
    if (data.view === "listed") {
      expect(data.passes).toEqual({
        store: "unreadable",
        passes: [],
        total: 0,
        truncated: false,
      });
    }
  });
});
