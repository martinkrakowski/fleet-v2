// POST /v1/reviews — RequestIndependentReview
import { getEvidenceUseCases } from "../../../wiring/evidence/composition.js";
import { evidenceResponse, isNotImplemented } from "../../../wiring/evidence/errors.js";
import { readObjectBody } from "../../../wiring/http-input";
import { workComposition } from "../../../wiring/work/composition.js";

type ReviewRequestBody = Record<string, unknown>;

/**
 * Bind the request's implementer seat to the attempt's recorded seat.
 * Independence is a fact about the lane, so the caller never supplies it: a
 * supplied `implementerModel` may only restate the recorded seat, and an
 * attempt with no recorded seat is refused instead of being compared against
 * an assumed model.
 */
async function bindImplementerSeat(
  body: ReviewRequestBody,
): Promise<ReviewRequestBody | { outcome: "rejected"; reason: string }> {
  const resolveSeat = workComposition().resolveAttemptImplementerSeat;
  if (resolveSeat === undefined) {
    return {
      outcome: "rejected",
      reason: "No implementer seat resolver is bound; the implementer model cannot be established",
    };
  }
  const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
  const seat = await resolveSeat(attemptId);
  if (seat.outcome !== "resolved") {
    return { outcome: "rejected", reason: seat.reason };
  }
  const supplied = typeof body.implementerModel === "string" ? body.implementerModel.trim() : "";
  if (supplied !== "" && supplied !== seat.model) {
    return {
      outcome: "rejected",
      reason: `implementerModel '${supplied}' is refused: attempt '${attemptId}' was dispatched on seat '${seat.model}'`,
    };
  }
  return { ...body, implementerModel: seat.model };
}

export default defineEventHandler(async (event) => {
  const useCase = getEvidenceUseCases().requestIndependentReview;
  const body = await readObjectBody(event);
  let bound: ReviewRequestBody | { outcome: "rejected"; reason: string };
  try {
    bound = await bindImplementerSeat(body);
  } catch (error) {
    // An unconfigured work context resolves no seat for the same reason the
    // evidence use case is unconfigured, so the route reports that instead.
    if (isNotImplemented(error)) {
      return evidenceResponse(event, useCase, "RequestIndependentReview", body);
    }
    throw error;
  }
  if ("outcome" in bound) {
    // A refusal is a typed domain outcome, exactly as the use case returns one.
    return { operationId: "RequestIndependentReview", code: "OK", result: bound };
  }
  return evidenceResponse(event, useCase, "RequestIndependentReview", bound);
});
