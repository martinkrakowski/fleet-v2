import { defineEventHandler, setResponseStatus, type H3Event } from "h3";
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

const WITHDRAW_REASONS: ReadonlySet<string> = new Set(["no-longer-needed", "duplicate", "superseded"]);

/** Set the failure's HTTP status and answer with its body. */
function respond<T extends { readonly statusCode: number; readonly body: unknown }>(event: H3Event, failure: T): T["body"] {
  setResponseStatus(event, failure.statusCode);
  return failure.body;
}

export default defineEventHandler(async (event) => {
  const itemId = routeParam(event, "id");
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event, { keepNowIso: true });
    const action = body.action;
    let request: { action: "done"; itemId: string; via: "web" } | { action: "withdraw"; itemId: string; reason: string };
    if (action === "done") {
      const extraFields = Object.keys(body).filter((key) => key !== "action");
      if (extraFields.length > 0) {
        return respond(event, refusedEnvelope(operationId, "owner item resolution accepts only the action field for done"));
      }
      request = { action: "done", itemId, via: "web" };
    } else if (action === "withdraw") {
      const reason = body.reason;
      if (typeof reason !== "string" || !WITHDRAW_REASONS.has(reason)) {
        return respond(event, refusedEnvelope(
          operationId,
          "owner item resolution withdraw reason is not one of no-longer-needed, duplicate, superseded",
        ));
      }
      const extraFields = Object.keys(body).filter((key) => key !== "action" && key !== "reason");
      if (extraFields.length > 0) {
        return respond(event, refusedEnvelope(operationId, "owner item resolution accepts only action and reason for withdraw"));
      }
      request = { action: "withdraw", itemId, reason };
    } else {
      return respond(event, refusedEnvelope(operationId, "owner item resolution action is not one of done, withdraw"));
    }
    // The acting identity comes only from the presented token, never the body.
    const token = presentedToken(event);
    const actor = token.actor ?? token.tokenId;
    const result = await getOperatorComposition().resolveOwnerItem.resolveOwnerItem(request, actor);
    if (result.outcome === "not-found") {
      return respond(event, notFoundEnvelope(operationId));
    }
    if (result.outcome === "refused") {
      return respond(event, refusedEnvelope(operationId, result.reason));
    }
    return successEnvelope(operationId, result);
  } catch (error) {
    return respond(event, errorEnvelope(operationId, error));
  }
});
