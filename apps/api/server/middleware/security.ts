import { timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";
import {
  defineEventHandler,
  getMethod,
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import { isFleetApiRuntimeConfigured } from "../wiring/runtime";
import { getActiveApiToken } from "../wiring/token";
import {
  holdsScope,
  presentedToken,
  SHARED_BEARER_TOKEN_ID,
} from "../wiring/presented-token.js";
import { normalizePath, requiredScope } from "../wiring/route-scopes.js";
import {
  authenticateSessionExchange,
  isSessionExchangePath,
  resolveSessionToken,
} from "../wiring/session-exchange.js";
import { isWebLoginPath } from "../wiring/web-login.js";

const ALLOWED_UNAUTHENTICATED_PATHS = new Set(["/", "/health"]);

function isV1Path(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

function requestPathOf(event: H3Event): string {
  return normalizePath(event.path || "/");
}

function isAllowedOrigin(origin: string): boolean {
  const allowedOriginsEnv = process.env.FLEET_API_ALLOWED_ORIGINS ?? "";
  const allowedOrigins = allowedOriginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return allowedOrigins.includes(origin);
}

function forbid(event: H3Event, message: string): { error: string } {
  setResponseStatus(event, 403);
  setResponseHeader(event, "content-type", "application/json");
  return { error: message };
}

function unauthorized(event: H3Event, message: string): { error: string } {
  setResponseStatus(event, 401);
  setResponseHeader(event, "content-type", "application/json");
  return { error: message };
}

function authenticationFailure(
  event: H3Event,
  authHeader: string | undefined | null,
  requestPath: string,
): { error: string } | undefined {
  if (!authHeader || typeof authHeader !== "string") {
    return unauthorized(event, "Unauthorized: missing Authorization header");
  }
  if (!authHeader.startsWith("Bearer ")) {
    return unauthorized(event, "Unauthorized: invalid Authorization format");
  }
  const candidate = authHeader.slice("Bearer ".length).trim();
  const activeToken = getActiveApiToken();
  if (!activeToken) {
    return unauthorized(event, "Unauthorized: api token not configured");
  }
  const activeBuf = Buffer.from(activeToken, "utf8");
  const candidateBuf = Buffer.from(candidate, "utf8");
  if (
    activeBuf.length !== candidateBuf.length ||
    !timingSafeEqual(activeBuf, candidateBuf)
  ) {
    // T3b: a session-minted token authenticates through the in-memory registry
    // (memory only); the fallback applies only to /v1 paths, so a scoped token
    // never reaches an unscoped route. It is scope-checked afterwards like any non-shared token.
    if (isV1Path(requestPath) && resolveSessionToken(event) !== null) {
      return undefined;
    }
    return unauthorized(event, "Unauthorized: invalid bearer token");
  }
  return undefined;
}

function scopeFailure(
  event: H3Event,
  method: string,
  requestPath: string,
): { error: string } | undefined {
  const token = presentedToken(event);
  if (token.tokenId === SHARED_BEARER_TOKEN_ID) {
    return undefined;
  }
  const scope = requiredScope(method, requestPath);
  if (scope === null) {
    return forbid(event, "Forbidden: unmapped route");
  }
  if (!holdsScope(token, scope)) {
    return forbid(event, "Forbidden: scope required");
  }
  return undefined;
}

function hasJsonContentType(event: H3Event): boolean {
  const contentType = getRequestHeader(event, "content-type");
  return (
    typeof contentType === "string" &&
    (contentType.trim().toLowerCase() === "application/json" ||
      contentType.trim().toLowerCase().startsWith("application/json;"))
  );
}

export default defineEventHandler((event) => {
  // When the runtime is unconfigured, keep today's 501 behaviour (middleware does not need the token then).
  if (!isFleetApiRuntimeConfigured()) {
    return;
  }

  const requestPath = requestPathOf(event);

  if (ALLOWED_UNAUTHENTICATED_PATHS.has(requestPath)) {
    return;
  }

  // Refuse any request carrying an Origin header unless it is in FLEET_API_ALLOWED_ORIGINS
  const originHeader = getRequestHeader(event, "origin");
  if (originHeader !== undefined && originHeader !== null && originHeader.trim().length > 0) {
    if (!isAllowedOrigin(originHeader.trim())) {
      if (isSessionExchangePath(requestPath)) {
        setResponseHeader(event, "cache-control", "no-store");
      }
      return forbid(event, "Forbidden origin");
    }
  }

  const method = getMethod(event).toUpperCase();

  // T3b: /sessions/exchange is gated by the interactive session credential
  // (in-memory), not by the bearer token or the /v1 scope mapping.
  if (isSessionExchangePath(requestPath)) {
    const exchangeFailure = authenticateSessionExchange(event);
    if (exchangeFailure) {
      return exchangeFailure;
    }
    if (method !== "GET" && !hasJsonContentType(event)) {
      setResponseStatus(event, 415);
      setResponseHeader(event, "content-type", "application/json");
      setResponseHeader(event, "cache-control", "no-store");
      return { error: "Unsupported Media Type: Content-Type must be application/json" };
    }
    return;
  }

  // T6a: /sessions/login is a server-side call only. The login code is the
  // credential; no bearer is required and the /v1 scope map is not consulted.
  if (isWebLoginPath(requestPath)) {
    const loginOrigin = getRequestHeader(event, "origin");
    if (loginOrigin !== undefined && loginOrigin !== null && loginOrigin.trim().length > 0) {
      setResponseStatus(event, 403);
      setResponseHeader(event, "content-type", "application/json");
      setResponseHeader(event, "cache-control", "no-store");
      return { error: "Forbidden: the web login is a server-side call" };
    }
    if (method !== "POST") {
      setResponseStatus(event, 403);
      setResponseHeader(event, "content-type", "application/json");
      setResponseHeader(event, "cache-control", "no-store");
      return { error: "Forbidden: the web login is a POST" };
    }
    if (!hasJsonContentType(event)) {
      setResponseStatus(event, 415);
      setResponseHeader(event, "content-type", "application/json");
      setResponseHeader(event, "cache-control", "no-store");
      return { error: "Unsupported Media Type: Content-Type must be application/json" };
    }
    return;
  }

  // Require Authorization: Bearer <token> (constant-time compare via crypto.timingSafeEqual on equal-length buffers)
  const authFailure = authenticationFailure(
    event,
    getRequestHeader(event, "authorization"),
    requestPath,
  );
  if (authFailure) {
    return authFailure;
  }

  // T3a: enforce the route scope for non-shared tokens (the shared bearer keeps today's behaviour).
  if (isV1Path(requestPath)) {
    const scopeBody = scopeFailure(event, method, requestPath);
    if (scopeBody) {
      return scopeBody;
    }
  }

  // Require Content-Type: application/json on every non-GET request
  if (method !== "GET" && !hasJsonContentType(event)) {
    setResponseStatus(event, 415);
    setResponseHeader(event, "content-type", "application/json");
    return { error: "Unsupported Media Type: Content-Type must be application/json" };
  }
});
