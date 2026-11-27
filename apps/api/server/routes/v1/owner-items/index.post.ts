import { defineEventHandler, setResponseStatus, type H3Event } from "h3";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../wiring/operator/errors.js";
import { readObjectBody } from "../../../wiring/http-input";
import { presentedToken } from "../../../wiring/presented-token";

/**
 * The owner-item creation route. It records only a personal `other` item:
 * every other kind has its own entry point (merge observation, decision
 * answering, plan-decision handling), and none enters here. The acting
 * identity comes only from the presented token, never the body.
 */

const ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["projectId", "kind", "subject", "refs", "blocks"]);

/** Set the failure's HTTP status and answer with its body. */
function respond<T extends { readonly statusCode: number; readonly body: unknown }>(event: H3Event, failure: T): T["body"] {
  setResponseStatus(event, failure.statusCode);
  return failure.body;
}

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event, { keepNowIso: true });
    const extraKeys = Object.keys(body).filter((key) => !ALLOWED_BODY_KEYS.has(key));
    if (extraKeys.length > 0) {
      return respond(event, refusedEnvelope(operationId, "owner item creation accepts only projectId, kind, subject, refs and blocks"));
    }
    if (body.kind !== "other") {
      return respond(event, refusedEnvelope(operationId, "owner item creation from this route accepts only kind other"));
    }
    const refs = body.refs === undefined ? [] : body.refs;
    const blocks = body.blocks === undefined ? [] : body.blocks;
    if (!Array.isArray(refs) || !Array.isArray(blocks)) {
      return respond(event, refusedEnvelope(operationId, "owner item creation refs and blocks must be arrays when present"));
    }
    const token = presentedToken(event);
    const actor = token.actor ?? token.tokenId;
    const result = await getOperatorComposition().recordOwnerItem.recordOwnerItem(
      { projectId: body.projectId, kind: "other", subject: body.subject, refs, blocks },
      actor,
    );
    if (result.outcome === "refused" || result.outcome === "key-held") {
      return respond(event, refusedEnvelope(operationId, result.reason));
    }
    return successEnvelope(operationId, result);
  } catch (error) {
    return respond(event, errorEnvelope(operationId, error));
  }
});
