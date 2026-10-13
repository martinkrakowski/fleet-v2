// POST /v1/heads/:sha/assessment — AssessHeadAcceptance (step A: 501)
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";

export default defineEventHandler(async (event) =>
  evidenceResponse(event, getEvidenceUseCases().assessHeadAcceptance, "AssessHeadAcceptance"),
);
