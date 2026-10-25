/**
 * Server-side loader for the sidebar's project nav data.
 *
 * Reads active profiles via `GET /v1/projects` and attempt counts via
 * `GET /v1/attempts` through the web API client. A projects read that cannot
 * be trusted (unconfigured, unreachable or an unexpected shape) falls back to
 * the deterministic station fixture list and reports why. Attempt counts are
 * best-effort: a failed or truncated attempts read yields null counts so the
 * nav shows no count rather than a wrong one. "All" (`totalAttempts`) counts
 * every attempt the API lists (all projects, retired and unregistered
 * included), matching an unfiltered `/lanes`.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../lib/api-client";
import {
  getProjectAttemptCounts,
  totalAttemptsCount,
} from "../fixtures/station-fixture";
import { parseProjectListEnvelope } from "../app/projects/map-project";
import { parseAttemptListEnvelope } from "../app/lanes/map-attempt";

export interface ProjectNavProject {
  readonly projectId: string;
  readonly label: string;
  readonly attempts: number | null;
}

export interface ProjectNavData {
  readonly source: "api" | "fixture-fallback";
  readonly fallbackReason: string | null;
  readonly countsReason: string | null;
  readonly projects: readonly ProjectNavProject[];
  /**
   * Count for the "All" row: every attempt the API lists (all projects,
   * retired and unregistered included), matching an unfiltered `/lanes`.
   */
  readonly totalAttempts: number | null;
}

const FIXTURE_PROJECTS: readonly ProjectNavProject[] = Object.freeze(
  getProjectAttemptCounts().map(([name, attempts]) =>
    Object.freeze({
      projectId: name,
      label: name,
      attempts,
    }),
  ),
);

const FIXTURE_PROJECT_NAV: ProjectNavData = Object.freeze({
  source: "fixture-fallback",
  fallbackReason: null,
  countsReason: null,
  projects: FIXTURE_PROJECTS,
  totalAttempts: totalAttemptsCount,
});

function fixtureProjectNavData(reason: string): ProjectNavData {
  return {
    ...FIXTURE_PROJECT_NAV,
    fallbackReason: reason,
  };
}

function shapeReason(
  payload: unknown,
  path: string,
  fallback: string,
): string {
  const code =
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).code === "string"
      ? ((payload as Record<string, unknown>).code as string)
      : null;
  return code !== null && code !== "OK"
    ? `api boundary answered ${code} for ${path}`
    : fallback;
}

/** Explicit UTF-16 code-unit order so sorting never depends on locale rules. */
function compareByProjectId(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * The sidebar's project list. It feeds the ROOT layout, so it never throws:
 * any failure (including building the client) falls back to the labelled
 * sample list rather than taking every page down.
 */
export async function loadProjectNav(client?: FleetWebApiClient): Promise<ProjectNavData> {
  try {
    return await loadProjectNavFrom(client ?? createFleetWebApiClient());
  } catch {
    return fixtureProjectNavData("the project list could not be loaded");
  }
}

async function loadProjectNavFrom(client: FleetWebApiClient): Promise<ProjectNavData> {
  const projectsEndpoint = await client.fetchProjectList(
    { status: "active" },
    null,
  );

  if (projectsEndpoint.source === "fixture-fallback") {
    return fixtureProjectNavData(
      projectsEndpoint.fallbackReason ??
        "the api client gave no fallback reason",
    );
  }

  const parsedProjects = parseProjectListEnvelope(projectsEndpoint.data);
  if (!parsedProjects) {
    return fixtureProjectNavData(
      shapeReason(
        projectsEndpoint.data,
        "/v1/projects",
        "api boundary returned an unexpected project list shape",
      ),
    );
  }

  const projects = parsedProjects.map((project) => ({
    projectId: project.projectId,
    label: project.displayName,
  }));

  const attemptsEndpoint = await client.fetchAttemptList({ limit: 200 }, null);
  const parsedAttempts =
    attemptsEndpoint.source === "api"
      ? parseAttemptListEnvelope(attemptsEndpoint.data)
      : null;

  if (parsedAttempts === null || parsedAttempts.truncated) {
    // Keep the live project list; counts are unavailable, show none.
    const countsReason =
      attemptsEndpoint.source === "fixture-fallback"
        ? (attemptsEndpoint.fallbackReason ??
          "the api client gave no fallback reason")
        : parsedAttempts === null
          ? shapeReason(
              attemptsEndpoint.data,
              "/v1/attempts",
              "api boundary returned an unexpected attempt list shape",
            )
          : "attempt counts unavailable: more than 200 attempts";
    return {
      source: "api",
      fallbackReason: null,
      countsReason,
      projects: projects
        .map((project) => ({ ...project, attempts: null }))
        .sort((a, b) => compareByProjectId(a.projectId, b.projectId)),
      totalAttempts: null,
    };
  }

  const counts = new Map<string, number>();
  for (const row of parsedAttempts.rows) {
    const projectId = row.workOrder?.projectId;
    if (projectId !== undefined) {
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
  }

  return {
    source: "api",
    fallbackReason: null,
    countsReason: null,
    projects: projects
      .map((project) => ({
        ...project,
        attempts: counts.get(project.projectId) ?? 0,
      }))
      .sort((a, b) => compareByProjectId(a.projectId, b.projectId)),
    // "All" counts every attempt the API lists (all projects, retired and
    // unregistered included), matching an unfiltered /lanes.
    totalAttempts: parsedAttempts.rows.length,
  };
}
