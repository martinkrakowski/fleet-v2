import { createError, defineEventHandler, setResponseStatus } from "h3";
import { isFleetApiRuntimeConfigured } from "../../../wiring/runtime";
import {
  envelope,
  newOperationId,
  NOT_IMPLEMENTED_CODE,
  NOT_IMPLEMENTED_STATUS,
} from "../../../wiring/work/errors";

export default defineEventHandler(async (event) => {
  if (!isFleetApiRuntimeConfigured()) {
    setResponseStatus(event, NOT_IMPLEMENTED_STATUS);
    return envelope(newOperationId(), NOT_IMPLEMENTED_CODE);
  }
  throw createError({
    statusCode: 404,
    statusMessage: "Cannot find any route matching POST /v1/attempts",
  });
});
