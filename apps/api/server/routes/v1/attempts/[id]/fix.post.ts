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
  // limiter is keyed on the prior attempt id: a fix round works on the
  // prior's worktree, so two fixes for the same prior never overlap.
  const priorAttemptId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const composition = workComposition();
    const body = await readObjectBody(event);
    const prepared = await composition.attemptLimiter.run(
      priorAttemptId,
      () => composition.prepareFixAttempt.execute({ ...body, priorAttemptId }),
    );
    if (!prepared.ok) {
      if (prepared.reason === "busy-project") {
        setResponseStatus(event, 409);
        return envelope(operationId, "BUSY", {
          reason: `a fix for ${priorAttemptId} is already running`,
        });
      }
      setResponseStatus(event, 429);
      return envelope(operationId, "BUSY", {
        reason: "attempt capacity is busy; retry shortly",
      });
    }
    return envelope(operationId, "OK", prepared.value);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
