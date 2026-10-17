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
    // This route is the CLI answer surface. The moment, any
    // 'signed-decision' or 'web' answeredVia, and any sessionId in a body are
    // never accepted: the answeredVia is 'cli' here, and a sessionId is
    // reserved for the web answer route.
    delete body.answeredVia;
    delete body.sessionId;
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
