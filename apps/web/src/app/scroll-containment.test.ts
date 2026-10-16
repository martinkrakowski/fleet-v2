/**
 * Scroll-containment contracts for the shell and the lanes, attempt and brief
 * views.
 *
 * Containment is opt-in: `.page-wrapper` scrolls by default everywhere, and
 * only a view whose root element carries `data-contained-scroll` pins the
 * shell on desktop (`overflow: hidden` via `:has()`). The orchestrator
 * verifies the rendered layout in a browser; these tests pin the opt-in
 * attribute on each route's root, the `:has()` rule in globals.css, and the
 * keyboard-accessible scroll regions each view must keep. @testing-library is
 * not installed in apps/web, so the JSX assertions read the component sources.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(APP_DIR, ...parts), "utf8");

/** Contents of every `@media (condition) { ... }` block closed at column 0. */
function mediaBlock(css: string, condition: string): string {
  const escaped = condition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@media ${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "g");
  const blocks = [...css.matchAll(re)].map((m) => m[1]);
  expect(
    blocks.length,
    `expected a @media ${condition} block`,
  ).toBeGreaterThan(0);
  return blocks.join("\n");
}

function hasRule(block: string, selector: string, body: string): boolean {
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `${esc(selector)}[^{}]*?\\{[^}]*?${esc(body).replace(/\s+/g, "\\s*")}[^}]*?\\}`,
  );
  return re.test(block);
}

/** First JSX opening tag matching `pattern` (or a failing empty string). */
function openingTag(source: string, pattern: RegExp, what: string): string {
  const tag = source.match(pattern)?.[0];
  expect(tag, `expected the ${what} element in the component source`).toBeTruthy();
  return tag ?? "";
}

/**
 * Every scroll body must be a keyboard-reachable named region so keyboard
 * users can reach and scroll each internally scrolling panel.
 */
function expectScrollRegion(tag: string, label: string): void {
  expect(tag).toContain("tabIndex={0}");
  expect(tag).toContain('role="region"');
  expect(tag).toContain(`aria-label="${label}"`);
}

describe("shell containment", () => {
  const css = read("globals.css");

  it("keeps .page-wrapper scrolling by default on every viewport", () => {
    expect(css).toMatch(
      /\.page-wrapper\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/,
    );
    expect(hasRule(mediaBlock(css, "(max-width: 991.98px)"), ".page-wrapper", "overflow-y: auto")).toBe(true);
  });

  it("contains overflow on desktop only for views that opt in", () => {
    expect(css).toContain(".page-wrapper:has([data-contained-scroll])");
    expect(
      hasRule(
        mediaBlock(css, "(min-width: 992px)"),
        ".page-wrapper:has([data-contained-scroll])",
        "overflow: hidden",
      ),
    ).toBe(true);
  });
});

describe("opt-in containment roots of the five routes", () => {
  it("/ renders no root element — it redirects to /lanes", () => {
    const home = read("page.tsx");
    expect(home).toMatch(/redirect\("\/lanes"\)/);
    expect(home).not.toContain("data-contained-scroll");
  });

  it("/knowledge does not opt in — the page scrolls normally", () => {
    const knowledge = read("knowledge", "page.tsx");
    expect(knowledge).toContain("<div className={styles.page}>");
    expect(knowledge).not.toContain("data-contained-scroll");
  });

  it("/lanes opts in on its root element", () => {
    const lanes = read("lanes", "page.tsx");
    expect(lanes).toContain(
      "<div className={styles.page} data-contained-scroll>",
    );
  });

  it("/attempt opts in on its root element", () => {
    const attempt = read("attempt", "attempt-client.tsx");
    expect(attempt).toContain(
      "<div className={styles.layout} data-contained-scroll>",
    );
  });

  it("/brief opts in on its root element", () => {
    const brief = read("brief", "page.tsx");
    expect(
      brief.match(
        /<div\s*\n\s*className=\{\[styles\.stack, styles\.view\][\s\S]*?data-contained-scroll\s*\n\s*>/,
      ),
    ).toBeTruthy();
  });
});

describe("keyboard-accessible scroll regions", () => {
  it("names the lanes board scroll and the rail", () => {
    const lanes = read("lanes", "page.tsx");
    expectScrollRegion(
      openingTag(lanes, /<CardBody[^>]*styles\.laneScroll[^>]*>/, "lanes board scroll body"),
      "Lanes",
    );
    expectScrollRegion(
      openingTag(lanes, /<div[^>]*styles\.rail[^>]*>/, "lanes rail"),
      "Attention",
    );
  });

  it("names the attempt sidebar column and record column", () => {
    const attempt = read("attempt", "attempt-client.tsx");
    expectScrollRegion(
      openingTag(attempt, /<div[^>]*styles\.sidebarCol[^>]*>/, "attempt sidebar column"),
      "Work order and operations",
    );
    expectScrollRegion(
      openingTag(attempt, /<section[^>]*styles\.recordCol[^>]*>/, "attempt record column"),
      "Attempt record",
    );
  });

  it("names the brief work-order list and detail column", () => {
    const card = read("brief", "components", "work-order-list-card.tsx");
    expectScrollRegion(
      openingTag(card, /<CardBody[^>]*styles\.woScroll[^>]*>/, "brief work-order scroll body"),
      "Work orders",
    );
    const brief = read("brief", "page.tsx");
    expectScrollRegion(
      openingTag(brief, /<div[^>]*styles\.detail[^>]*>/, "brief detail column"),
      "Brief detail",
    );
  });
});
