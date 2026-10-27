// The presented token is not needed here: listing is read-only and every GET
// is authenticated by the security middleware; the query record is the only input.
import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import { errorEnvelope, newOperationId, successEnvelope } from "../../../wiring/operator/errors.js";
import { readQueryRecord } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await getOperatorComposition().listOrchestratorSessions.execute(
      readQueryRecord(event),
    );
    return successEnvelope(operationId, result);
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
