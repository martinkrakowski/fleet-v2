import { defineEventHandler, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  notFoundEnvelope,
  refusedEnvelope,
  successEnvelope,
} from "../../../../wiring/operator/errors.js";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";
import { presentedToken } from "../../../../wiring/presented-token";

/**
 * The owner-item resolution route. The path supplies the item id, the route
 * fixes the via to 'web', and the presented token supplies the acting
 * identity; the body carries only the action and, for a withdraw, its typed
 * reason. Merge observation, decision answering and plan-decision handling
 * have no entry point here.
 */

const WITHDRAW_REASONS: readonly string[] = ["no-longer-needed", "duplicate", "superseded"];

export default defineEventHandler(async (event) => {
  const itemId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event);
    const action = body.action;
    let request: { action: "done"; itemId: string; via: "web" } | { action: "withdraw"; itemId: string; reason: string };
    if (action === "done") {
      const extraFields = Object.keys(body).filter((key) => key !== "action");
      if (extraFields.length > 0) {
        const failure = refusedEnvelope(operationId, "owner item resolution accepts only the action field for done");
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      request = { action: "done", itemId, via: "web" };
    } else if (action === "withdraw") {
      const reason = body.reason;
      if (typeof reason !== "string" || !WITHDRAW_REASONS.includes(reason)) {
        const failure = refusedEnvelope(
          operationId,
          "owner item resolution withdraw reason is not one of no-longer-needed, duplicate, superseded",
        );
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      const extraFields = Object.keys(body).filter((key) => key !== "action" && key !== "reason");
      if (extraFields.length > 0) {
        const failure = refusedEnvelope(operationId, "owner item resolution accepts only action and reason for withdraw");
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      request = { action: "withdraw", itemId, reason };
    } else {
      const failure = refusedEnvelope(operationId, "owner item resolution action is not one of done, withdraw");
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    // The acting identity comes only from the presented token, never the body.
    const token = presentedToken(event);
    const actor = token.actor ?? token.tokenId;
    const result = await getOperatorComposition().resolveOwnerItem.resolveOwnerItem(request, actor);
    if (result.outcome === "not-found") {
      const failure = notFoundEnvelope(operationId);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
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
