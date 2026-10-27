import { loadQuestions } from "./live";
import { QuestionsClient } from "./questions-client";

export const dynamic = "force-dynamic";

export default async function QuestionsPage() {
  return <QuestionsClient data={await loadQuestions()} />;
}
