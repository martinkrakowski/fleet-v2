/**
 * Shared HTTP read for every web reader.
 *
 * Resolves to a `LiveEndpointResult` and never throws; the token is passed in,
 * never read here.
 */

/** Status the API boundary returns for a use case that is not implemented. */
export const NOT_IMPLEMENTED_STATUS = 501;

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

const PLAIN_WORDS = /^[A-Za-z ]{1,80}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * A host-free reason for a failed request: the raw message can name the API host (an ENOTFOUND
 * message, a URL), and this text reaches the page. Keep only a plain-words message ("fetch failed")
 * and the system error code (ENOTFOUND, ECONNREFUSED), never the original text.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  const words = PLAIN_WORDS.test(error.message) ? error.message : "request failed";
  const cause = (error as { readonly cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null ? (cause as { readonly code?: unknown }).code : undefined;
  if (typeof code === "string" && ERROR_CODE.test(code)) {
    return words + " (" + code + ")";
  }
  return words;
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

/** One endpoint read: the path under the API origin and the fixture to fall back to. */
export type EndpointRead = <T>(
  path: string,
  fallback: T,
) => Promise<LiveEndpointResult<T>>;

export interface EndpointReaderSettings {
  /** Trimmed origin; "" means unconfigured (fixture fallback, no request). */
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  /** Bearer token read server side by the caller, or null. */
  readonly token: string | null;
}

export function createEndpointReader(
  settings: EndpointReaderSettings,
): EndpointRead {
  const { baseUrl, fetchImpl, timeoutMs, token } = settings;

  /**
   * Reads one endpoint and degrades to `fallback` on every failure mode. The
   * JSON body is cast to `T` at this boundary: it comes from our own API, and
   * the fixture stays the authority whenever the body cannot be trusted.
   */
  return async function read<T>(
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
  };
}
