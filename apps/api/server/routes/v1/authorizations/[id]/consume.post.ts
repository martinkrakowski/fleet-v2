import { getOperatorComposition } from "../../../../wiring/operator/composition.js";
import { errorEnvelope, newOperationId, successEnvelope } from "../../../../wiring/operator/errors.js";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const grantId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const result = await getOperatorComposition().recordAuthorizationConsumption.execute({
      ...(await readObjectBody(event)),
      grantId,
    });
    return successEnvelope(operationId, result);
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
