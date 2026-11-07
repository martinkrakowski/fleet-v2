import { setResponseStatus } from "h3";
import type { H3Event } from "h3";
import { envelope, mapWorkError, newOperationId } from "./errors";

// A-R: the one response shape of every read-only `/v1/runs*` GET. A listed or
// unknown outcome is 200 OK (unknown is never an empty list or a 500), a
// not-found run is 404, a rejected request is 400, and a thrown error maps to
// its work-error status or a bare 500 that carries no message or path.
export async function respondRunRead(
  event: H3Event,
  read: () => Promise<{ readonly outcome: string }>,
) {
  const operationId = newOperationId();
  try {
    const result = await read();
    if (result.outcome === "listed" || result.outcome === "unknown") {
      return envelope(operationId, "OK", result);
    }
    if (result.outcome === "not-found") {
      setResponseStatus(event, 404);
      return envelope(operationId, "NOT_FOUND", result);
    }
    setResponseStatus(event, 400);
    return envelope(operationId, "INVALID_REQUEST", result);
  } catch (error) {
    const mapping = mapWorkError(error);
    if (mapping) {
      setResponseStatus(event, mapping.status);
      return envelope(operationId, mapping.code);
    }
    setResponseStatus(event, 500);
    return envelope(operationId, "INTERNAL_ERROR");
  }
}
