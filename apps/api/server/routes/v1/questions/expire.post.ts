import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import { errorEnvelope, newOperationId, successEnvelope } from "../../../wiring/operator/errors.js";
import { readObjectBody } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    // The body carries nothing the use case uses; expiry is judged by the
    // injected clock, never by a request.
    await readObjectBody(event);
    const result = await getOperatorComposition().expireOwnerQuestions.execute();
    return successEnvelope(operationId, result);
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
