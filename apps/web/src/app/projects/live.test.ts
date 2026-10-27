import { readFileSync } from "node:fs";
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

  it("returns project null on fixture-fallback when the id is not in the sample set", async () => {
    const fallbackReason =
      "api boundary returned 501 NOT_IMPLEMENTED for /v1/projects/ghost";
    const data = await loadProject(
      "ghost",
      fakeClient({
        view: {
          source: "fixture-fallback",
          status: 501,
          fallbackReason,
        },
      }),
      now,
    );

    expect(data).toEqual({
      source: "fixture-fallback",
      fallbackReason,
      observedAtIso: "2026-10-24T12:00:00.000Z",
      project: null,
    });
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

  it("reports the envelope code for /v1/projects/<id> when the payload has a non-OK string code", async () => {
    const data = await loadProject(
      "fleet-v2",
      fakeClient({
        view: { source: "api", data: { code: "REFUSED" } },
      }),
      now,
    );

    expect(data.source).toBe("fixture-fallback");
    expect(data.fallbackReason).toBe(
      "api boundary answered REFUSED for /v1/projects/fleet-v2",
    );
    expect(data.project?.projectId).toBe("fleet-v2");
  });
});

describe("projects client source text", () => {
  const listSource = readFileSync(
    new URL("./projects-client.tsx", import.meta.url),
    "utf8",
  );
  const detailSource = readFileSync(
    new URL("./[id]/project-detail-client.tsx", import.meta.url),
    "utf8",
  );

  it("pins both data.source header branches in projects-client.tsx", () => {
    const headerStart = listSource.indexOf("<PageHeader");
    const actionsStart = listSource.indexOf("actions={", headerStart);
    const descriptionBlock = listSource.slice(headerStart, actionsStart);

    expect(descriptionBlock).toContain('data.source === "api" ?');
    const [apiBranch, fallbackBranch] =
      descriptionBlock.split('data.source === "api" ?')[1]?.split(") : (") ?? [];

    expect(apiBranch).toContain("One row per registered project profile.");
    expect(apiBranch).toContain("the table is a recorded read of");
    expect(fallbackBranch).toContain("The rows are sample data, not a live read of");
    expect(fallbackBranch).not.toContain("the table is a recorded read of");
  });

  it("pins both data.source header branches, the 404 branch, the missing-sample branch and the CLI commands card in project-detail-client.tsx", () => {
    expect(detailSource).toContain(
      "the API answered 404 for GET /v1/projects/{projectId}",
    );
    expect(detailSource).toContain(
      "the API answered 404 for GET /v1/projects/${projectId}",
    );
    expect(detailSource).not.toContain("NOT_FOUND");
    expect(detailSource).toContain(
      "not in the sample data (the API is not answering: {reason})",
    );
    expect(detailSource).toContain(
      "not in the sample data (the API is not answering: ${reason})",
    );
    expect(detailSource).toContain(
      '<CardHeader title="CLI commands" subtitle="CLI commands for this project" />',
    );
    expect(detailSource).not.toContain('title="Actions"');

    const profileHeaderStart = detailSource.indexOf("title={project.displayName}");
    const actionsStart = detailSource.indexOf("actions={", profileHeaderStart);
    const descriptionBlock = detailSource.slice(profileHeaderStart, actionsStart);

    expect(descriptionBlock).toContain('data.source === "api" ?');
    const [apiBranch, fallbackBranch] =
      descriptionBlock.split('data.source === "api" ?')[1]?.split(") : (") ?? [];

    expect(apiBranch).toContain("The recorded profile for");
    expect(apiBranch).toContain("read live from");
    expect(fallbackBranch).toContain("the rows are sample data");
    expect(fallbackBranch).toContain("not a live read of");
    expect(fallbackBranch).not.toContain("read live from");
  });

  it("pins both fixture-fallback meta line retry texts in projects-client.tsx and project-detail-client.tsx", () => {
    for (const source of [listSource, detailSource]) {
      const metaStart = source.indexOf("<p className={styles.meta}>");
      const metaEnd = source.indexOf("</p>", metaStart);
      const metaBlock = source.slice(metaStart, metaEnd);

      expect(metaBlock).toContain('startsWith("api boundary answered")');
      expect(metaBlock).toContain(
        'startsWith("api boundary returned an unexpected")',
      );
      expect(metaBlock).toContain(
        "the API answered with something this page cannot read; retrying every 30 s",
      );
      expect(metaBlock).toContain(
        "the API did not answer; retrying every 30 s",
      );
    }
  });

describe("projects list empty states", () => {
  it("tells an empty station how to register a project, separately from a filter miss", () => {
    const source = readFileSync(
      new URL("./projects-client.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("data.projects.length === 0 ?");
    expect(source).toContain("No projects registered.");
    expect(source).toContain("fleet-v2 projects add");
    expect(source).toContain("fleet-v2 projects adopt");
    expect(source).toContain("No profiles match this filter.");
  });
});
});
