/**
 * Loader tests for the sidebar project nav data.
 *
 * The loader reads active profiles and attempt counts through a fake API
 * client, mirroring the style of `app/lanes/live.test.ts`. Counts degrade
 * to the station fixture when the projects read cannot be trusted, and to
 * null (no badges) when the attempts read fails or is truncated.
 */
import { describe, expect, it } from "vitest";
import { loadProjectNav } from "./project-nav-data";
import {
  getProjectAttemptCounts,
  totalAttemptsCount,
} from "../fixtures/station-fixture";
import type {
  FleetWebApiClient,
  LiveEndpointResult,
} from "../lib/api-client";

const NOW = "2026-10-25T09:00:00Z";

function profile(projectId: string, displayName: string): Record<string, unknown> {
  return {
    projectId,
    displayName,
    repository: `https://example.com/${projectId}.git`,
    designatedDispatcherHost: "host-a",
    policyRevision: "pol-2026-10-11.3",
    maxConcurrentLanes: 2,
    runnerCapabilities: {},
    status: "active",
    defaultBranch: "main",
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
    revision: 1,
    updatedAtIso: NOW,
  };
}

function attemptRow(
  attemptId: string,
  workOrderId: string,
  projectId: string | null,
): Record<string, unknown> {
  return {
    attempt: {
      id: attemptId,
      workOrderId,
      kind: "initial",
      fixNumber: 1,
      priorAttemptId: null,
      state: "collected",
      outcome: "ok",
      sessionId: null,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    },
    workOrder:
      projectId === null
        ? null
        : { id: workOrderId, projectId, taskId: "Task", laneId: "lane-a" },
    reservation: null,
  };
}

function projectsEnvelope(profiles: unknown[]): unknown {
  return { code: "OK", result: { outcome: "listed", profiles } };
}

function attemptsEnvelope(
  rows: unknown[],
  overrides: Partial<{ total: number; truncated: boolean }> = {},
): unknown {
  return {
    code: "OK",
    result: {
      outcome: "listed",
      total: overrides.total ?? rows.length,
      truncated: overrides.truncated ?? false,
      attempts: rows,
    },
  };
}

type Reply =
  | { source: "api"; data: unknown }
  | { source: "fixture-fallback"; fallbackReason: string | null };

interface RecordedQueries {
  projectList: Array<{ readonly status?: "active" | "retired" }>;
  attemptList: Array<{ readonly limit?: number; readonly projectId?: string }>;
}

function fakeClient(
  projects: Reply,
  attempts: Reply,
): FleetWebApiClient & { queries: RecordedQueries } {
  const queries: RecordedQueries = { projectList: [], attemptList: [] };
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
    fetchProjectView: async () => {
      throw new Error("unused");
    },
    fetchProjectList: async <T>(
      query: { readonly status?: "active" | "retired" },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      queries.projectList.push(query);
      if (projects.source === "api") {
        return {
          source: "api",
          status: 200,
          data: projects.data as T,
          fallbackReason: null,
        };
      }
      return {
        source: "fixture-fallback",
        status: 501,
        data: fallback,
        fallbackReason: projects.fallbackReason,
      };
    },
    fetchAttemptList: async <T>(
      query: { readonly limit?: number; readonly projectId?: string },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      queries.attemptList.push(query);
      if (attempts.source === "api") {
        return {
          source: "api",
          status: 200,
          data: attempts.data as T,
          fallbackReason: null,
        };
      }
      return {
        source: "fixture-fallback",
        status: 501,
        data: fallback,
        fallbackReason: attempts.fallbackReason,
      };
    },
  };
}

