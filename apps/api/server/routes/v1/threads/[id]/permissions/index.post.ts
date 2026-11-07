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
    let body: unknown;
    try {
      body = await readObjectBody(event);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof error.statusCode === "number"
      ) {
        throw error;
      }
      const failure = refusedEnvelope(operationId, "body-not-an-object");
      setResponseStatus(event, 400);
      return failure.body;
    }

    const controller = new AbortController();
    const req = event.node?.req;
    const res = event.node?.res;
    let responseWritten = false;
    const onClose = () => {
      if (!responseWritten) {
        controller.abort();
      }
    };
    if (req?.aborted) {
      controller.abort();
    } else {
      if (typeof req?.on === "function") {
        req.on("close", onClose);
      }
      if (typeof res?.on === "function") {
        res.on("close", onClose);
      }
    }

    let result;
    try {
      result = await getOperatorComposition().requestToolPermission.requestToolPermission(
        body,
        threadId,
        controller.signal,
      );
    } finally {
      responseWritten = true;
      if (req) {
        if (typeof req.off === "function") {
          req.off("close", onClose);
        } else if (typeof req.removeListener === "function") {
          req.removeListener("close", onClose);
        }
      }
      if (res) {
        if (typeof res.off === "function") {
          res.off("close", onClose);
        } else if (typeof res.removeListener === "function") {
          res.removeListener("close", onClose);
        }
      }
    }

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
