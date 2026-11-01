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

/**
 * Rough per-function cognitive complexity counter, used as a regression guard
 * for the brief's cap: every function stays at Sonar cognitive complexity 15
 * or below. Strips comments and string literals, slices each top-level
 * `function` body up to the next top-level declaration, then counts the
 * branching tokens Sonar charges (if, loops, case, catch, ternaries and each
 * logical operator sequence).
 */
function complexityByFunction(source: string): Record<string, number> {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, "` `")
    .replace(/"(?:\\.|[^"\\])*"/g, '" "')
    .replace(/'(?:\\.|[^'\\])*'/g, "' '");
  const scores: Record<string, number> = {};
  const starts = [...stripped.matchAll(/(^|\n)(?:export )?function ([A-Za-z0-9_$]+)/g)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index][1] === "\n" ? starts[index].index + 1 : starts[index].index;
    const name = starts[index][2];
    const next =
      index + 1 < starts.length
        ? (starts[index + 1][1] === "\n" ? starts[index + 1].index + 1 : starts[index + 1].index)
        : stripped.length;
    const body = stripped.slice(start, next);
    const tokens = body.match(
      /\b(if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?![.(\d])/g,
    );
    scores[name] = tokens === null ? 0 : tokens.length;
  }
  return scores;
}

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

  it("keeps truncation on the session strip only, never on the schedule", () => {
    expect(board).not.toContain("truncated");
    expect(board).toContain("Live runs in creation order");
    expect(client).not.toContain("list truncated");
    expect(client).toContain("truncated={schedule.truncated}");
    expect(strip).toContain("truncated");
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

  it("spans the expanded detail across the six table columns", () => {
    expect(board).toContain("colSpan={6}");
  });

  it("stacks the board rows as block-level boxes under 720px", () => {
    const start = css.indexOf("@media (max-width: 720px)");
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let end = start;
    for (let i = start; i < css.length; i += 1) {
      if (css[i] === "{") {
        depth += 1;
      }
      if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const media = css.slice(start, end);
    expect(media).toContain(".boardWrap table tr");
    expect(media).toContain(".boardWrap table td");
    expect(media).toContain(".boardWrap table th");
    expect(media.match(/display: block;/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the session strip scrollable rather than scaled", () => {
    expect(strip).toContain("minWidth");
  });

  it("keeps every schedule mapping function simple", () => {
    const source = read("map-schedule.ts");
    const scores = complexityByFunction(source);
    expect(Object.keys(scores).length).toBeGreaterThan(5);
    for (const [name, score] of Object.entries(scores)) {
      expect(
        score,
        `${name} has cognitive complexity ${score}, cap is 15`,
      ).toBeLessThanOrEqual(15);
    }
  });

  it("never borrows the work board's Waiting column name", () => {
    for (const file of nonTestFiles) {
      expect(readFileSync(file, "utf8")).not.toMatch(/\bWaiting\b/);
    }
  });
});
