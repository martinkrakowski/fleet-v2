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
    // Any 'signed-decision' or 'web' answeredVia, and any sessionId in a body,
    // are never accepted: attribution is derived exclusively from the presented
    // token. A session-minted token records the web surface and its session;
    // everything else, the shared bearer included, is the CLI surface.
    delete body.answeredVia;
    delete body.sessionId;
    const token = presentedToken(event);
    const tokenSessionId = token.sessionId;
    const attribution =
      typeof tokenSessionId === "string" && tokenSessionId.trim().length > 0
        ? { answeredVia: "web" as const, sessionId: tokenSessionId }
        : { answeredVia: "cli" as const };
    const result = await getOperatorComposition().answerOwnerQuestion.execute({
      ...body,
      questionId,
      ...attribution,
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
