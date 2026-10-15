import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import { errorEnvelope, newOperationId, successEnvelope } from "../../../wiring/operator/errors.js";
import { readObjectBody } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await getOperatorComposition().sendFleetRelay.execute(
      await readObjectBody(event),
    );
    return successEnvelope(operationId, result);
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
