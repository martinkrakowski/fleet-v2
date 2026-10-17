// POST /v1/verifications — RequestVerification
import { getEvidenceUseCases } from "../../../wiring/evidence/composition.js";
import { evidenceResponse, isNotImplemented } from "../../../wiring/evidence/errors.js";
import { readObjectBody } from "../../../wiring/http-input";
import { workComposition } from "../../../wiring/work/composition.js";
import { resolveInstallationHostForRole } from "@fleet/work-execution";

type VerificationRequestBody = Record<string, unknown>;

/**
 * Bind the request's implementer seat to the attempt's recorded seat. The
 * assessment records the implementer at creation, so the caller never
 * supplies it: an attempt with no recorded seat is refused instead of being
 * compared against an assumed model.
 */
async function bindImplementerSeat(
  body: VerificationRequestBody,
): Promise<VerificationRequestBody | { outcome: "rejected"; reason: string }> {
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
  return { ...body, implementerModel: seat.model };
}

export default defineEventHandler(async (event) => {
  const useCase = getEvidenceUseCases().requestVerification;
  let body = await readObjectBody(event);
  // A v2 installation names the verifier host itself (plan section 8); the
  // caller never supplies one. The host comes from the installation's hosts
  // entry — the verifier host's name.
  const installation = workComposition().installation;
  if (installation?.schemaVersion === 2) {
    if (body.hostId !== undefined) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "hostId is not accepted for a v2 installation; the host comes from the installation's hosts entry (the verifier host's name)",
      });
    }
    const verifierHostId = resolveInstallationHostForRole(
      installation,
      "verifier",
    );
    if (verifierHostId === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "the installation declares no verifier host; add one to the installation's hosts entry before requesting verification",
      });
    }
    body = { ...body, hostId: verifierHostId };
  }
  let bound: VerificationRequestBody | { outcome: "rejected"; reason: string };
  try {
    bound = await bindImplementerSeat(body);
  } catch (error) {
    // An unconfigured work context resolves no seat for the same reason the
    // evidence use case is unconfigured, so the route reports that instead.
    if (isNotImplemented(error)) {
      return evidenceResponse(event, useCase, "RequestVerification", body);
    }
    throw error;
  }
  if ("outcome" in bound) {
    // A refusal is a typed domain outcome, exactly as the use case returns one.
    return { operationId: "RequestVerification", code: "OK", result: bound };
  }
  return evidenceResponse(event, useCase, "RequestVerification", bound);
});
