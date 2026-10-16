import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";
import { readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event);
    const result = await workComposition().reconcileAttempt.execute({
      ...body,
      attemptId: getRouterParam(event, "id") ?? "",
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
