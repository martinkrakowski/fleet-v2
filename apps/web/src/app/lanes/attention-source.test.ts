/**
 * Source-text assertions for the Lanes attention card wiring, in the style of
 * `questions-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LANES_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(LANES_DIR, ...parts), "utf8");

describe("Lanes attention card source wiring", () => {
  const card = read("components", "attention-card.tsx");
  const client = read("lanes-client.tsx");
  const page = read("page.tsx");
  const layout = read("..", "layout.tsx");
  const summary = read("..", "questions", "summary.ts");

  it("keeps the card free of external links and the fixture inbox", () => {
    expect(card).not.toContain("wavesInboxUrl");
    expect(card).not.toContain("target=");
    expect(card).not.toContain("<a ");
    expect(card).not.toContain("http");
    expect(card).toContain('href="/questions?state=open"');
    expect(card).toContain('href="/questions"');
    expect(card).toMatch(
      /import\s+type\s+\{[^}]*QuestionSummary[^}]*\}\s+from\s+"\.\.\/\.\.\/questions\/summary"/,
    );
  });

  it("imports the questions summary as a type only in the lanes client", () => {
    expect(client).toMatch(
      /import\s+type\s+\{[^}]*QuestionSummary[^}]*\}\s+from\s+"\.\.\/questions\/summary"/,
    );
  });

  it("keeps /lanes a dynamic server page that reads the summary beside the lanes", () => {
    expect(page).toContain("Promise.all(");
    expect(page).toContain("loadQuestionSummary()");
    expect(page).not.toContain('"use client"');
  });

  it("keeps the layout and the summary server-side without auto-refresh", () => {
    expect(layout).toContain("loadQuestionSummary()");
    expect(layout).toContain("Promise.all(");
    expect(summary).not.toContain('"use client"');
    expect(summary).not.toContain("use-auto-refresh");
  });
});
