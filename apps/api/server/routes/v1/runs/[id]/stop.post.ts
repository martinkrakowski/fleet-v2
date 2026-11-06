import { defineEventHandler, getHeader, setResponseStatus } from "h3";
import { LANE_RUN_ID_PATTERN } from "@fleet/work-execution";
import { workComposition } from "../../../../wiring/work/composition";
import { newUlid } from "../../../../wiring/work/ulid";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

/** The caller's id when it supplied a usable one; else a fresh operation id. */
function resolveOperationId(body: Record<string, unknown>, header: unknown): string {
  const fromHeader = typeof header === "string" ? header.trim() : "";
  if (fromHeader.length > 0 && fromHeader.length <= 128) {
    return fromHeader;
  }
  const fromBody = body.operationId;
  if (typeof fromBody === "string" && fromBody.trim().length > 0 && fromBody.length <= 128) {
    return fromBody;
  }
  return newOperationId();
}

export default defineEventHandler(async (event) => {
  // routeParam has fully decoded the id; it is the limiter key and the id the use case receives.
  const runId = routeParam(event, "id");
  const body = await readObjectBody(event);
  const operationId = resolveOperationId(body, getHeader(event, "idempotency-key"));
  // operationId is transport metadata, never part of the stop request.
  const payload = { ...body };
  delete payload.operationId;
  try {
    const composition = workComposition();
    // Only expectedRevision (required here) and mode are accepted; any extra
    // key refuses with invalid-request inside the use case, after an
    // unconfigured composition has already thrown Not implemented.
    const hasMode = Object.prototype.hasOwnProperty.call(payload, "mode");
    const hasExpectedRevision = Object.prototype.hasOwnProperty.call(payload, "expectedRevision");
    const hasExtraKey = Object.keys(payload).some(
      (key) => key !== "expectedRevision" && key !== "mode",
    );
    // Invalid :id strings share one limiter bucket so arbitrary paths cannot
    // grow the per-key in-flight set without bound.
    const limiterKey = LANE_RUN_ID_PATTERN.test(runId) ? runId : "invalid-run-id";
    const ran = await composition.runControlLimiter.run(limiterKey, async () => {
      return composition.requestLaneRunStop.requestLaneRunStop({
        runId,
        via: "web",
        entryId: newUlid(),
        nowIso: new Date().toISOString(),
        mode: hasMode ? payload.mode : "graceful",
        expectedRevision: hasExpectedRevision ? payload.expectedRevision : 0,
        ...(hasExtraKey ? { extraKey: true } : {}),
      } as Parameters<typeof composition.requestLaneRunStop.requestLaneRunStop>[0]);
    });
    if (!ran.ok) {
      setResponseStatus(event, ran.reason === "busy-global" ? 429 : 409);
      return envelope(operationId, "BUSY", { reason: ran.reason });
    }
    const result = ran.value;
    if (result.outcome === "refused") {
      if (result.reason === "invalid-request") {
        setResponseStatus(event, 400);
        return envelope(operationId, "INVALID_REQUEST", result);
      }
      setResponseStatus(event, 409);
      return envelope(operationId, "CONFLICT", result);
    }
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND", result);
    }
    return envelope(operationId, "OK", result);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    // Store errors can name the state directory or file; the caller gets one
    // fixed reason, never the message.
    setResponseStatus(event, 503);
    return envelope(operationId, "STORE_UNAVAILABLE", {
      outcome: "unknown",
      reason: "run-store-unavailable",
    });
  }
});
