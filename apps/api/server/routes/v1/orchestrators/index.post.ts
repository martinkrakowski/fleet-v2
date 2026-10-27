// The token id and scopes come only from the presented token, never the body.
import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../wiring/operator/errors.js";
import { readObjectBody } from "../../../wiring/http-input";
import { holdsScope, presentedToken } from "../../../wiring/presented-token.js";

const SCOPE_REASON = "the presenting token lacks the orchestrate scope";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const token = presentedToken(event);
    if (!holdsScope(token, "orchestrate")) {
      const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    const result = await getOperatorComposition().registerOrchestratorSession.registerOrchestratorSession(
      await readObjectBody(event),
      token.scopes,
      token.tokenId,
    );
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
