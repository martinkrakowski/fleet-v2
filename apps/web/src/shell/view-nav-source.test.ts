/**
 * Source-text assertions for the P12 sample labels, in the style of
 * `attempt-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_DIR = join(import.meta.dirname);
const APP_DIR = join(SHELL_DIR, "..", "app");

const read = (base: string, ...parts: string[]) =>
  readFileSync(join(base, ...parts), "utf8");

function entryText(nav: string, href: string): string {
  const start = nav.indexOf(`href: "${href}"`);
  return nav.slice(start, nav.indexOf("},", start));
}

describe("View nav P12 sample labels", () => {
  const viewNav = read(SHELL_DIR, "view-nav.tsx");
  const sidebar = read(SHELL_DIR, "sidebar.tsx");
  const briefView = read(APP_DIR, "brief", "brief-view.tsx");
  const briefMap = read(APP_DIR, "brief", "map-brief.ts");

  it("marks Knowledge as sample and Brief as not sample", () => {
    expect(entryText(viewNav, "/brief")).toContain("sample: false");
    expect(entryText(viewNav, "/knowledge")).toContain("sample: true");
  });

  it("leaves Lanes, Projects, Attempt and Questions unmarked", () => {
    for (const href of [
      "/lanes",
      "/projects",
      "/attempt",
      "/questions",
      "/conductor",
    ]) {
      expect(entryText(viewNav, href)).toContain("sample: false");
    }
  });

  it("carries the sample mark in the label and accessible name", () => {
    expect(viewNav).toContain("sidebar-link-sample");
    expect(viewNav).toContain('" (sample data)"');
  });

  it("never invents a /brief digest and renders not recorded when absent", () => {
    for (const source of [briefView, briefMap]) {
      expect(source).not.toContain("`sha256:");
      expect(source).not.toContain('"sha256:');
      expect(source).not.toContain("sample:");
    }
    expect(briefMap).toContain('"not recorded"');
    expect(briefView).toContain("formatBriefDigest(");
  });

  it("updates the rail footer", () => {
    expect(sidebar).not.toContain("Lanes reads the API when configured");
  });

  it("shows the open-question count in the rail", () => {
    expect(viewNav).toContain("sidebar-badge");
    expect(viewNav).toContain('" (none open)"');
    expect(viewNav).toContain("openQuestions");
  });

  it("places To-do directly above Questions and after Lanes", () => {
    const todoIndex = viewNav.indexOf('href: "/todo"');
    const questionsIndex = viewNav.indexOf('href: "/questions"');
    const lanesIndex = viewNav.indexOf('href: "/lanes"');
    expect(todoIndex).toBeGreaterThan(-1);
    expect(questionsIndex).toBeGreaterThan(todoIndex);
    expect(todoIndex).toBeGreaterThan(lanesIndex);
    // Directly above: no other rail entry sits between To-do and Questions (TD5a review minor).
    expect(viewNav.slice(todoIndex + 1, questionsIndex)).not.toContain('href: "');
  });

  it("leaves To-do unmarked as sample", () => {
    expect(entryText(viewNav, "/todo")).toContain("sample: false");
  });

  it("shows a to-do badge only when a count is supplied", () => {
    expect(viewNav).toContain("openTodos");
    expect(viewNav).toContain("sidebar-badge");
    expect(viewNav).toContain("openTodos !== null");
  });
});
