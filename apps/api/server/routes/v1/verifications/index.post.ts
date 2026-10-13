// POST /v1/verifications — RequestVerification (step A: unimplemented -> 501)
import { getEvidenceUseCases } from "../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../wiring/evidence/errors.js";

export default defineEventHandler(async (event) =>
  evidenceResponse(event, getEvidenceUseCases().requestVerification, "RequestVerification"),
);
