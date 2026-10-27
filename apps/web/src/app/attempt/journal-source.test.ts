/**
 * Source-text assertions for the live attempt journal panel, in the style of
 * `attempt-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ATTEMPT_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(ATTEMPT_DIR, ...parts), "utf8");

describe("Attempt journal source wiring", () => {
  const panel = read("components", "live-journal-panel.tsx");
  const map = read("map-journal.ts");
  const client = read("attempt-client.tsx");
  const context = read("live-context.ts");
  const record = read("components", "live-attempt-record.tsx");
  const operations = read("components", "live-operations-card.tsx");
  const workOrder = read("components", "live-work-order-card.tsx");

  it("renders journal detail as plain text only", () => {
    expect(panel).toContain("<pre");
    expect(panel).toContain("<time");
    expect(panel).toContain('aria-label="Journal entries in recorded order"');
    expect(panel).not.toContain("dangerouslySetInnerHTML");
    expect(panel).not.toContain(".sort(");
    expect(panel).not.toContain("aria-live");
    expect(panel).not.toContain("AlertBox");
    expect(panel).not.toContain("onConfirm");
    expect(panel).not.toContain("fetch(");
    expect(panel).not.toContain("md(");
  });

  it("never re-sorts journal entries", () => {
    expect(map).not.toContain(".sort(");
  });

  it("imports the server loader types only", () => {
    expect(client).toContain(
      'import type { AttemptContext } from "./live-context";',
    );
    expect(client).not.toMatch(
      /^import\s+(?!type)[^;]*from\s+"\.\/live-context"/m,
    );
  });

  it("keeps one live region across the attempt page components", () => {
    const all = [client, record, operations, workOrder, panel].join("\n");
    expect(all.match(/aria-live=/g)).toHaveLength(1);
  });

  it("keeps the journal read on the server", () => {
    expect(context).toContain("Promise.all(");
    expect(context).not.toContain('"use client"');
  });
});
