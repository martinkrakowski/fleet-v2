import { getKnowledgeComposition } from "../../../../wiring/knowledge/composition";
import { knowledgeResponse } from "../../../../wiring/knowledge/errors";
import { readObjectBody, routeParam } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) => {
  const olderEntryId = routeParam(event, "id");
  return knowledgeResponse(event, getKnowledgeComposition().supersedeKnowledgeEntry, {
    ...(await readObjectBody(event)),
    olderEntryId,
  });
});
