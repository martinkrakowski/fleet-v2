import { getKnowledgeComposition } from "../../../../wiring/knowledge/composition";
import { knowledgeResponse } from "../../../../wiring/knowledge/errors";
import { readObjectBody } from "../../../../wiring/http-input";

export default defineEventHandler(async (event) =>
  knowledgeResponse(event, getKnowledgeComposition().recordKnowledgeReuse, {
    ...(await readObjectBody(event)),
    entryId: getRouterParam(event, "id") ?? "",
  }),
);
