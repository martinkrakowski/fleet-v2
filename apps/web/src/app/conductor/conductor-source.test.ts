/**
 * Source-text assertions for the Conductor view wiring, in the style of
 * `questions-source.test.ts`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONDUCTOR_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(CONDUCTOR_DIR, ...parts), "utf8");

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      entries.push(...walk(full));
    } else {
      entries.push(full);
    }
  }
  return entries;
}

const nonTestFiles = walk(CONDUCTOR_DIR).filter(
  (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
);

describe("Conductor source wiring", () => {
  const page = read("page.tsx");
  const live = read("live.ts");
  const client = read("conductor-client.tsx");
  const board = read("components", "schedule-board.tsx");
  const gauge = read("components", "cap-gauge.tsx");
  const strip = read("components", "session-strip.tsx");
  const css = read("conductor.module.css");

  it("keeps /conductor a dynamic server page", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).not.toContain('"use client"');
  });

  it("keeps the loader on the server", () => {
    expect(live).not.toContain('"use client"');
    expect(live).toContain("NOT_CONFIGURED_REASON");
    expect(live).toContain("NOT_IMPLEMENTED_STATUS");
  });

  it("keeps the read-only view free of actions and links", () => {
    const all = [page, live, client, board, gauge, strip].join("\n");
    expect(all).not.toContain("AlertBox");
    expect(all).not.toContain("onConfirm");
    expect(all).not.toContain("fetch(");
    expect(all).not.toContain("dangerouslySetInnerHTML");
    expect(all).not.toContain("href=");
  });

  it("wires the live route and auto-refresh in the client", () => {
    expect(client).toContain("GET /v1/runs");
    expect(client).toContain("useAutoRefresh");
    expect(client.match(/aria-live=/g)).toHaveLength(1);
  });

  it("never ships a fixture for the page", () => {
    expect(existsSync(join(CONDUCTOR_DIR, "fixture.ts"))).toBe(false);
    for (const file of nonTestFiles) {
      expect(file).toMatch(/conductor/);
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from\s+["'][^"']*fixture/);
    }
  });

  it("renders the strip as svg plus a details table fallback", () => {
    expect(strip).toContain("role=\"img\"");
    expect(strip).toContain("<details");
    expect(strip).toContain("<table");
  });

  it("keeps the responsive and reduced-motion media rules", () => {
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("never borrows the work board's Waiting column name", () => {
    for (const file of nonTestFiles) {
      expect(readFileSync(file, "utf8")).not.toMatch(/\bWaiting\b/);
    }
  });
});
