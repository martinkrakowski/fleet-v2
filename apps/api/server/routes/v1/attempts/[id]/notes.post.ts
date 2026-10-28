import { getKnowledgeComposition } from "../../../../wiring/knowledge/composition";
import { knowledgeResponse } from "../../../../wiring/knowledge/errors";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const attemptId = routeParam(event, "id");
  return knowledgeResponse(event, getKnowledgeComposition().captureCompletedAttemptNotes, {
    ...(await readObjectBody(event)),
    attemptId,
  });
});
