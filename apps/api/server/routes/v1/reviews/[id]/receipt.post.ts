// POST /v1/reviews/:id/receipt — RecordReviewReceipt
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { isPlainObject, readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  // `body.assessmentId` is forwarded untouched; the route parameter is the
  // receipt identity and is merged into `receipt.id`.
  const body = await readObjectBody(event);
  return evidenceResponse(
    event,
    getEvidenceUseCases().recordReviewReceipt,
    "RecordReviewReceipt",
    {
      ...body,
      receipt: isPlainObject(body.receipt)
        ? { ...body.receipt, id: getRouterParam(event, "id") ?? "" }
        : body.receipt,
    },
  );
});
