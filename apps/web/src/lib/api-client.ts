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

import * as fs from "node:fs";

/** Status the API boundary returns for a use case that is not implemented. */
export const NOT_IMPLEMENTED_STATUS = 501;

const DEFAULT_TIMEOUT_MS = 5000;

export interface FleetWebApiClientOptions {
  /** Origin of the API boundary, e.g. `http://localhost:3001`. */
  readonly baseUrl?: string;
  /** Injectable `fetch`, for tests and for runtimes with their own transport. */
  readonly fetchImpl?: typeof fetch;
  /** Explicit token file path override. */
  readonly tokenFile?: string;
  /** Per-request timeout in milliseconds (default 5000). */
  readonly timeoutMs?: number;
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
  fetchAttemptList<T>(
    query: { readonly limit?: number; readonly projectId?: string },
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchHeadEvidenceView<T>(
    headSha: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchCoordinationView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
  fetchAttentionView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
  fetchProjectList<T>(
    query: { readonly status?: "active" | "retired" },
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
  fetchProjectView<T>(
    projectId: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
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

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { readonly name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ??
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason ??
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function readWebClientApiToken(tokenFile?: string): string | null {
  if (typeof window !== "undefined") {
    return null;
  }
  const filePath =
    tokenFile !== undefined
      ? tokenFile.trim()
      : (typeof process !== "undefined"
          ? process.env.FLEET_API_TOKEN_FILE
          : undefined)?.trim() ?? "";

  if (filePath.length === 0) {
    return null;
  }

  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    if ((stats.mode & 0o077) !== 0) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? "";
    if (firstLine.length < 32 || !/^[A-Za-z0-9_-]{32,}$/.test(firstLine)) {
      return null;
    }
    return firstLine;
  } catch {
    return null;
  }
}

export function createFleetWebApiClient(
  options: FleetWebApiClientOptions = {},
): FleetWebApiClient {
  // An explicit baseUrl wins as written: "" keeps forcing the unconfigured
  // fixture fallback in unit tests. Only an omitted baseUrl falls back to
  // the API origin configured through the environment, so the deployed app
  // binds to its API boundary without each view passing one.
  const baseUrl =
    options.baseUrl !== undefined
      ? options.baseUrl.trim()
      : (typeof process !== "undefined"
          ? (process.env.FLEET_API_URL ?? process.env.NEXT_PUBLIC_FLEET_API_URL)
          : undefined
        )?.trim() ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = readWebClientApiToken(options.tokenFile);

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

    const headers: Record<string, string> = { accept: "application/json" };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        // Every API read is live state: a server render must never reuse a cached answer.
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return fixtureFallback(
          null,
          fallback,
          `api boundary timed out after ${timeoutMs} ms for ${path}`,
        );
      }
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
      payload = await withAbortSignal(response.json(), signal);
    } catch (error) {
      if (isAbortError(error)) {
        return fixtureFallback(
          null,
          fallback,
          `api boundary timed out after ${timeoutMs} ms for ${path}`,
        );
      }
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
    fetchAttemptList<T>(
      query: { readonly limit?: number; readonly projectId?: string },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      const params = new URLSearchParams();
      if (query.limit !== undefined) {
        params.set("limit", String(query.limit));
      }
      if (query.projectId !== undefined) {
        params.set("projectId", query.projectId);
      }
      const queryString = params.toString();
      return read(
        queryString ? `/v1/attempts?${queryString}` : "/v1/attempts",
        fallback,
      );
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
    fetchProjectList<T>(
      query: { readonly status?: "active" | "retired" },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      const params = new URLSearchParams();
      if (query.status !== undefined) {
        params.set("status", query.status);
      }
      const queryString = params.toString();
      return read(
        queryString ? `/v1/projects?${queryString}` : "/v1/projects",
        fallback,
      );
    },
    fetchProjectView<T>(
      projectId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(`/v1/projects/${encodeURIComponent(projectId)}`, fallback);
    },
  };
}