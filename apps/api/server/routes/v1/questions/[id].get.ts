import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  notFoundEnvelope,
  successEnvelope,
} from "../../../wiring/operator/errors.js";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await getOperatorComposition().readOwnerQuestion.execute({
      questionId: getRouterParam(event, "id") ?? "",
    });
    if (result.outcome === "not-found") {
      const failure = notFoundEnvelope(operationId);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    return successEnvelope(operationId, result);
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
