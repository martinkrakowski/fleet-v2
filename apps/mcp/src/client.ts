import { lstatSync, readFileSync } from "node:fs";

/**
 * Loopback-only base URL. `FLEET_API_URL` must be http://127.0.0.1,
 * http://localhost or http://[::1] with an explicit port; anything else is
 * refused — the MCP server is a local client of the local `@fleet/api`.
 */
const LOOPBACK_URL_PATTERN =
  /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

/**
 * Read the API bearer token from a file, with the same checks as
 * `readApiTokenFromFile` in apps/api/server/wiring/token.ts (copied, not
 * imported — apps/mcp is a client of `/v1`, not a second composition root).
 *
 * The file must be an absolute path to a regular file (not a symlink) with no
 * group/other permission bits; the token is the first line, trimmed, at least
 * 32 characters long and composed only of `A-Z a-z 0-9 _ -`. Returns null on
 * any failure.
 */
export function readApiTokenFromFile(filePath: string): string | null {
  if (
    !filePath ||
    typeof filePath !== "string" ||
    filePath.trim().length === 0 ||
    !filePath.startsWith("/")
  ) {
    return null;
  }
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    // Must have no group/other mode bits: (stats.mode & 0o077) === 0
    if ((stats.mode & 0o077) !== 0) {
      return null;
    }
    const content = readFileSync(filePath, "utf8");
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{32,}$/.test(firstLine)) {
      return null;
    }
    return firstLine;
  } catch {
    return null;
  }
}

export interface ApiEnvelope {
  operationId: string;
  code: string;
  result: object | null;
}

export interface ApiClientError {
  ok: false;
  code: string;
  message: string;
  operationId?: string;
}

export type ApiClientResult = ApiEnvelope | ApiClientError;

export interface FleetApiClient {
  get(path: string): Promise<ApiClientResult>;
  post(path: string, body: unknown): Promise<ApiClientResult>;
}

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

function failure(
  code: string,
  message: string,
  operationId?: string,
): ApiClientError {
  return operationId === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, operationId };
}

/**
 * Validate a `/v1` request path. It must be relative to the configured base
 * URL: start with `/v1/`, contain no `//`, `..`, `@`, `\`, `#` or control
 * characters, and resolve to the same origin with a `/v1/` pathname. Returns
 * null when the path is refused.
 */
export function resolveApiPath(
  path: string,
  baseUrl: string,
): string | null {
  if (
    typeof path !== "string" ||
    !path.startsWith("/v1/") ||
    path.includes("//") ||
    path.includes("..") ||
    path.includes("@") ||
    path.includes("\\") ||
    path.includes("#") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(path, baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith("/v1/")) {
    return null;
  }
  return path;
}

/** Validate a base URL; loopback with an explicit port only. */
export function normalizeBaseUrl(baseUrl: string | undefined): string | null {
  if (typeof baseUrl !== "string") {
    return null;
  }
  return LOOPBACK_URL_PATTERN.test(baseUrl) ? baseUrl.replace(/\/$/, "") : null;
}

/**
 * Build the `/v1` client. `baseUrl` is the loopback API base URL;
 * `readToken` is called on every request so a rotated token file is picked up
 * without restarting the MCP server.
 */
export function createFleetApiClient(config: {
  baseUrl: string;
  readToken: () => string | null;
  fetch?: FetchLike;
}): FleetApiClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const doFetch: FetchLike = config.fetch ?? fetch;

  async function request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<ApiClientResult> {
    if (!baseUrl) {
      return failure(
        "not-configured",
        "FLEET_API_URL is missing or is not an allowed loopback URL with a port.",
      );
    }
    const token = config.readToken();
    if (!token) {
      return failure(
        "not-configured",
        "FLEET_API_TOKEN_FILE is missing, unreadable or has unsafe permissions.",
      );
    }
    const resolvedPath = resolveApiPath(path, baseUrl);
    if (!resolvedPath) {
      return failure(
        "invalid-path",
        "Path must be a /v1 route relative to the API base URL.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(new URL(resolvedPath, baseUrl).href, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        return failure(
          "response-too-large",
          "API response exceeds the 1 MiB limit.",
        );
      }
      // Enforce the 1 MiB cap while reading: as soon as the accumulated body
      // exceeds the cap, cancel the stream and abort the request.
      const reader = response.body?.getReader();
      let received: Uint8Array[] = [];
      let totalBytes = 0;
      let cancelled = false;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            cancelled = true;
            void reader.cancel().catch(() => undefined);
            controller.abort();
            break;
          }
          received.push(value);
        }
      }
      if (cancelled) {
        return failure(
          "response-too-large",
          "API response exceeds the 1 MiB limit.",
        );
      }
      const decoder = new TextDecoder();
      let text = received.reduce(
        (acc, chunk) => acc + decoder.decode(chunk, { stream: true }),
        "",
      );
      received = [];
      text += decoder.decode();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return failure("invalid-response", "API returned a non-JSON body.");
      }
      const envelope = parsed as Partial<ApiEnvelope>;
      if (
        response.ok &&
        typeof envelope.operationId === "string" &&
        typeof envelope.code === "string"
      ) {
        return parsed as ApiEnvelope;
      }
      if (!response.ok) {
        return failure(
          typeof envelope.code === "string" ? envelope.code : "http-error",
          "API request failed.",
          typeof envelope.operationId === "string" ? envelope.operationId : undefined,
        );
      }
      return failure(
        "invalid-response",
        "API returned an unexpected response shape.",
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return failure("timeout", "API unreachable: request timed out.");
      }
      return failure("transport-error", "API unreachable.");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (path: string) => request(path, "GET"),
    post: (path: string, body: unknown) => request(path, "POST", body),
  };
}
