import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readQueryRecord } from "../../../wiring/http-input";

// VZ6: GET /v1/runs/passes — the recorded conductor pass traces, newest
// first, bounded by ?limit=. Read-only: a rejected limit is a client error,
// an unreadable trace store is reported unreadable, never a failure.
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await workComposition().listConductorPasses.execute(
      readQueryRecord(event),
    );
    if (result.outcome === "listed") {
      return envelope(operationId, "OK", result);
    }
    setResponseStatus(event, 400);
    return envelope(operationId, "INVALID_REQUEST", result);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
