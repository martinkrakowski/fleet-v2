// One handler shape for the routes that act on an orchestrator session the
// presenting token owns (heartbeat, retire): the token id and scopes come only
// from the presented token, never a body; these routes read no body at all.
import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "./operator/composition.js";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  notFoundEnvelope,
  refusedEnvelope,
  successEnvelope,
} from "./operator/errors.js";
import { holdsScope, presentedToken } from "./presented-token.js";
import { routeParam } from "./http-input.js";

const SCOPE_REASON = "the presenting token lacks the orchestrate scope";
const NOT_OWNER_REASON = "this session was registered by another token";

type OperatorComposition = ReturnType<typeof getOperatorComposition>;

/** The outcomes an owned-session use case can report; anything else is a success. */
export type OwnedSessionResult =
  | { readonly outcome: "not-found" }
  | { readonly outcome: "not-owner" }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: string };

export function ownedSessionRoute(
  act: (composition: OperatorComposition, orchestratorId: string, presentedTokenId: string) => Promise<OwnedSessionResult>,
) {
  return defineEventHandler(async (event) => {
    const orchestratorId = routeParam(event, "id");
    const operationId = newOperationId();
    try {
      const token = presentedToken(event);
      if (!holdsScope(token, "orchestrate")) {
        const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      const result = await act(getOperatorComposition(), orchestratorId, token.tokenId);
      if (result.outcome === "not-found") {
        const failure = notFoundEnvelope(operationId);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      if (result.outcome === "not-owner") {
        const failure = forbiddenEnvelope(operationId, NOT_OWNER_REASON);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      if (result.outcome === "refused" && "reason" in result) {
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
}
