import { loadTodoData } from "./live";
import { TodoView } from "./todo-view";

export const dynamic = "force-dynamic";

export default async function TodoPage() {
  return <TodoView data={await loadTodoData()} />;
}
