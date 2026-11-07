// The tool-permission list route (verdict scope): returns only this thread's
// pending, unexpired requests. Any state other than pending is refused with
// 400 invalid-state. Never echoes tool arguments, summary or client text.
import { defineEventHandler, getQuery, setResponseStatus } from "h3";
import { getOperatorComposition } from "../../../../../wiring/operator/composition.js";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  refusedEnvelope,
  successEnvelope,
} from "../../../../../wiring/operator/errors.js";
import { routeParam } from "../../../../../wiring/http-input";
import { holdsScope, presentedToken } from "../../../../../wiring/presented-token.js";

const SCOPE_REASON = "the presenting token lacks the verdict scope";
const MAX_LIST_ENTRIES = 128;

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const token = presentedToken(event);
    if (!holdsScope(token, "verdict")) {
      const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }

    let threadId: string;
    try {
      threadId = routeParam(event, "id");
    } catch {
      const failure = refusedEnvelope(operationId, "missing-id");
      setResponseStatus(event, 400);
      return failure.body;
    }

    let query: Record<string, unknown>;
    try {
      query = getQuery(event) as Record<string, unknown>;
    } catch {
      const failure = refusedEnvelope(operationId, "invalid-state");
      setResponseStatus(event, 400);
      return failure.body;
    }

    let stateVal: unknown;
    try {
      stateVal = query?.state;
    } catch {
      const failure = refusedEnvelope(operationId, "invalid-state");
      setResponseStatus(event, 400);
      return failure.body;
    }

    if (typeof stateVal !== "string" || stateVal !== "pending") {
      const failure = refusedEnvelope(operationId, "invalid-state");
      setResponseStatus(event, 400);
      return failure.body;
    }

    let records: readonly {
      readonly threadId: string;
      readonly state: string;
      readonly deadlineAtIso: string;
      readonly requestId: string;
      readonly toolName: string;
    }[];
    try {
      records = getOperatorComposition().permissionRequestRepository.listPending();
    } catch {
      setResponseStatus(event, 503);
      return { operationId, code: "STORE_UNAVAILABLE", result: null };
    }

    const now = Date.now();
    const matching = records.filter(
      (record) =>
        record.threadId === threadId &&
        record.state === "pending" &&
        Date.parse(record.deadlineAtIso) > now,
    );

    const requests = matching.slice(0, MAX_LIST_ENTRIES).map((record) => ({
      requestId: record.requestId,
      toolCode: record.toolName,
      deadlineAt: record.deadlineAtIso,
    }));

    return successEnvelope(operationId, { requests });
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
