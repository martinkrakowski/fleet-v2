import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  // Trimmed exactly as the use case trims it, so the id and a padded id
  // share one single-flight slot; routeParam has fully decoded the id.
  const attemptId = routeParam(event, "id").trim();
  const operationId = newOperationId();
  try {
    const composition = workComposition();
    const body = await readObjectBody(event);
    const reconciled = await composition.attemptLimiter.run(attemptId, () =>
      composition.reconcileAttempt.execute({ ...body, attemptId }),
    );
    if (!reconciled.ok) {
      if (reconciled.reason === "busy-project") {
        setResponseStatus(event, 409);
        return envelope(operationId, "BUSY", {
          reason: `a reconcile of ${attemptId} is already running`,
        });
      }
      setResponseStatus(event, 429);
      return envelope(operationId, "BUSY", {
        reason: "attempt capacity is busy; retry shortly",
      });
    }
    return envelope(operationId, "OK", reconciled.value);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
