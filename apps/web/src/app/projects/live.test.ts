import { describe, expect, it } from "vitest";
import { loadProject, loadProjects } from "./live";
import { sampleProjects } from "./fixture";
import type {
  FleetWebApiClient,
  LiveEndpointResult,
} from "../../lib/api-client";

const PROJECT_WIRE = {
  projectId: "fleet-v2",
  displayName: "Fleet v2",
  repository: "https://example.com/fleet-v2.git",
  designatedDispatcherHost: "host-a",
  policyRevision: "pol-2026-10-11.3",
  maxConcurrentLanes: 4,
  runnerCapabilities: { networkEgressRestricted: true },
  status: "active",
  defaultBranch: "main",
  clones: {
    "host-a": {
      path: "/srv/clones/fleet-v2",
      worktreeRoot: "/srv/worktrees/fleet-v2",
    },
  },
  gateProcedures: ["typecheck", "lint"],
  defaultAllowedPathPrefixes: ["packages/**", "apps/**"],
  lastProbe: {
    probedAtIso: "2026-10-24T10:00:00Z",
    probedFrom: "host-a",
    checks: [
      {
        name: "repository reachable",
        host: "host-a",
        result: "pass",
        detail: "git ls-remote answered in 120 ms",
      },
    ],
  },
  revision: 12,
  updatedAtIso: "2026-10-24T09:55:00Z",
};

const LIST_ENVELOPE = {
  operationId: "op-p1",
  code: "OK",
  result: { outcome: "listed", profiles: [PROJECT_WIRE] },
};

const VIEW_ENVELOPE = {
  operationId: "op-p2",
  code: "OK",
  result: { outcome: "found", profile: PROJECT_WIRE },
};

type ProjectsReply =
  | { source: "api"; data: unknown }
  | {
      source: "fixture-fallback";
      status: number | null;
      fallbackReason: string | null;
    };

function fakeClient(replies: {
  list?: ProjectsReply;
  view?: ProjectsReply;
}): FleetWebApiClient & {
  readonly queries: { kind: "list" | "view"; id?: string }[];
} {
  const queries: { kind: "list" | "view"; id?: string }[] = [];
  const resolve = async <T>(
    reply: ProjectsReply | undefined,
    fallback: T,
  ): Promise<LiveEndpointResult<T>> => {
    if (!reply || reply.source === "fixture-fallback") {
      return {
        source: "fixture-fallback",
        status: reply?.source === "fixture-fallback" ? reply.status : null,
        data: fallback,
        fallbackReason:
          reply?.source === "fixture-fallback" ? reply.fallbackReason : null,
      };
    }
    return {
      source: "api",
      status: 200,
      data: reply.data as T,
      fallbackReason: null,
    };
  };
  return {
    queries,
    fetchProjectList: async <T>(
      _query: { readonly status?: "active" | "retired" },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      queries.push({ kind: "list" });
      return resolve(replies.list, fallback);
    },
    fetchProjectView: async <T>(
      id: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => {
      queries.push({ kind: "view", id });
      return resolve(replies.view, fallback);
    },
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
    fetchAttemptList: async () => {
      throw new Error("unused");
    },
  };
}

describe("loadProjects", () => {
  const now = () => new Date("2026-10-24T12:00:00Z");

  it("maps a valid API envelope with source api", async () => {
    const client = fakeClient({ list: { source: "api", data: LIST_ENVELOPE } });
    const data = await loadProjects(client, now);

    expect(client.queries).toEqual([{ kind: "list" }]);
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.observedAtIso).toBe("2026-10-24T12:00:00.000Z");
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].projectId).toBe("fleet-v2");
    expect(data.projects[0].lastProbe?.checks[0].result).toBe("pass");
  });

  it("falls back to the fixture with the client's reason", async () => {
    const data = await loadProjects(
      fakeClient({
        list: {
          source: "fixture-fallback",
          status: 501,
          fallbackReason: "api boundary returned 501 NOT_IMPLEMENTED for /v1/projects",
        },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned 501 NOT_IMPLEMENTED for /v1/projects",
    );
    expect(data.projects).toEqual([...sampleProjects]);
    expect(data.observedAtIso).toBe("2026-10-24T12:00:00.000Z");
  });

  it("uses the default fallback reason when the client gives null", async () => {
    const data = await loadProjects(
      fakeClient({
        list: { source: "fixture-fallback", status: null, fallbackReason: null },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe("the api client gave no fallback reason");
  });

  it("falls back to the fixture when the API shape is unexpected", async () => {
    const data = await loadProjects(
      fakeClient({
        list: {
          source: "api",
          data: { code: "OK", result: { outcome: "listed" } },
        },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned an unexpected project list shape",
    );
    expect(data.projects).toEqual([...sampleProjects]);
  });

  it("reports the envelope code when the payload has a non-OK string code", async () => {
    const data = await loadProjects(
      fakeClient({
        list: { source: "api", data: { code: "REFUSED" } },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary answered REFUSED for /v1/projects",
    );
  });

  it("uses the injected clock for observedAtIso", async () => {
    const data = await loadProjects(
      fakeClient({ list: { source: "api", data: LIST_ENVELOPE } }),
      () => new Date("2026-10-24T13:00:00Z"),
    );

    expect(data.observedAtIso).toBe("2026-10-24T13:00:00.000Z");
  });
});

describe("loadProject", () => {
  const now = () => new Date("2026-10-24T12:00:00Z");

  it("maps a valid found envelope with source api", async () => {
    const client = fakeClient({ view: { source: "api", data: VIEW_ENVELOPE } });
    const data = await loadProject("fleet-v2", client, now);

    expect(client.queries).toEqual([{ kind: "view", id: "fleet-v2" }]);
    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.project?.projectId).toBe("fleet-v2");
    expect(data.observedAtIso).toBe("2026-10-24T12:00:00.000Z");
  });

  it("maps a live 404 to project null with source api, never the fixture", async () => {
    const data = await loadProject(
      "not-registered",
      fakeClient({
        view: {
          source: "fixture-fallback",
          status: 404,
          fallbackReason: "api boundary returned 404 for /v1/projects/not-registered",
        },
      }),
      now,
    );

    expect(data.source).toBe("api");
    expect(data.fallbackReason).toBeNull();
    expect(data.project).toBeNull();
  });

  it("falls back to the fixture when the boundary is unconfigured", async () => {
    const data = await loadProject(
      "fleet-v2",
      fakeClient({
        view: {
          source: "fixture-fallback",
          status: null,
          fallbackReason: "api boundary is not configured",
        },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe("api boundary is not configured");
    expect(data.project?.projectId).toBe("fleet-v2");
  });

  it("falls back to the fixture with the first sample when the id is unknown to it", async () => {
    const data = await loadProject(
      "ghost",
      fakeClient({
        view: {
          source: "fixture-fallback",
          status: 501,
          fallbackReason: "api boundary returned 501 NOT_IMPLEMENTED for /v1/projects/ghost",
        },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toContain("NOT_IMPLEMENTED");
    expect(data.project?.projectId).toBe(sampleProjects[0].projectId);
  });

  it("falls back to the fixture when the API shape is unexpected", async () => {
    const data = await loadProject(
      "fleet-v2",
      fakeClient({
        view: {
          source: "api",
          data: { code: "OK", result: { outcome: "found" } },
        },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary returned an unexpected project shape",
    );
    expect(data.project?.projectId).toBe("fleet-v2");
  });
});
