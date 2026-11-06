/**
 * Source-text assertions for the To-do page wiring, in the style of
 * `questions-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TODO_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(TODO_DIR, ...parts), "utf8");

const PRODUCTION_FILES = [
  "todo-wire.ts",
  "todo-model.ts",
  "todo-view.tsx",
  "live.ts",
  "page.tsx",
  "todo.module.css",
];

describe("To-do source wiring", () => {
  const page = read("page.tsx");
  const live = read("live.ts");
  const view = read("todo-view.tsx");
  const model = read("todo-model.ts");
  const fixture = read("fixture.ts");

  it("keeps /todo a dynamic server page", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("loadTodoData()");
    expect(page).not.toContain('"use client"');
  });

  it("keeps the loader on the server and returns the not-configured view", () => {
    expect(live).not.toContain('"use client"');
    expect(live).not.toContain("fetch(");
    expect(live).toContain('view: "not-configured"');
    expect(live).toContain("GET /v1/todo is not served yet");
  });

  it("renders the four states, the group titles and the route text", () => {
    expect(view).toContain("No owner to-dos are recorded on this station.");
    expect(view).toMatch(
      /GET \/v1\/todo is not served yet, so no to-do list was read\. There is\s+no sample to-do list\./,
    );
    expect(view).toContain("error · not read");
    expect(view).toContain("not configured · not read");
    expect(view).toContain("GET /v1/todo");
    expect(model).toContain("Blocking lanes");
    expect(model).toContain("Yours to do");
    expect(model).toContain("Clears on its own");
  });

  it("keeps the production files free of mutating and unsafe surfaces", () => {
    const forbidden = [
      "dangerouslySetInnerHTML",
      "AlertBox",
      "onConfirm",
      "fetch(",
      "<form",
      "POST",
      "PATCH",
      "data-contained-scroll",
    ];
    for (const file of PRODUCTION_FILES) {
      const source = read(file);
      for (const token of forbidden) {
        expect(source, `${file} must not contain ${token}`).not.toContain(
          token,
        );
      }
    }
  });

  it("never imports the fixture from production files", () => {
    for (const file of PRODUCTION_FILES) {
      expect(read(file)).not.toMatch(/from\s+["'][^"']*fixture/);
    }
  });

  it("cites the plan section 3.2 in the fixture and marks it test-only", () => {
    expect(fixture).toContain(
      "docs/planning/2026-10-28_owner-todo-section-plan.md",
    );
    expect(fixture).toContain("3.2");
    expect(fixture).toContain("test input only");
    expect(fixture).toContain("never shipped data");
  });

  it("never imports a domain package in the todo app", () => {
    const files = [...PRODUCTION_FILES, "fixture.ts"];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/from\s+["']@fleet\/work-execution/);
      expect(source).not.toMatch(/from\s+["']@fleet\/(?!ui)/);
    }
  });
});
