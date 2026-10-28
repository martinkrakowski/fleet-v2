// One handler shape for the project-profile writes addressed by route id
// (PATCH /v1/projects/:id, POST /v1/projects/:id/retire): the route id always
// overrides any projectId in the body, a refusal is 422, anything thrown goes
// through the operator error envelope.
import { defineEventHandler, setResponseStatus } from "h3";

import { readObjectBody, routeParam } from "../http-input";
import { errorEnvelope, newOperationId, refusedEnvelope, successEnvelope } from "./errors.js";

type ProjectWriteResult = { readonly outcome: "rejected"; readonly reason: string } | { readonly outcome: string };

export function projectWriteHandler(
  run: (request: Record<string, unknown>) => Promise<ProjectWriteResult>,
) {
  return defineEventHandler(async (event) => {
    const projectId = routeParam(event, "id");
    const operationId = newOperationId();
    try {
      const result = await run({
        ...(await readObjectBody(event)),
        projectId,
      });
      if (result.outcome === "rejected" && "reason" in result) {
        const failure = refusedEnvelope(operationId, result.reason);
        setResponseStatus(event, failure.statusCode);
        return failure.body;
      }
      return successEnvelope(operationId, result);
    } catch (error) {
      const failure = errorEnvelope(operationId, error);
      setResponseStatus(event, failure.statusCode);
      return failure.body;
    }
  });
}
