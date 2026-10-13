import { getKnowledgeComposition } from "../../../../wiring/knowledge/composition";
import { knowledgeResponse } from "../../../../wiring/knowledge/errors";

export default defineEventHandler((event) =>
  knowledgeResponse(event, getKnowledgeComposition().supersedeKnowledgeEntry, {
    id: getRouterParam(event, "id"),
  }),
);
