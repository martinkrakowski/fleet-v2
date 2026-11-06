/**
 * Server-side loader for the To-do page's live data layer.
 *
 * TD5a-w replaces this body with the API read (`apps/web/src/lib/api/todo.ts`)
 * once TD4 serves `GET /v1/todo`; until then the page shows the not-configured
 * state and never sample rows (TD-D11). This loader must not import the test
 * fixture and must not call `fetch`.
 */

import type { OwnerTodoList } from "./todo-wire";

export type TodoData =
  | { readonly view: "listed"; readonly list: OwnerTodoList }
  | { readonly view: "empty" }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "not-configured"; readonly reason: string };

export async function loadTodoData(): Promise<TodoData> {
  return { view: "not-configured", reason: "GET /v1/todo is not served yet" };
}
