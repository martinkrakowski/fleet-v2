import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
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
    // The body is validated, but its fields are ignored.
    await readObjectBody(event);
    const cancelled = await composition.cancelPreparedLimiter.run(attemptId, () =>
      composition.cancelPreparedAttempt.cancelPreparedAttempt({
        attemptId,
        nowIso: new Date().toISOString(),
      }),
    );
    if (!cancelled.ok) {
      if (cancelled.reason === "busy-project") {
        setResponseStatus(event, 409);
        return envelope(operationId, "BUSY", {
          reason: `a cancel of ${attemptId} is already running`,
        });
      }
      setResponseStatus(event, 429);
      return envelope(operationId, "BUSY", {
        reason: "attempt capacity is busy; retry shortly",
      });
    }
    return envelope(operationId, "OK", cancelled.value);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
