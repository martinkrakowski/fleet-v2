import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../../wiring/operator/errors.js";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const questionId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const result = await getOperatorComposition().acknowledgeOwnerAnswer.execute({
      ...(await readObjectBody(event)),
      questionId,
    });
    if (result.outcome === "refused") {
      const failure = refusedEnvelope(operationId, result.reason);
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
