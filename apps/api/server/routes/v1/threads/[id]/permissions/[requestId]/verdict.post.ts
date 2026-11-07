// The tool-permission verdict route (verdict scope): the first verdict wins,
// the same decision again changes nothing, and a different decision is a
// conflict (409) carrying the first verdict. The actor is the presenting
// token's id, never the body.
import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  notFoundEnvelope,
  refusedEnvelope,
  successEnvelope,
} from "../../../../../../wiring/operator/errors.js";
import { readObjectBody, routeParam } from "../../../../../../wiring/http-input";
import { holdsScope, presentedToken } from "../../../../../../wiring/presented-token.js";

const SCOPE_REASON = "the presenting token lacks the verdict scope";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const token = presentedToken(event);
    if (!holdsScope(token, "verdict")) {
      const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }

    const threadId = routeParam(event, "id");
    const requestId = routeParam(event, "requestId");
    const body = await readObjectBody(event);
    const result = await getOperatorComposition().giveToolPermissionVerdict.giveToolPermissionVerdict(
      body,
      requestId,
      token.tokenId,
      threadId,
    );

    if (result.outcome === "recorded" || result.outcome === "unchanged") {
      // The first verdict's data.
      setResponseStatus(event, 200);
      return successEnvelope(operationId, {
        requestId,
        decision: result.verdict.decision,
        decidedAtIso: result.verdict.decidedAtIso,
        actorId: result.verdict.actorId,
      });
    }

    if (result.outcome === "conflict") {
      // 409 carrying the first verdict.
      setResponseStatus(event, 409);
      return successEnvelope(operationId, {
        requestId,
        decision: result.verdict.decision,
        decidedAtIso: result.verdict.decidedAtIso,
        actorId: result.verdict.actorId,
      });
    }

    if (result.outcome === "unknown") {
      const failure = notFoundEnvelope(operationId);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }

    if (result.outcome === "expired") {
      // A fixed reason code: never an id, never a path.
      setResponseStatus(event, 409);
      return { operationId, code: "EXPIRED", result: null };
    }

    // refused
    const failure = refusedEnvelope(operationId, result.reason);
    setResponseStatus(event, result.reason === "internal-error" ? 500 : 400);
    return failure.body;
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
