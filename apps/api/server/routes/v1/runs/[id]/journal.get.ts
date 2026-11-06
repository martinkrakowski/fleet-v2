import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";
import { readQueryRecord } from "../../../../wiring/http-input";

// A-R: GET /v1/runs/:id/journal — one run's journal entries, bounded. The id
// is validated by the use case, so a malformed id is a 400 INVALID_REQUEST.
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await workComposition().laneRunReads.readJournalForRun({
      runId: getRouterParam(event, "id"),
      query: readQueryRecord(event),
    });
    if (result.outcome === "listed" || result.outcome === "unknown") {
      return envelope(operationId, "OK", result);
    }
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND", result);
    }
    setResponseStatus(event, 400);
    return envelope(operationId, "INVALID_REQUEST", result);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    setResponseStatus(event, 500);
    return envelope(operationId, "INTERNAL_ERROR");
  }
});
