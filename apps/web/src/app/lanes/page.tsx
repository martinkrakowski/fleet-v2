import { loadLanesData } from "./live";
import { LanesClient } from "./lanes-client";
import { loadQuestionSummary } from "../questions/summary";

export const dynamic = "force-dynamic";

export default async function LanesPage() {
  const [data, questions] = await Promise.all([
    loadLanesData(),
    loadQuestionSummary(),
  ]);
  return <LanesClient data={data} questions={questions} />;
}
