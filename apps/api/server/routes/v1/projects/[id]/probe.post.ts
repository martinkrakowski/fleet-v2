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
    const result = await workComposition().probeProject.execute({
      projectId: getRouterParam(event, "id") ?? "",
    });
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND");
    }
    if (result.outcome === "rejected") {
      setResponseStatus(event, 422);
      return envelope(operationId, "REFUSED", result);
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
