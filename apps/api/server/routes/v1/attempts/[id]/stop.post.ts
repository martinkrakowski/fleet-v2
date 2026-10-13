import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  const id = getRouterParam(event, "id");
  try {
    const result = await workComposition().stopAttempt.execute({ id });
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
