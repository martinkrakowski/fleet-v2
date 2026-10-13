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
  try {
    const briefPackage =
      await workComposition().prepareBriefPackage.execute(undefined);
    const reservation =
      await workComposition().reserveExecutionCapacity.execute(briefPackage);
    const attempt =
      await workComposition().dispatchAttempt.execute(reservation);
    return envelope(operationId, "OK", attempt);
  } catch (error) {
    if (isNotImplementedError(error)) {
      setResponseStatus(event, NOT_IMPLEMENTED_STATUS);
      return envelope(operationId, NOT_IMPLEMENTED_CODE);
    }
    throw error;
  }
});
