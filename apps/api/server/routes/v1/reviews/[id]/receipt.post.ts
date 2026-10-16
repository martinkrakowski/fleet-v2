// POST /v1/reviews/:id/receipt — RecordReviewReceipt
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse, isNotImplemented } from "../../../../wiring/evidence/errors.js";
import { isPlainObject, readObjectBody } from "../../../../wiring/http-input";
import { workComposition } from "../../../../wiring/work/composition.js";

type ReceiptRequestBody = Record<string, unknown>;

/**
 * Bind the receipt's implementer field to the attempt's recorded seat. The
 * implementer identity is a fact about the lane, so the caller never authors
 * it: a supplied `implementerModel` may only restate the recorded seat, and
 * an attempt with no recorded seat is refused instead of an assumed model.
 */
async function bindReceiptImplementerSeat(
  body: ReceiptRequestBody,
): Promise<ReceiptRequestBody | { outcome: "rejected"; reason: string }> {
  const resolveSeat = workComposition().resolveAttemptImplementerSeat;
  if (resolveSeat === undefined) {
    return {
      outcome: "rejected",
      reason: "No implementer seat resolver is bound; the implementer model cannot be established",
    };
  }
  const attemptId =
    isPlainObject(body.receipt) && typeof body.receipt.attemptId === "string"
      ? body.receipt.attemptId
      : typeof body.attemptId === "string"
        ? body.attemptId
        : "";
  const seat = await resolveSeat(attemptId);
  if (seat.outcome !== "resolved") {
    // A seat the work context cannot resolve is not refused here: the use
    // case validates the receipt against the seat the assessment recorded at
    // creation, which is the authoritative independence check.
    return body;
  }
  const receipt = isPlainObject(body.receipt) ? body.receipt : {};
  const supplied = typeof receipt.implementerModel === "string" ? receipt.implementerModel.trim() : "";
  if (supplied !== "" && supplied !== seat.model) {
    return {
      outcome: "rejected",
      reason: `implementerModel '${supplied}' is refused: attempt '${attemptId}' was dispatched on seat '${seat.model}'`,
    };
  }
  return {
    ...body,
    receipt: { ...receipt, implementerModel: seat.model },
  };
}

export default defineEventHandler(async (event) => {
  // `body.assessmentId` is forwarded untouched; the route parameter is the
  // receipt identity and is merged into `receipt.id`.
  const useCase = getEvidenceUseCases().recordReviewReceipt;
  const body = await readObjectBody(event);
  let bound: ReceiptRequestBody | { outcome: "rejected"; reason: string };
  try {
    bound = await bindReceiptImplementerSeat(body);
  } catch (error) {
    // An unconfigured work context resolves no seat for the same reason the
    // evidence use case is unconfigured, so the route reports that instead.
    if (isNotImplemented(error)) {
      return evidenceResponse(
        event,
        useCase,
        "RecordReviewReceipt",
        {
          ...body,
          receipt: isPlainObject(body.receipt)
            ? { ...body.receipt, id: getRouterParam(event, "id") ?? "" }
            : body.receipt,
        },
      );
    }
    throw error;
  }
  if ("outcome" in bound) {
    // A refusal is a typed domain outcome, exactly as the use case returns one.
    return { operationId: "RecordReviewReceipt", code: "OK", result: bound };
  }
  const receipt = isPlainObject(bound.receipt) ? bound.receipt : {};
  return evidenceResponse(event, useCase, "RecordReviewReceipt", {
    ...bound,
    receipt: { ...receipt, id: getRouterParam(event, "id") ?? "" },
  });
});
