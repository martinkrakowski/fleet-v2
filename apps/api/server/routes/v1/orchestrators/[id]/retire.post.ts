// The token id and scopes come only from the presented token, never the body;
// this route reads no body at all.
import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  notFoundEnvelope,
  refusedEnvelope,
  successEnvelope,
} from "../../../../wiring/operator/errors.js";
import { holdsScope, presentedToken } from "../../../../wiring/presented-token.js";

const SCOPE_REASON = "the presenting token lacks the orchestrate scope";
const NOT_OWNER_REASON = "this session was registered by another token";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const token = presentedToken(event);
    if (!holdsScope(token, "orchestrate")) {
      const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    const result = await getOperatorComposition().retireOrchestratorSession.retireOrchestratorSession(
      { orchestratorId: getRouterParam(event, "id") ?? "" },
      token.tokenId,
    );
    switch (result.outcome) {
      case "not-found": {
        const failure = notFoundEnvelope(operationId);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      case "not-owner": {
        const failure = forbiddenEnvelope(operationId, NOT_OWNER_REASON);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      case "refused": {
        const failure = refusedEnvelope(operationId, result.reason);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      default:
        return successEnvelope(operationId, result);
    }
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
