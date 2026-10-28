import { defineEventHandler, setResponseStatus } from "h3";
import { routeParam } from "../../../wiring/http-input";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  notFoundEnvelope,
  successEnvelope,
} from "../../../wiring/operator/errors.js";

export default defineEventHandler(async (event) => {
  const questionId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const result = await getOperatorComposition().readOwnerQuestion.execute({
      questionId,
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
