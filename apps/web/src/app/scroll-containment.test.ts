/**
 * Desktop scroll-containment contracts for the lanes, attempt and brief views.
 *
 * The orchestrator verifies the rendered layout in a browser; these tests pin
 * the containment classes and rules each view must keep: on desktop the shell
 * never scrolls and each named panel scrolls internally, while below each
 * view's breakpoint the page scrolls normally again.
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

describe("shell containment", () => {
  const css = read("globals.css");

  it("hides overflow on .page-wrapper on desktop and scrolls it below 992px", () => {
    expect(hasRule(mediaBlock(css, "(min-width: 992px)"), ".page-wrapper", "overflow: hidden")).toBe(true);
    expect(hasRule(mediaBlock(css, "(max-width: 991.98px)"), ".page-wrapper", "overflow-y: auto")).toBe(true);
  });

  it("keeps .main a full-height flex column with a non-scrolling page-wrapper", () => {
    expect(css).toMatch(/\.main\s*\{[^}]*height:\s*100vh/);
    expect(css).toMatch(/\.page-wrapper\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/);
  });
});

describe("lanes containment", () => {
  const css = read("lanes", "lanes.module.css");
  const desktop = mediaBlock(css, "(min-width: 992px)");

  it("scrolls the lane board body and the rail internally on desktop", () => {
    expect(hasRule(desktop, ".laneScroll", "overflow-y: auto")).toBe(true);
    expect(hasRule(desktop, ".laneScroll", "min-height: 0")).toBe(true);
    expect(hasRule(desktop, ".rail", "overflow-y: auto")).toBe(true);
    expect(hasRule(desktop, ".rail", "min-height: 0")).toBe(true);
    expect(hasRule(desktop, ".board", "min-height: 0")).toBe(true);
  });

  it("keeps the mobile layout free of inner scroll containers", () => {
    const cssText = css;
    expect(cssText).not.toMatch(/max-width:\s*991\.98px[\s\S]*overflow-y:\s*auto/);
  });

  it("wires the scroll class onto the lane board body", () => {
    expect(read("lanes", "page.tsx")).toMatch(/CardBody className=\{styles\.laneScroll\}/);
  });
});

describe("attempt containment", () => {
  const css = read("attempt", "attempt.module.css");
  const desktop = mediaBlock(css, "(min-width: 992px)");

  it("scrolls the sidebar column and the record column internally on desktop", () => {
    expect(hasRule(desktop, ".sidebarCol", "overflow-y: auto")).toBe(true);
    expect(hasRule(desktop, ".recordCol", "overflow-y: auto")).toBe(true);
    expect(hasRule(desktop, ".layout", "min-height: 0")).toBe(true);
    expect(hasRule(desktop, ".layout", "grid-template-rows: minmax(0, 1fr)")).toBe(true);
  });

  it("leaves the layout stacked without inner scrolling below 992px", () => {
    const mobile = mediaBlock(css, "(max-width: 991.98px)");
    expect(mobile).not.toMatch(/overflow/);
  });
});

describe("brief containment", () => {
  const css = read("brief", "brief.module.css");
  const desktop = mediaBlock(css, "(min-width: 72rem)");

  it("keeps the header fixed and scrolls both columns internally", () => {
    expect(hasRule(desktop, ".view", "overflow: hidden")).toBe(true);
    expect(hasRule(desktop, ".woScroll", "overflow-y: auto")).toBe(true);
    expect(hasRule(desktop, ".detail", "overflow-y: auto")).toBe(true);
    expect(hasRule(desktop, ".grid", "min-height: 0")).toBe(true);
  });

  it("scrolls the whole grid between the shell and view breakpoints", () => {
    const band = mediaBlock(css, "(min-width: 992px) and (max-width: 71.99rem)");
    expect(hasRule(band, ".view", "overflow: hidden")).toBe(true);
    expect(hasRule(band, ".grid", "overflow-y: auto")).toBe(true);
  });

  it("leaves no desktop containment in the base (unscoped) rules", () => {
    const base = css.replace(/@media[^{]+\{[\s\S]*?\n\}/g, "");
    expect(base).not.toMatch(/overflow:\s*hidden/);
    expect(base).not.toMatch(/overflow-y:\s*auto/);
  });

  it("wires the containment classes into the view", () => {
    const page = read("brief", "page.tsx");
    const card = read("brief", "components", "work-order-list-card.tsx");
    expect(page).toMatch(/styles\.view/);
    expect(page).toMatch(/styles\.detail/);
    expect(card).toMatch(/className=\{styles\.woCard\}/);
    expect(card).toMatch(/CardBody className=\{styles\.woScroll\}/);
  });
});
