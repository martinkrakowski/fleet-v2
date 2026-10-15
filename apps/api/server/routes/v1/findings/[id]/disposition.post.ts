// POST /v1/findings/:id/disposition — RecordFindingDisposition
import { getEvidenceUseCases } from "../../../../wiring/evidence/composition.js";
import { evidenceResponse } from "../../../../wiring/evidence/errors.js";
import { isPlainObject, readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  // `body.assessmentId` is forwarded untouched; the route parameter is the
  // finding identity and is merged into `disposition.findingId`.
  const body = await readObjectBody(event);
  return evidenceResponse(
    event,
    getEvidenceUseCases().recordFindingDisposition,
    "RecordFindingDisposition",
    {
      ...body,
      disposition: isPlainObject(body.disposition)
        ? { ...body.disposition, findingId: getRouterParam(event, "id") ?? "" }
        : body.disposition,
    },
  );
});
