// GET /v1/heads/:sha/evidence — InspectAcceptanceEvidence
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { readQueryRecord, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler((event) => {
  const candidateHeadSha = routeParam(event, "sha");
  return evidenceResponse(event, getEvidenceUseCases().inspectAcceptanceEvidence, "InspectAcceptanceEvidence", {
    ...readQueryRecord(event),
    candidateHeadSha,
  });
});
