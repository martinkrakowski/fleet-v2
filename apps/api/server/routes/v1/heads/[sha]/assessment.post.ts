// POST /v1/heads/:sha/assessment — AssessHeadAcceptance
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) =>
  evidenceResponse(event, getEvidenceUseCases().assessHeadAcceptance, "AssessHeadAcceptance", {
    ...(await readObjectBody(event)),
    candidateHeadSha: getRouterParam(event, "sha") ?? "",
  }),
);
