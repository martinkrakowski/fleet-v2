import type { EndpointRead, LiveEndpointResult } from "./transport";

export const CONDUCTOR_PASSES_PATH = "/v1/runs/passes";

/**
 * The `GET /v1/runs/passes` path: the plain route without a query, or with
 * `?limit=<n>` when a limit is requested. The API bounds the ring at 32 and
 * returns the newest passes first.
 */
export function conductorPassesPath(query: {
  readonly limit?: number;
}): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const queryString = params.toString();
  return queryString ? `${CONDUCTOR_PASSES_PATH}?${queryString}` : CONDUCTOR_PASSES_PATH;
}

/**
 * The `GET /v1/runs/passes` reader. Optional on the composed client so
 * existing test fakes that spell out only the readers they exercise stay
 * assignable; the real client always provides it, and the Conductor server
 * loader treats an absent reader as not-configured.
 */
export interface ConductorPassReaders {
  fetchConductorPasses?<T>(
    query: { readonly limit?: number },
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
}

export function createConductorPassReaders(read: EndpointRead): ConductorPassReaders {
  return {
    fetchConductorPasses: async <T>(
      query: { readonly limit?: number },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> => read(conductorPassesPath(query), fallback),
  };
}
