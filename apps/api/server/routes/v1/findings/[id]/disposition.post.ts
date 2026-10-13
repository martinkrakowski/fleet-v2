// POST /v1/findings/:id/disposition — RecordFindingDisposition (step A: 501)
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";

export default defineEventHandler(async (event) =>
  evidenceResponse(event, getEvidenceUseCases().recordFindingDisposition, "RecordFindingDisposition"),
);
