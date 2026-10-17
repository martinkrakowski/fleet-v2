// POST /v1/briefs/prepare — PrepareBriefPackage
import { parseSeatTool } from "@fleet/work-execution";
import { workComposition } from "../../../wiring/work/composition";
import {
  envelope,
  mapWorkError,
  newOperationId,
} from "../../../wiring/work/errors";
import { readObjectBody } from "../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    const body = await readObjectBody(event);
    // The seat tool is frozen into the brief manifest, so it is required in
    // the request and never defaulted (H8): a missing or undeclared tool is
    // a bad request, not an opencode seat.
    const seatTool = parseSeatTool(body.seatTool);
    if (seatTool === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "seatTool is required and must be a declared runner kind (opencode or agy)",
      });
    }
    const nestedAssignment: Record<string, unknown> =
      typeof body.modelAssignment === "object" && body.modelAssignment !== null
        ? (body.modelAssignment as Record<string, unknown>)
        : {};
    if (
      nestedAssignment.seatTool !== undefined &&
      nestedAssignment.seatTool !== seatTool
    ) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "seatTool conflicts with the seat tool inside modelAssignment",
      });
    }
    const result = await workComposition().prepareBriefPackage.execute({
      ...body,
      modelAssignment: { ...nestedAssignment, seatTool },
    });
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
