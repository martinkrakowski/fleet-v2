import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readQueryRecord } from "../../../wiring/http-input";

// A-R: GET /v1/runs/:id — one run's board card and bounded journal. The id is
// validated by the use case (run-id pattern plus secret scan), so a malformed
// id is a 400 INVALID_REQUEST and never echoed.
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await workComposition().laneRunReads.readRun({
      runId: getRouterParam(event, "id"),
      nowIso: new Date().toISOString(),
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
