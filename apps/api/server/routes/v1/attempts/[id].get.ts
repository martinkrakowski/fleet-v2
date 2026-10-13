import { workComposition } from "../../../wiring/work/composition";
import {
  NOT_IMPLEMENTED_CODE,
  NOT_IMPLEMENTED_STATUS,
  envelope,
  isNotImplementedError,
  newOperationId,
} from "../../../wiring/work/errors";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  const id = getRouterParam(event, "id");
  try {
    const result = await workComposition().reconcileAttempt.execute({ id });
    return envelope(operationId, "OK", result);
  } catch (error) {
    if (isNotImplementedError(error)) {
      setResponseStatus(event, NOT_IMPLEMENTED_STATUS);
      return envelope(operationId, NOT_IMPLEMENTED_CODE);
    }
    throw error;
  }
});
