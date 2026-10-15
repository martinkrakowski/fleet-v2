// POST /v1/reviews — RequestIndependentReview
import { getEvidenceUseCases } from "../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../wiring/evidence/errors.js";
import { readObjectBody } from "../../../wiring/http-input";

export default defineEventHandler(async (event) =>
  evidenceResponse(
    event,
    getEvidenceUseCases().requestIndependentReview,
    "RequestIndependentReview",
    await readObjectBody(event),
  ),
);
