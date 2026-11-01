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

type Reply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      fallbackReason: string | null;
      status: number | null;
    };

function fakeClient(reply: Reply) {
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
  };
}

describe("loadConductor", () => {
  const now = () => new Date("2026-10-31T12:00:00Z");

  it("reports not-configured for an empty-base-url fallback", async () => {
    const data = await loadConductor(
      fakeClient({
        source: "fixture-fallback",
        fallbackReason: "api boundary is not configured",
        status: null,
      }),
      now,
    );
    expect(data.view).toBe("not-configured");
    expect(data.fallbackReason).toBe("api boundary is not configured");
  });

  it("reports not-configured for a 501 fallback so refresh stops", async () => {
    const data = await loadConductor(
      fakeClient({
        source: "fixture-fallback",
        fallbackReason:
          "api boundary returned 501 NOT_IMPLEMENTED for /v1/runs",
        status: 501,
      }),
      now,
    );
    expect(data.view).toBe("not-configured");
    expect(data.fallbackReason).toBe("api boundary is not configured");
  });

  it("reports an error with the reason for a 500 fallback", async () => {
    const data = await loadConductor(
      fakeClient({
        source: "fixture-fallback",
        fallbackReason: "api boundary returned 500 for /v1/runs",
        status: 500,
      }),
      now,
    );
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe("api boundary returned 500 for /v1/runs");
    }
  });

  it("reports the envelope code for a non-OK api answer", async () => {
    const data = await loadConductor(
      fakeClient({ source: "api", data: { code: "NOT_FOUND" } }),
      now,
    );
    expect(data.view).toBe("error");
    if (data.view === "error") {
      expect(data.reason).toBe("api boundary answered NOT_FOUND for /v1/runs");
    }
  });

  it("reports an unexpected shape for an unreadable OK answer", async () => {
    const data = await loadConductor(
      fakeClient({ source: "api", data: { code: "OK", result: {} } }),
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
      fakeClient({ source: "api", data: RECORDED }),
      now,
    );
    expect(data.view).toBe("listed");
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.observedAtIso).toBe("2026-10-31T12:00:00.000Z");
    if (data.view === "listed") {
      expect(data.schedule.rows.length).toBe(2);
    }
  });
});
