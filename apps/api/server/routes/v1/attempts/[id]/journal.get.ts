// GET /v1/attempts/:id/journal — ListAttemptJournal (plan P1-J): a plain read, no legality block.
import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await workComposition().listAttemptJournal.execute({
      attemptId: getRouterParam(event, "id") ?? "",
    });
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND");
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
