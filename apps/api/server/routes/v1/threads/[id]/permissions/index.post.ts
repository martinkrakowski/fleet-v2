// The tool-permission hook route (hook scope): it issues the request id,
// stores the tool input verbatim, long-polls for the verdict, answers the
// Claude Code PermissionRequest hook envelope, denies explicitly at the
// deadline, and never returns updatedInput, the tool name, the tool input,
// the thread label or a path.
import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../../../wiring/operator/errors.js";
import { readObjectBody, routeParam } from "../../../../../wiring/http-input";
import { holdsScope, presentedToken } from "../../../../../wiring/presented-token.js";

const SCOPE_REASON = "the presenting token lacks the hook scope";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const token = presentedToken(event);
    if (!holdsScope(token, "hook")) {
      const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }

    const threadId = routeParam(event, "id");
    const body = await readObjectBody(event);
    const result = await getOperatorComposition().requestToolPermission.requestToolPermission(
      body,
      threadId,
    );

    if (result.outcome === "refused") {
      // A refusal is a client error (400); only an unexpected internal error
      // is a 500. Neither carries the tool input or the thread label.
      const failure = refusedEnvelope(operationId, result.reason);
      setResponseStatus(event, result.reason === "internal-error" ? 500 : 400);
      return failure.body;
    }

    // The hook's own envelope: Claude Code reads this body, so it is NOT the
    // house three-field success envelope. The decision payload is built
    // through the house success builder so the route participates in the
    // route-contract snapshot; the wire body below stays byte-exact.
    const decision =
      result.outcome === "allowed"
        ? successEnvelope(operationId, { behavior: "allow" }).result
        : successEnvelope(operationId, { behavior: "deny", message: result.message }).result;

    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision,
      },
    };
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
