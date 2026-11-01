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
  const briefPage = read(APP_DIR, "brief", "page.tsx");
  const frozenCard = read(
    APP_DIR,
    "brief",
    "components",
    "frozen-brief-card.tsx",
  );

  it("marks Brief and Knowledge as sample", () => {
    expect(entryText(viewNav, "/brief")).toContain("sample: true");
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

  it("labels the /brief freeze digest as sample", () => {
    expect(briefPage).not.toContain("`sha256:");
    expect(briefPage).toContain("sample:");
    expect(frozenCard).toContain("sample digest <b>{digest}</b>");
  });

  it("updates the rail footer", () => {
    expect(sidebar).not.toContain("Lanes reads the API when configured");
  });

  it("shows the open-question count in the rail", () => {
    expect(viewNav).toContain("sidebar-badge");
    expect(viewNav).toContain('" (none open)"');
    expect(viewNav).toContain("openQuestions");
  });
});
