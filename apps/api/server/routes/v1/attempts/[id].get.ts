import { defineEventHandler, setResponseStatus } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readQueryRecord, routeParam } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const attemptId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const result = await workComposition().inspectAttempt.execute({
      ...readQueryRecord(event),
      attemptId,
    });
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
