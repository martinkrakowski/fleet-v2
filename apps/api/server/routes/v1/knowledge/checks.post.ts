import { getKnowledgeComposition } from "../../../wiring/knowledge/composition";
import { mapUseCaseFailure } from "../../../wiring/knowledge/errors";

export default defineEventHandler(async (event) => {
  try {
    await getKnowledgeComposition().checkKnowledgeClaim.execute(undefined);
  } catch (error) {
    const failure = mapUseCaseFailure(error);
    setResponseStatus(event, failure.status);
    return failure.body;
  }
});
