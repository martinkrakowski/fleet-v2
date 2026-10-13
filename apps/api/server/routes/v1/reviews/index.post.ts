// POST /v1/reviews — RequestIndependentReview (step A: 501)
import { getEvidenceUseCases } from "../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../wiring/evidence/errors.js";

export default defineEventHandler(async (event) =>
  evidenceResponse(event, getEvidenceUseCases().requestIndependentReview, "RequestIndependentReview"),
);
