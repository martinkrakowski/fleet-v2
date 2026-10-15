// GET /v1/heads/:sha/evidence — InspectAcceptanceEvidence
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { readQueryRecord } from "../../../../wiring/http-input";

export default defineEventHandler((event) =>
  evidenceResponse(event, getEvidenceUseCases().inspectAcceptanceEvidence, "InspectAcceptanceEvidence", {
    ...readQueryRecord(event),
    candidateHeadSha: getRouterParam(event, "sha") ?? "",
  }),
);
