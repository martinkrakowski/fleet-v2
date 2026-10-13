import { getKnowledgeComposition } from "../../../../wiring/knowledge/composition";
import { mapUseCaseFailure } from "../../../../wiring/knowledge/errors";

export default defineEventHandler(async (event) => {
  try {
    await getKnowledgeComposition().publishAcceptedKeeper.execute({
      id: getRouterParam(event, "id"),
    });
  } catch (error) {
    const failure = mapUseCaseFailure(error);
    setResponseStatus(event, failure.status);
    return failure.body;
  }
});
