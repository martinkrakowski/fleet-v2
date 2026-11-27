import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../../wiring/operator/errors.js";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";
import { presentedToken } from "../../../../wiring/presented-token.js";

export default defineEventHandler(async (event) => {
  const questionId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event);
    // No matter how the caller authenticated, body fields never choose the
    // attribution: answeredVia and sessionId are deleted and derived
    // exclusively from the presented token.
    delete body.answeredVia;
    delete body.sessionId;
    const token = presentedToken(event);
    const tokenSessionId = token.sessionId;
    const result = await getOperatorComposition().answerOwnerQuestion.execute({
      ...body,
      questionId,
      ...(typeof tokenSessionId === "string" && tokenSessionId.trim().length > 0
        ? { answeredVia: "web" as const, sessionId: tokenSessionId }
        : { answeredVia: "cli" as const }),
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
