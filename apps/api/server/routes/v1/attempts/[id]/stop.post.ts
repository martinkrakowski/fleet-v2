import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import type { GuardedStopAttemptResult } from "../../../../wiring/work/stop-attempt-guard";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  // routeParam has fully decoded the id; it is the limiter key and the id the use case receives.
  const attemptId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const composition = workComposition();
    const body = await readObjectBody(event);
    const stopped = await composition.attemptLimiter.run(attemptId, () =>
      composition.stopAttempt.execute({ ...body, attemptId }),
    );
    if (!stopped.ok) {
      if (stopped.reason === "busy-project") {
        setResponseStatus(event, 409);
        return envelope(operationId, "BUSY", {
          reason: `a stop of ${attemptId} is already running`,
        });
      }
      setResponseStatus(event, 429);
      return envelope(operationId, "BUSY", {
        reason: "attempt capacity is busy; retry shortly",
      });
    }
    const result: GuardedStopAttemptResult = stopped.value;
    // A-C: run ownership is decided before the stop runs. An attempt any lane
    // run lists is refused with a runId pointer; an unreadable run store
    // fails closed as unknown.
    if (result.outcome === "unknown" && !("attempt" in result)) {
      setResponseStatus(event, 503);
      return envelope(operationId, "STORE_UNAVAILABLE", result);
    }
    if (result.outcome === "refused") {
      const reason = String(result.reason);
      if (reason === "run-owned") {
        setResponseStatus(event, 409);
        return envelope(operationId, "CONFLICT", result);
      }
      if (reason === "invalid-request") {
        setResponseStatus(event, 400);
        return envelope(operationId, "INVALID_REQUEST", result);
      }
      if (reason.startsWith("Attempt not found")) {
        setResponseStatus(event, 404);
        return envelope(operationId, "NOT_FOUND", result);
      }
      setResponseStatus(event, 409);
      return envelope(operationId, "CONFLICT", result);
    }
    return envelope(operationId, "OK", result);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
