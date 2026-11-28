import { createError, defineEventHandler, setResponseStatus, type H3Event } from "h3";
import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../wiring/operator/errors.js";
import { MAX_JSON_BODY_BYTES, readBoundedRawBody, readObjectBody } from "../../../wiring/http-input";
import { presentedToken } from "../../../wiring/presented-token";

/**
 * The owner-item creation route. It records a personal `other` to-do only:
 * merge, secret, decision and backup items have no entry point here. The
 * presented token supplies the acting identity, the composition root's clock
 * supplies the moment and the item id; the body carries only projectId,
 * subject and the optional refs and blocks.
 */

const RECORD_BODY_KEYS: ReadonlySet<string> = new Set([
  "projectId",
  "kind",
  "subject",
  "refs",
  "blocks",
]);

/**
 * A body that is present must be a JSON object. `readObjectBody` answers a JSON `null` or `""` with an empty
 * object, so this route reads the already-cached raw bytes and answers any present body that does not open
 * as an object with the client error (400), never with the use case's own refusal.
 */
async function refuseNonObjectBody(event: H3Event): Promise<void> {
  const raw = await readBoundedRawBody(event, MAX_JSON_BODY_BYTES);
  if (raw !== undefined && raw.byteLength > 0 && !raw.toString("utf8").trimStart().startsWith("{")) {
    throw createError({ statusCode: 400, statusMessage: "Invalid JSON object body" });
  }
}

/** Set the failure's HTTP status and answer with its body. */
function respond<T extends { readonly statusCode: number; readonly body: unknown }>(event: H3Event, failure: T): T["body"] {
  setResponseStatus(event, failure.statusCode);
  return failure.body;
}

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event, { keepNowIso: true });
    await refuseNonObjectBody(event);
    const extraKeys = Object.keys(body).filter((key) => !RECORD_BODY_KEYS.has(key));
    if (extraKeys.length > 0) {
      return respond(event, refusedEnvelope(
        operationId,
        "owner item creation accepts only projectId, kind, subject, refs and blocks",
      ));
    }
    if (body.kind !== "other") {
      return respond(event, refusedEnvelope(operationId, "owner item creation from this route accepts only kind other"));
    }
    if (body.refs !== undefined && !Array.isArray(body.refs)) {
      return respond(event, refusedEnvelope(operationId, "owner item creation refs must be an array"));
    }
    if (body.blocks !== undefined && !Array.isArray(body.blocks)) {
      return respond(event, refusedEnvelope(operationId, "owner item creation blocks must be an array"));
    }
    // The acting identity comes only from the presented token, never the body.
    const token = presentedToken(event);
    const actor = token.actor ?? token.tokenId;
    const result = await getOperatorComposition().recordOwnerItem.recordOwnerItem(
      {
        projectId: body.projectId,
        kind: "other",
        subject: body.subject,
        refs: body.refs ?? [],
        blocks: body.blocks ?? [],
      },
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
