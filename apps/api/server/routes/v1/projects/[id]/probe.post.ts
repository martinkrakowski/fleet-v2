import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";

// POST /v1/projects/:id/probe runs the read-only project probe: one local
// `git ls-remote`, then up to seven commands over ssh per clone host the
// installation names, each with its own timeout. The route is not throttled
// and admits callers only through the bearer token, which already authorises
// heavier remote work (dispatch). A per-project single-flight and a small
// global cap are a planned follow-up.
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const result = await workComposition().probeProject.execute({
      projectId: getRouterParam(event, "id") ?? "",
    });
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND");
    }
    if (result.outcome === "rejected") {
      setResponseStatus(event, 422);
      return envelope(operationId, "REFUSED", result);
    }
    return envelope(operationId, "OK", result);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    throw error;
  }
});
