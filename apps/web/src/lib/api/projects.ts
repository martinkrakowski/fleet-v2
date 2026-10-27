import type { EndpointRead, LiveEndpointResult } from "./transport";

export interface ProjectReaders {
  fetchProjectList<T>(
    query: { readonly status?: "active" | "retired" },
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchProjectView<T>(
    projectId: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
}

export function projectListPath(query: {
  readonly status?: "active" | "retired";
}): string {
  const params = new URLSearchParams();
  if (query.status !== undefined) {
    params.set("status", query.status);
  }
  const queryString = params.toString();
  return queryString ? `/v1/projects?${queryString}` : "/v1/projects";
}

export function createProjectReaders(read: EndpointRead): ProjectReaders {
  return {
    fetchProjectList<T>(
      query: { readonly status?: "active" | "retired" },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(projectListPath(query), fallback);
    },
    fetchProjectView<T>(
      projectId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(`/v1/projects/${encodeURIComponent(projectId)}`, fallback);
    },
  };
}
