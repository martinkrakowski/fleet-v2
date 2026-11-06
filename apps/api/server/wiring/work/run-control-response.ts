import { getHeader, setResponseStatus, type H3Event } from "h3";
import { envelope, mapWorkError, newOperationId, type ApiEnvelope } from "./errors";

/** The caller's id when it supplied a usable one; else a fresh operation id. */
export function resolveOperationId(body: Record<string, unknown>, event: H3Event): string {
  const header: unknown = getHeader(event, "idempotency-key");
  const fromHeader = typeof header === "string" ? header.trim() : "";
  if (fromHeader.length > 0 && fromHeader.length <= 128) {
    return fromHeader;
  }
  const fromBody = body.operationId;
  if (typeof fromBody === "string" && fromBody.trim().length > 0 && fromBody.length <= 128) {
    return fromBody;
  }
  return newOperationId();
}

/** The 429/409 BUSY answer for a run-control call the limiter did not run. */
export function busyResponse(event: H3Event, operationId: string, reason: string): ApiEnvelope {
  setResponseStatus(event, reason === "busy-global" ? 429 : 409);
  return envelope(operationId, "BUSY", { reason });
}

/** The 400/409 answer for a refused run-control request. */
export function refusedResponse(
  event: H3Event,
  operationId: string,
  result: { readonly reason: string },
): ApiEnvelope {
  if (result.reason === "invalid-request") {
    setResponseStatus(event, 400);
    return envelope(operationId, "INVALID_REQUEST", result);
  }
  setResponseStatus(event, 409);
  return envelope(operationId, "CONFLICT", result);
}

/**
 * The answer for a thrown error: the mapped status, else one fixed 503 reason.
 * Store errors can name paths or the state directory; the caller never gets
 * the message.
 */
export function failureResponse(
  event: H3Event,
  operationId: string,
  error: unknown,
  storeReason: string,
): ApiEnvelope {
  const mapping = mapWorkError(error);
  if (mapping) {
    setResponseStatus(event, mapping.status);
    return envelope(operationId, mapping.code);
  }
  setResponseStatus(event, 503);
  return envelope(operationId, "STORE_UNAVAILABLE", {
    outcome: "unknown",
    reason: storeReason,
  });
}
