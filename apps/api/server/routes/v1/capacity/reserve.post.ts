// POST /v1/capacity/reserve — ReserveExecutionCapacity
import { parseSeatTool } from "@fleet/work-execution";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readObjectBody } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event);
    // The seat tool is required and never defaulted (H8): a missing or
    // undeclared tool is a bad request, not an opencode seat.
    if (parseSeatTool(body.seatTool) === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "seatTool is required and must be a declared runner kind (opencode or agy)",
      });
    }
    const result =
      await workComposition().reserveExecutionCapacity.execute(body);
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
