import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../../wiring/operator/errors.js";
import { readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event);
    // This route is the CLI answer surface. The moment, and any
    // 'signed-decision' or 'web' answeredVia in a body, are never accepted:
    // the answeredVia is 'cli' here; only the web route may set 'web' later.
    delete body.answeredVia;
    const result = await getOperatorComposition().answerOwnerQuestion.execute({
      ...body,
      questionId: getRouterParam(event, "id") ?? "",
      answeredVia: "cli",
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
