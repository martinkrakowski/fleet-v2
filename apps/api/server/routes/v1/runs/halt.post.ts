import { defineEventHandler, getHeader, setResponseStatus } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readObjectBody } from "../../../wiring/http-input";

/** The caller's id when it supplied a usable one; else a fresh operation id. */
function resolveOperationId(body: Record<string, unknown>, header: unknown): string {
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

export default defineEventHandler(async (event) => {
  const body = await readObjectBody(event);
  const operationId = resolveOperationId(body, getHeader(event, "idempotency-key"));
  // operationId is transport metadata, never part of the halt request.
  const payload = { ...body };
  delete payload.operationId;
  try {
    const composition = workComposition();
    const ran = await composition.runControlLimiter.run("conductor-halt", () => {
      return composition.setConductorHalt.set({
        ...payload,
        nowIso: new Date().toISOString(),
      } as Parameters<typeof composition.setConductorHalt.set>[0]);
    });
    if (!ran.ok) {
      setResponseStatus(event, ran.reason === "busy-global" ? 429 : 409);
      return envelope(operationId, "BUSY", { reason: ran.reason });
    }
    const result = ran.value;
    if (result.outcome === "refused") {
      if (result.reason === "invalid-request") {
        setResponseStatus(event, 400);
        return envelope(operationId, "INVALID_REQUEST", result);
      }
      setResponseStatus(event, 409);
      return envelope(operationId, "CONFLICT", result);
    }
    return envelope(operationId, "OK", {
      outcome: result.outcome,
      halted: result.record.halted,
      changedAtIso: result.record.changedAtIso,
    });
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    // The store's own errors can name paths or the state directory; the caller
    // gets one fixed reason, never the message.
    setResponseStatus(event, 503);
    return envelope(operationId, "STORE_UNAVAILABLE", {
      outcome: "unknown",
      reason: "halt-store-unavailable",
    });
  }
});
