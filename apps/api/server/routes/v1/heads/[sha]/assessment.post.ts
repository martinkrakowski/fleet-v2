// POST /v1/heads/:sha/assessment — AssessHeadAcceptance
import { createError } from "h3";

import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const body = await readObjectBody(event);
  // Owner decision references are read from the attempt record. A body that
  // names them is asking to be judged against its own list of doors.
  if ("ownerDecisionReferences" in body) {
    throw createError({
      statusCode: 400,
      statusMessage:
        "'ownerDecisionReferences' is not accepted; owner decisions come from the attempt record",
    });
  }
  return evidenceResponse(event, getEvidenceUseCases().assessHeadAcceptance, "AssessHeadAcceptance", {
    ...body,
    candidateHeadSha: getRouterParam(event, "sha") ?? "",
  });
});