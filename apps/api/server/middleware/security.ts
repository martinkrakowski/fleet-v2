import { timingSafeEqual } from "node:crypto";
import {
  defineEventHandler,
  getMethod,
  getRequestHeader,
  getRequestPath,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import { isFleetApiRuntimeConfigured } from "../wiring/runtime";
import { getActiveApiToken } from "../wiring/token";

export default defineEventHandler((event) => {
  const path = getRequestPath(event);
  if (!path.startsWith("/v1/") && path !== "/v1") {
    return;
  }

  // When the runtime is unconfigured, keep today's 501 behaviour (middleware does not need the token then).
  if (!isFleetApiRuntimeConfigured()) {
    return;
  }

  // Refuse any request carrying an Origin header unless it is in FLEET_API_ALLOWED_ORIGINS
  const originHeader = getRequestHeader(event, "origin");
  if (originHeader !== undefined && originHeader !== null && originHeader.trim().length > 0) {
    const origin = originHeader.trim();
    const allowedOriginsEnv = process.env.FLEET_API_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = allowedOriginsEnv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!allowedOrigins.includes(origin)) {
      setResponseStatus(event, 403);
      setResponseHeader(event, "content-type", "application/json");
      return { error: "Forbidden origin" };
    }
  }

  // Require Content-Type: application/json on every non-GET request
  const method = getMethod(event).toUpperCase();
  if (method !== "GET") {
    const contentType = getRequestHeader(event, "content-type");
    const isJson =
      typeof contentType === "string" &&
      (contentType.trim().toLowerCase() === "application/json" ||
        contentType.trim().toLowerCase().startsWith("application/json;"));
    if (!isJson) {
      setResponseStatus(event, 415);
      setResponseHeader(event, "content-type", "application/json");
      return { error: "Unsupported Media Type: Content-Type must be application/json" };
    }
  }

  // Require Authorization: Bearer <token> (constant-time compare via crypto.timingSafeEqual on equal-length buffers)
  const authHeader = getRequestHeader(event, "authorization");
  if (!authHeader || typeof authHeader !== "string") {
    setResponseStatus(event, 401);
    setResponseHeader(event, "content-type", "application/json");
    return { error: "Unauthorized: missing Authorization header" };
  }

  if (!authHeader.startsWith("Bearer ")) {
    setResponseStatus(event, 401);
    setResponseHeader(event, "content-type", "application/json");
    return { error: "Unauthorized: invalid Authorization format" };
  }

  const candidate = authHeader.slice("Bearer ".length).trim();
  const activeToken = getActiveApiToken();
  if (!activeToken) {
    setResponseStatus(event, 401);
    setResponseHeader(event, "content-type", "application/json");
    return { error: "Unauthorized: api token not configured" };
  }

  const activeBuf = Buffer.from(activeToken, "utf8");
  const candidateBuf = Buffer.from(candidate, "utf8");

  if (
    activeBuf.length !== candidateBuf.length ||
    !timingSafeEqual(activeBuf, candidateBuf)
  ) {
    setResponseStatus(event, 401);
    setResponseHeader(event, "content-type", "application/json");
    return { error: "Unauthorized: invalid bearer token" };
  }
});
