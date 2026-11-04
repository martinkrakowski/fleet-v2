import { defineEventHandler, setResponseStatus } from "h3";
import type { PrepareBriefPackageUseCaseRequest } from "@fleet/work-execution/use-cases";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readObjectBody } from "../../../wiring/http-input";

/**
 * POST /v1/briefs/preview: the dry-run preview of PrepareBriefPackage (BP1).
 * The route adds no field and removes none. A `rejected` outcome is a result,
 * not an HTTP error, so a 400 would make the MCP client drop the rejection
 * reason; the preview computes and stores nothing.
 */
export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = (await readObjectBody(
      event,
    )) as unknown as PrepareBriefPackageUseCaseRequest;
    const result =
      await workComposition().prepareBriefPackage.previewBriefPackage(body);
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
