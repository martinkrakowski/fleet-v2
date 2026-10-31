import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  // share one single-flight slot; routeParam has fully decoded the id.
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
    return envelope(operationId, "OK", stopped.value);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
