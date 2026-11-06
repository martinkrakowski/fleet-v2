import { defineEventHandler } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import { envelope } from "../../../wiring/work/errors";
import {
  busyResponse,
  failureResponse,
  refusedResponse,
  resolveOperationId,
} from "../../../wiring/work/run-control-response";
import { readObjectBody } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const body = await readObjectBody(event);
  const operationId = resolveOperationId(body, event);
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
      return busyResponse(event, operationId, ran.reason);
    }
    const result = ran.value;
    if (result.outcome === "refused") {
      return refusedResponse(event, operationId, result);
    }
    return envelope(operationId, "OK", {
      outcome: result.outcome,
      halted: result.record.halted,
      changedAtIso: result.record.changedAtIso,
    });
  } catch (error) {
    return failureResponse(event, operationId, error, "halt-store-unavailable");
  }
});
