// POST /v1/snapshots/:section: a publisher pushes a token-only snapshot of one
// section (plan §5.3). Authentication and Content-Type are the security
// middleware's; the narrow snapshot-push scope is checked here. The projection
// store comes from runtime wiring, never a module global.
import { defineEventHandler, setResponseStatus } from "h3";
import {
  errorEnvelope,
  forbiddenEnvelope,
  newOperationId,
  successEnvelope,
} from "../../../wiring/operator/errors.js";
import { holdsScope, presentedToken } from "../../../wiring/presented-token.js";
import { readObjectBody, routeParam } from "../../../wiring/http-input.js";
import {
  getSnapshotProjectionStore,
  isFleetApiRuntimeConfigured,
} from "../../../wiring/runtime.js";
import type { SnapshotSection } from "@fleet/work-execution";

const SNAPSHOT_PUSH_SCOPE = "snapshot-push";
const SCOPE_REASON = "scope-required";
const NOT_IMPLEMENTED = { code: "NOT_IMPLEMENTED", result: null };

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    if (!isFleetApiRuntimeConfigured()) {
      setResponseStatus(event, 501);
      return { operationId, ...NOT_IMPLEMENTED };
    }
    const token = presentedToken(event);
    if (!holdsScope(token, SNAPSHOT_PUSH_SCOPE)) {
      const failure = forbiddenEnvelope(operationId, SCOPE_REASON);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    const section = routeParam(event, "section");
    const body = await readObjectBody(event);
    const store = getSnapshotProjectionStore();
    if (store === null) {
      setResponseStatus(event, 501);
      return { operationId, ...NOT_IMPLEMENTED };
    }
    const outcome = store.apply({ ...body, section });
    if (outcome.outcome === "invalid") {
      const failure = {
        statusCode: 422,
        body: { operationId, code: "INVALID", result: { reason: outcome.reason } },
      };
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    if (outcome.outcome === "refused") {
      const failure = {
        statusCode: 409,
        body: { operationId, code: "CONFLICT", result: { reason: outcome.reason } },
      };
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
    const entry = store.read()[section as SnapshotSection];
    return successEnvelope(operationId, { section, revision: entry?.revision ?? null });
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