describe("loadProjectNav", () => {
  it("maps api projects with attempt counts, sorted by projectId", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: projectsEnvelope([
          profile("beta", "Beta Name"),
          profile("alpha", "Alpha Name"),
        ]),
      },
      {
        source: "api",
        data: attemptsEnvelope([
          attemptRow("att-1", "wo-beta-1", "beta"),
          attemptRow("att-2", "wo-beta-2", "beta"),
          attemptRow("att-3", "wo-alpha-1", "alpha"),
          attemptRow("att-4", "wo-unattributed", null),
        ]),
      },
    );

    const data = await loadProjectNav(client);

    expect(client.queries.projectList).toEqual([{ status: "active" }]);
    expect(client.queries.attemptList).toEqual([{ limit: 200 }]);
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.projects).toEqual([
      { projectId: "alpha", label: "Alpha Name", attempts: 1 },
      { projectId: "beta", label: "Beta Name", attempts: 2 },
    ]);
    expect(data.totalAttempts).toBe(4);
  });

  it("gives a project with no attempts a zero count", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: projectsEnvelope([
          profile("alpha", "Alpha Name"),
          profile("beta", "Beta Name"),
        ]),
      },
      {
        source: "api",
        data: attemptsEnvelope([attemptRow("att-1", "wo-beta-1", "beta")]),
      },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("api");
    expect(data.projects).toEqual([
      { projectId: "alpha", label: "Alpha Name", attempts: 0 },
      { projectId: "beta", label: "Beta Name", attempts: 1 },
    ]);
    expect(data.totalAttempts).toBe(1);
  });

  it("sorts by explicit code-unit compare, not locale order", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: projectsEnvelope([
          profile("alpha-project", "Alpha"),
          profile("Z-project", "Zed"),
        ]),
      },
      { source: "api", data: attemptsEnvelope([]) },
    );

    const data = await loadProjectNav(client);

    expect(data.projects.map((p) => p.projectId)).toEqual([
      "Z-project",
      "alpha-project",
    ]);
  });

  it("renders null counts when the attempts read is truncated", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: projectsEnvelope([profile("alpha", "Alpha Name")]),
      },
      {
        source: "api",
        data: attemptsEnvelope(
          [attemptRow("att-1", "wo-alpha-1", "alpha")],
          { truncated: true, total: 500 },
        ),
      },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("api");
    expect(data.projects).toEqual([
      { projectId: "alpha", label: "Alpha Name", attempts: null },
    ]);
    expect(data.totalAttempts).toBeNull();
  });

  it("renders null counts when the attempts read fails", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: projectsEnvelope([profile("alpha", "Alpha Name")]),
      },
      {
        source: "fixture-fallback",
        fallbackReason:
          "api boundary returned 501 NOT_IMPLEMENTED for /v1/attempts",
      },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.projects).toEqual([
      { projectId: "alpha", label: "Alpha Name", attempts: null },
    ]);
    expect(data.totalAttempts).toBeNull();
  });

  it("renders null counts when the attempts envelope has an unexpected shape", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: projectsEnvelope([profile("alpha", "Alpha Name")]),
      },
      {
        source: "api",
        data: { code: "OK", result: { outcome: "listed", total: 0, truncated: false } },
      },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("api");
    expect(data.projects).toEqual([
      { projectId: "alpha", label: "Alpha Name", attempts: null },
    ]);
    expect(data.totalAttempts).toBeNull();
  });

  it("falls back to the fixture with the client's reason when the project read fails", async () => {
    const client = fakeClient(
      {
        source: "fixture-fallback",
        fallbackReason:
          "api boundary returned 501 NOT_IMPLEMENTED for /v1/projects",
      },
      { source: "api", data: attemptsEnvelope([]) },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned 501 NOT_IMPLEMENTED for /v1/projects",
    );
    expect(data.projects).toEqual(
      getProjectAttemptCounts().map(([name, attempts]) => ({
        projectId: name,
        label: name,
        attempts,
      })),
    );
    expect(data.totalAttempts).toBe(totalAttemptsCount);
  });

  it("falls back to the fixture when the projects envelope has an unexpected shape", async () => {
    const client = fakeClient(
      {
        source: "api",
        data: { code: "OK", result: { outcome: "listed", profiles: "not-an-array" } },
      },
      { source: "api", data: attemptsEnvelope([]) },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned an unexpected project list shape",
    );
    expect(data.projects).toEqual(
      getProjectAttemptCounts().map(([name, attempts]) => ({
        projectId: name,
        label: name,
        attempts,
      })),
    );
    expect(data.totalAttempts).toBe(totalAttemptsCount);
  });

  it("uses the default fallback reason when the client gives null", async () => {
    const client = fakeClient(
      { source: "fixture-fallback", fallbackReason: null },
      { source: "api", data: attemptsEnvelope([]) },
    );

    const data = await loadProjectNav(client);

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe("the api client gave no fallback reason");
    expect(data.projects).toEqual(
      getProjectAttemptCounts().map(([name, attempts]) => ({
        projectId: name,
        label: name,
        attempts,
      })),
    );
    expect(data.totalAttempts).toBe(totalAttemptsCount);
  });
});
