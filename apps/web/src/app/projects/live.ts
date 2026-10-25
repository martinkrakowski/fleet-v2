/**
 * Server-side loader for the Projects views' live data layer.
 *
 * Reads `GET /v1/projects` and `GET /v1/projects/:id` through the web API
 * client and degrades to the deterministic fixture when the boundary is
 * unconfigured, unimplemented or returns an unexpected shape. The fixture is
 * the authority whenever the API body cannot be trusted, so the view renders
 * rows and reports why. A live 404 for one project is different: it means the
 * project is not registered, never a reason to show sample data.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import { sampleProjects } from "./fixture";
import {
  parseProjectEnvelope,
  parseProjectListEnvelope,
  type ProjectView,
} from "./map-project";

export interface ProjectsData {
  source: "api" | "fixture-fallback";
  fallbackReason: string | null;
  observedAtIso: string;
  projects: ProjectView[];
}

export interface ProjectDetailData {
  source: "api" | "fixture-fallback";
  fallbackReason: string | null;
  observedAtIso: string;
  project: ProjectView | null;
}

function fixtureProjectsData(reason: string, observedAtIso: string): ProjectsData {
  return {
    source: "fixture-fallback",
    fallbackReason: reason,
    observedAtIso,
    projects: [...sampleProjects],
  };
}

function fixtureProjectData(
  reason: string,
  observedAtIso: string,
  projectId: string,
): ProjectDetailData {
  const project =
    sampleProjects.find((p) => p.projectId === projectId) ?? null;
  return {
    source: "fixture-fallback",
    fallbackReason: reason,
    observedAtIso,
    project,
  };
}

function shapeReason(
  payload: unknown,
  fallback: string,
): string {
  const code =
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).code === "string"
      ? ((payload as Record<string, unknown>).code as string)
      : null;
  return code !== null && code !== "OK"
    ? `api boundary answered ${code} for /v1/projects`
    : fallback;
}

export async function loadProjects(
  client: FleetWebApiClient = createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<ProjectsData> {
  const observedAtIso = now().toISOString();
  const endpoint = await client.fetchProjectList({}, null);

  if (endpoint.source === "fixture-fallback") {
    return fixtureProjectsData(
      endpoint.fallbackReason ?? "the api client gave no fallback reason",
      observedAtIso,
    );
  }

  const parsed = parseProjectListEnvelope(endpoint.data);
  if (!parsed) {
    return fixtureProjectsData(
      shapeReason(endpoint.data, "api boundary returned an unexpected project list shape"),
      observedAtIso,
    );
  }

  return {
    source: "api",
    fallbackReason: null,
    observedAtIso,
    projects: parsed,
  };
}

export async function loadProject(
  projectId: string,
  client: FleetWebApiClient = createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<ProjectDetailData> {
  const observedAtIso = now().toISOString();
  const endpoint = await client.fetchProjectView(projectId, null);

  if (endpoint.source === "fixture-fallback") {
    // A live 404 means the project is not registered. Never show the fixture.
    if (endpoint.status === 404) {
      return {
        source: "api",
        fallbackReason: null,
        observedAtIso,
        project: null,
      };
    }
    return fixtureProjectData(
      endpoint.fallbackReason ?? "the api client gave no fallback reason",
      observedAtIso,
      projectId,
    );
  }

  const parsed = parseProjectEnvelope(endpoint.data);
  if (!parsed) {
    return fixtureProjectData(
      shapeReason(endpoint.data, "api boundary returned an unexpected project shape"),
      observedAtIso,
      projectId,
    );
  }

  return {
    source: "api",
    fallbackReason: null,
    observedAtIso,
    project: parsed,
  };
}
