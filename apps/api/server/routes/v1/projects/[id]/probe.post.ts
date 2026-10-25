import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../../wiring/work/errors";

// POST /v1/projects/:id/probe runs the read-only project probe: one local
// `git ls-remote`, then up to seven commands over ssh per clone host the
// installation names, each with its own timeout. The route is throttled by a
// per-project single-flight and a small global cap: a concurrent probe of the
// same project is refused 409 BUSY and an over-capacity probe 429 BUSY,
// immediately, never queued. Admission stays behind the bearer token, which
// already authorises heavier remote work (dispatch).
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  // Trimmed exactly as the use case trims it, so `%20a` and `a` share one
  // single-flight slot; h3 has already decoded the path.
  const projectId = (getRouterParam(event, "id") ?? "").trim();
  try {
    const composition = workComposition();
    const probed = await composition.probeLimiter.run(projectId, () =>
      composition.probeProject.execute({ projectId }),
    );
    if (!probed.ok) {
      if (probed.reason === "busy-project") {
        setResponseStatus(event, 409);
        return envelope(operationId, "BUSY", {
          reason: `a probe of ${projectId} is already running`,
        });
      }
      setResponseStatus(event, 429);
      return envelope(operationId, "BUSY", {
        reason: "probe capacity is busy; retry shortly",
      });
    }
    const result = probed.value;
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
