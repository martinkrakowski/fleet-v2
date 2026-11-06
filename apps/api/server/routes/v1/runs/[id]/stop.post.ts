import { defineEventHandler, setResponseStatus } from "h3";
import { LANE_RUN_ID_PATTERN } from "@fleet/work-execution";
import { workComposition } from "../../../../wiring/work/composition";
import { newUlid } from "../../../../wiring/work/ulid";
import { envelope } from "../../../../wiring/work/errors";
import {
  busyResponse,
  failureResponse,
  refusedResponse,
  resolveOperationId,
} from "../../../../wiring/work/run-control-response";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  // routeParam has fully decoded the id; it is the limiter key and the id the use case receives.
  const runId = routeParam(event, "id");
  const body = await readObjectBody(event);
  const operationId = resolveOperationId(body, event);
  // operationId is transport metadata, never part of the stop request.
  const payload = { ...body };
  delete payload.operationId;
  try {
    const composition = workComposition();
    // Only expectedRevision (required here) and mode are accepted; any extra
    // key refuses with invalid-request inside the use case, after an
    // unconfigured composition has already thrown Not implemented.
    const hasMode = Object.hasOwn(payload, "mode");
    const hasExpectedRevision = Object.hasOwn(payload, "expectedRevision");
    const hasExtraKey = Object.keys(payload).some(
      (key) => key !== "expectedRevision" && key !== "mode",
    );
    // Invalid :id strings share one limiter bucket so arbitrary paths cannot
    // grow the per-key in-flight set without bound.
    const limiterKey = LANE_RUN_ID_PATTERN.test(runId) ? runId : "invalid-run-id";
    const ran = await composition.runControlLimiter.run(limiterKey, () => {
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
      return busyResponse(event, operationId, ran.reason);
    }
    const result = ran.value;
    if (result.outcome === "refused") {
      return refusedResponse(event, operationId, result);
    }
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND", result);
    }
    return envelope(operationId, "OK", result);
  } catch (error) {
    return failureResponse(event, operationId, error, "run-store-unavailable");
  }
});
