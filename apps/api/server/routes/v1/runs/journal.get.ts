import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readQueryRecord } from "../../../wiring/http-input";

// A-R: GET /v1/runs/journal?key=<key> — the intent and results of one keyed
// journal key. A missing or malformed key is a 400 INVALID_REQUEST and never
// echoed.
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await workComposition().laneRunReads.readJournalByKey({
      query: readQueryRecord(event),
    });
    if (result.outcome === "listed" || result.outcome === "unknown") {
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
    setResponseStatus(event, 500);
    return envelope(operationId, "INTERNAL_ERROR");
  }
});
