/**
 * Typed HTTP boundary client for the `apps/web` operator views.
 *
 * The web app has no domain-package dependencies: every view reads the HTTP
 * API boundary (`/v1/*`) and falls back deterministically to the typed local
 * fixture the caller supplies when the boundary is unconfigured, offline,
 * unimplemented (`501 NOT_IMPLEMENTED`) or otherwise unsuccessful.
 *
 * Nothing here throws. Every method resolves to a `LiveEndpointResult`, so a
 * view renders the fixture and reports why it did so instead of crashing.
 */

/** Status the API boundary returns for a use case that is not implemented. */
export const NOT_IMPLEMENTED_STATUS = 501;

export interface FleetWebApiClientOptions {
  /** Origin of the API boundary, e.g. `http://localhost:3001`. */
  readonly baseUrl?: string;
  /** Injectable `fetch`, for tests and for runtimes with their own transport. */
  readonly fetchImpl?: typeof fetch;
}

/** Where the payload in a `LiveEndpointResult` came from. */
export type LiveEndpointSource = "api" | "fixture-fallback";

export interface LiveEndpointResult<T> {
  readonly source: LiveEndpointSource;
  /** HTTP status, or `null` when no response was ever received. */
  readonly status: number | null;
  readonly data: T;
  /** Why the fixture was used, or `null` when the API answered. */
  readonly fallbackReason: string | null;
}

export interface FleetWebApiClient {
  fetchWorkOrderView<T>(
    workOrderId: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchAttemptView<T>(
    attemptId: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchHeadEvidenceView<T>(
    headSha: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchCoordinationView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
  fetchAttentionView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
}

function apiResult<T>(
  status: number,
  data: T,
): LiveEndpointResult<T> {
  return { source: "api", status, data, fallbackReason: null };
}

function fixtureFallback<T>(
  status: number | null,
  fallback: T,
  fallbackReason: string,
): LiveEndpointResult<T> {
  return { source: "fixture-fallback", status, data: fallback, fallbackReason };
}

/** Trailing slashes on `baseUrl` must not double up with the path slash. */
function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function createFleetWebApiClient(
  options: FleetWebApiClientOptions = {},
): FleetWebApiClient {
  const baseUrl = options.baseUrl?.trim() ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  /**
   * Reads one endpoint and degrades to `fallback` on every failure mode. The
   * JSON body is cast to `T` at this boundary: it comes from our own API, and
   * the fixture stays the authority whenever the body cannot be trusted.
   */
  async function read<T>(
    path: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>> {
    if (baseUrl.length === 0) {
      return fixtureFallback(
        null,
        fallback,
        "api boundary is not configured",
      );
    }

    const url = endpointUrl(baseUrl, path);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      return fixtureFallback(
        null,
        fallback,
        `api boundary is unreachable: ${describeFailure(error)}`,
      );
    }

    if (response.status === NOT_IMPLEMENTED_STATUS) {
      return fixtureFallback(
        response.status,
        fallback,
        `api boundary returned ${NOT_IMPLEMENTED_STATUS} ` +
          `NOT_IMPLEMENTED for ${path}`,
      );
    }

    if (!response.ok) {
      return fixtureFallback(
        response.status,
        fallback,
        `api boundary returned ${response.status} for ${path}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return fixtureFallback(
        response.status,
        fallback,
        `api boundary returned unparseable JSON for ${path}: ` +
          describeFailure(error),
      );
    }

    return apiResult(response.status, payload as T);
  }

  return {
    fetchWorkOrderView<T>(
      workOrderId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(
        `/v1/work-orders/${encodeURIComponent(workOrderId)}`,
        fallback,
      );
    },
    fetchAttemptView<T>(
      attemptId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(`/v1/attempts/${encodeURIComponent(attemptId)}`, fallback);
    },
    fetchHeadEvidenceView<T>(
      headSha: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(
        `/v1/heads/${encodeURIComponent(headSha)}/evidence`,
        fallback,
      );
    },
    fetchCoordinationView<T>(
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read("/v1/coordination", fallback);
    },
    fetchAttentionView<T>(
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read("/v1/attention", fallback);
    },
  };
}