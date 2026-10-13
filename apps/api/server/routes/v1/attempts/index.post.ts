import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
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
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
