import type { EndpointRead, LiveEndpointResult } from "./transport";

export interface AttemptReaders {
  fetchAttemptView<T>(
    attemptId: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchAttemptList<T>(
    query: { readonly limit?: number; readonly projectId?: string },
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
}

export function attemptListPath(query: {
  readonly limit?: number;
  readonly projectId?: string;
}): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.projectId !== undefined) {
    params.set("projectId", query.projectId);
  }
  const queryString = params.toString();
  return queryString ? `/v1/attempts?${queryString}` : "/v1/attempts";
}

export function createAttemptReaders(read: EndpointRead): AttemptReaders {
  return {
    fetchAttemptView<T>(
      attemptId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(`/v1/attempts/${encodeURIComponent(attemptId)}`, fallback);
    },
    fetchAttemptList<T>(
      query: { readonly limit?: number; readonly projectId?: string },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(attemptListPath(query), fallback);
    },
  };
}
