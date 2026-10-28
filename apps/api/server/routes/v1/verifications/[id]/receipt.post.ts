// POST /v1/verifications/:id/receipt — RecordVerificationReceipt
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { isPlainObject, readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const receiptId = routeParam(event, "id");
  // `body.assessmentId` is forwarded untouched; the route parameter is the
  // receipt identity and is merged into `receipt.id`.
  const body = await readObjectBody(event);
  return evidenceResponse(
    event,
    getEvidenceUseCases().recordVerificationReceipt,
    "RecordVerificationReceipt",
    {
      ...body,
      receipt: isPlainObject(body.receipt)
        ? { ...body.receipt, id: receiptId }
        : body.receipt,
    },
  );
});
