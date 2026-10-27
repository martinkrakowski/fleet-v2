/**
 * Source-text assertions for the Questions view wiring, in the style of
 * `attempt-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const QUESTIONS_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(QUESTIONS_DIR, ...parts), "utf8");

describe("Questions source wiring", () => {
  const page = read("page.tsx");
  const live = read("live.ts");
  const client = read("questions-client.tsx");
  const card = read("components", "question-card.tsx");
  const map = read("map-question.ts");

  it("keeps /questions a dynamic server page", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("loadQuestions()");
    expect(page).not.toContain('"use client"');
  });

  it("keeps the loader on the server without auto-refresh", () => {
    expect(live).not.toContain('"use client"');
    expect(live).not.toContain("use-auto-refresh");
    expect(live).toContain('from "../attempt/live"');
    expect(live).toContain("NOT_CONFIGURED_REASON");
  });

  it("imports only types from the server loader and the parser in the client", () => {
    expect(client.startsWith('"use client"')).toBe(true);
    expect(client).not.toMatch(
      /^import\s+(?!type)[^;]*from\s+"\.\/live"/m,
    );
    expect(client).not.toMatch(
      /^import\s+(?!type)[^;]*from\s+"\.\/map-question"/m,
    );
  });

  it("keeps one live region across the client and the card", () => {
    const all = [client, card].join("\n");
    expect(all.match(/aria-live=/g)).toHaveLength(1);
  });

  it("renders question text as plain text only", () => {
    expect(card).toContain("<pre");
    expect(card).toContain("<time");
    expect(card).toContain("One-way door");
    const all = [client, card].join("\n");
    expect(all).not.toContain("dangerouslySetInnerHTML");
    expect(all).not.toContain("AlertBox");
    expect(all).not.toContain("onConfirm");
    expect(all).not.toContain("fetch(");
    expect(all).not.toContain("<a ");
    expect(all).not.toContain("href=");
    expect(all).not.toContain("target=");
    expect(all).not.toContain("data-contained-scroll");
  });

  it("never carries a sessionId and never sorts input in the parser", () => {
    expect(map).not.toContain("sessionId:");
    expect(map).not.toContain(".sort(");
  });
});
